import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import {
	getEmailRoutingDns,
	getEmailRoutingSettings,
	getSendingSubdomainDns,
	listSendingSubdomains,
	type CfDnsRecord,
} from "@/lib/cloudflare-api";
import { getEmailWorkerName } from "@/lib/cloudflare-api-utils";
import {
	catchAllRoutesToWorker,
	getEmailRoutingCatchAllRule,
} from "@/lib/domains/cloudflare-cleanup";
import { describeMissingDns, dnsRecordsOk, summariseDns } from "@/lib/dns-status";
import type { DomainRow } from "@/lib/domains/types";

export type DomainStatus = "pending" | "active" | "error";

export type DomainReconcileResult = {
	domainId: string;
	hostname: string;
	status: DomainStatus;
	/** Every problem found, joined with "; "; null when the domain is healthy. */
	statusReason: string | null;
	dnsOk: boolean;
	lastCheckedAt: Date;
	/** Live Email Routing status string reported by Cloudflare, when known. */
	routingStatus: string | null;
	/** Whether anything actually changed on the row. */
	changed: boolean;
};

type ProvisionFlags = Pick<
	DomainRow,
	"zoneId" | "routingEnabled" | "sendingEnabled" | "sendingSubdomainTag"
>;

/** A row that was never provisioned has no Cloudflare state to compare against. */
function neverProvisioned(row: ProvisionFlags): boolean {
	if (!row.zoneId) return true;
	return !row.routingEnabled && !row.sendingEnabled && !row.sendingSubdomainTag;
}

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

type LiveState = {
	routingEnabled: boolean;
	routingStatus: string | null;
	catchAllToWorker: boolean;
	sendingSubdomainPresent: boolean;
	sendingSubdomainVerified: boolean;
	routingRecords: CfDnsRecord[];
	routingMissing: CfDnsRecord[];
	sendingRecords: CfDnsRecord[];
};

/** Everything reconcile needs from Cloudflare, fetched in parallel where possible. */
async function fetchLiveState(env: CloudflareEnv, row: DomainRow): Promise<LiveState> {
	const workerName = getEmailWorkerName(env);
	const wantsSending = Boolean(row.sendingSubdomainTag) || row.sendingEnabled;
	const [settings, catchAll, subdomains, routingDns] = await Promise.all([
		getEmailRoutingSettings(env, row.zoneId),
		getEmailRoutingCatchAllRule(env, row.zoneId).catch(() => null),
		wantsSending ? listSendingSubdomains(env, row.zoneId) : Promise.resolve([]),
		getEmailRoutingDns(env, row.zoneId),
	]);

	const subdomain = subdomains.find(
		(sub) => sub.name === row.hostname || sub.tag === row.sendingSubdomainTag,
	);

	let sendingRecords: CfDnsRecord[] = [];
	const tag = subdomain?.tag ?? row.sendingSubdomainTag;
	if (tag) {
		sendingRecords = await getSendingSubdomainDns(env, row.zoneId, tag);
	}

	return {
		routingEnabled: settings.enabled === true,
		routingStatus: settings.status ?? null,
		catchAllToWorker: catchAllRoutesToWorker(catchAll, workerName),
		sendingSubdomainPresent: Boolean(subdomain),
		sendingSubdomainVerified: subdomain?.enabled === true,
		routingRecords: routingDns.records,
		routingMissing: routingDns.missing,
		sendingRecords,
	};
}

/** Turns live Cloudflare state into active/error plus the reason for error. */
function evaluate(
	row: DomainRow,
	live: LiveState,
): { status: DomainStatus; statusReason: string | null; dnsOk: boolean } {
	const wantsSending = Boolean(row.sendingSubdomainTag) || row.sendingEnabled;
	const summary = summariseDns(live.routingRecords, live.routingMissing, live.sendingRecords);
	const dnsOk = dnsRecordsOk(summary, wantsSending);

	const reasons: string[] = [];
	if (!live.routingEnabled) {
		reasons.push("Email Routing is disabled on the Cloudflare zone");
	} else if (!live.catchAllToWorker) {
		reasons.push("The catch-all rule does not deliver to the mail worker");
	}
	reasons.push(...describeMissingDns(summary, wantsSending));
	if (wantsSending) {
		if (!live.sendingSubdomainPresent) {
			reasons.push("The Email Sending subdomain is missing on Cloudflare");
		} else if (!live.sendingSubdomainVerified) {
			reasons.push("The Email Sending subdomain is not verified yet");
		}
	}

	if (reasons.length > 0) {
		return { status: "error", statusReason: reasons.join("; "), dnsOk };
	}
	return { status: "active", statusReason: null, dnsOk };
}

/**
 * Compares one domain row to live Cloudflare state and writes the result back.
 *
 * pending - never provisioned, so there is nothing to check yet.
 * active  - Email Routing is on, the catch-all reaches the worker and every
 *           required DNS record is published.
 * error   - anything else; status_reason says what is wrong.
 *
 * last_checked_at and dns_ok are always refreshed, including on failure, so a
 * stale row stays distinguishable from a healthy one.
 */
export async function reconcileDomain(
	env: CloudflareEnv,
	domainId: string,
): Promise<DomainReconcileResult> {
	const db = getDb(env);
	const [row] = await db.select().from(domains).where(eq(domains.id, domainId)).limit(1);
	if (!row) throw new Error("Domain not found");

	const lastCheckedAt = new Date();
	let status: DomainStatus;
	let statusReason: string | null;
	let dnsOk: boolean;
	let routingStatus: string | null = row.routingStatus ?? null;

	if (neverProvisioned(row)) {
		status = "pending";
		statusReason = null;
		dnsOk = false;
	} else {
		try {
			const live = await fetchLiveState(env, row);
			routingStatus = live.routingStatus ?? routingStatus;
			({ status, statusReason, dnsOk } = evaluate(row, live));
		} catch (error) {
			status = "error";
			statusReason = messageOf(error, "Failed to read Cloudflare state");
			dnsOk = false;
		}
	}

	const changed =
		row.status !== status ||
		(row.statusReason ?? null) !== statusReason ||
		row.dnsOk !== dnsOk ||
		(row.routingStatus ?? null) !== routingStatus;

	await db
		.update(domains)
		.set({ status, statusReason, dnsOk, routingStatus, lastCheckedAt })
		.where(eq(domains.id, row.id));

	return {
		domainId: row.id,
		hostname: row.hostname,
		status,
		statusReason,
		dnsOk,
		lastCheckedAt,
		routingStatus,
		changed,
	};
}

export type ReconcileAllResult = {
	results: DomainReconcileResult[];
	failures: { domainId: string; error: string }[];
};

/**
 * Reconciles every domain row. Used by scripts/reconcile-domains.ts.
 *
 * Domains are processed one at a time so a large install cannot burst through
 * the Cloudflare rate limit. One failing domain never stops the others.
 */
export async function reconcileAllDomains(env: CloudflareEnv): Promise<ReconcileAllResult> {
	const db = getDb(env);
	const rows = await db.select({ id: domains.id }).from(domains);

	const results: DomainReconcileResult[] = [];
	const failures: { domainId: string; error: string }[] = [];
	for (const row of rows) {
		try {
			results.push(await reconcileDomain(env, row.id));
		} catch (error) {
			failures.push({ domainId: row.id, error: messageOf(error, "Reconcile failed") });
		}
	}
	return { results, failures };
}
