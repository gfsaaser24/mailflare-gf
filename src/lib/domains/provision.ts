import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { newId } from "@/lib/ids";
import {
	createSendingSubdomain,
	deleteSendingSubdomain,
	disableEmailRouting,
	enableEmailRouting,
	findZoneByHostname,
	getEmailRoutingSettings,
	listSendingSubdomains,
} from "@/lib/cloudflare-api";
import type { CfEmailRoutingRule } from "@/lib/cloudflare-api.types";
import { ensureEmailRoutingCatchAllToWorker } from "@/lib/domains/catch-all-routing";
import {
	catchAllRoutesToWorker,
	getEmailRoutingCatchAllRule,
	restoreEmailRoutingCatchAllRule,
} from "@/lib/domains/cloudflare-cleanup";
import { getEmailWorkerName } from "@/lib/cloudflare-api-utils";
import { isZoneApex } from "@/lib/domains/utils";
import type { DomainProvisioningResult, DomainRow } from "@/lib/domains/types";

/** The ordered steps `provisionDomain` runs. Rollback walks them in reverse. */
export type DomainProvisionStep = "zone-lookup" | "routing" | "sending" | "rules" | "db";

/** Thrown by `provisionDomain` after every resource it created has been removed again. */
export class DomainProvisionError extends Error {
	readonly step: DomainProvisionStep;

	constructor(step: DomainProvisionStep, message: string, cause?: unknown) {
		super(message, { cause });
		this.name = "DomainProvisionError";
		this.step = step;
	}
}

export type ProvisionDomainOptions = {
	hostname: string;
	/** When given, a `domains` row is inserted/updated for this owner. */
	userId?: string;
	enableRouting?: boolean;
	enableSending?: boolean;
};

/** What the run actually created on Cloudflare (as opposed to found already there). */
export type DomainProvisionCreated = {
	routing: boolean;
	sendingSubdomain: boolean;
	catchAllRule: boolean;
};

export type ProvisionedDomain = DomainProvisioningResult & {
	/** `null` when no `userId` was given (nothing can be written without an owner). */
	domain: DomainRow | null;
	created: DomainProvisionCreated;
};

type Rollback = { step: DomainProvisionStep; undo: () => Promise<unknown> };

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

/**
 * Idempotent, all-or-nothing domain provisioning.
 *
 * zone lookup → enable Email Routing → sending subdomain → catch-all rule → DB row.
 * Existing Cloudflare resources are reused, never recreated. If any step throws,
 * everything this call created is deleted in reverse order before a
 * `DomainProvisionError` is rethrown, so a half-failed run leaves no live routing.
 */
export async function provisionDomain(
	env: CloudflareEnv,
	options: ProvisionDomainOptions,
): Promise<ProvisionedDomain> {
	const hostname = options.hostname.toLowerCase().trim();
	const wantRouting = options.enableRouting ?? true;
	const wantSending = options.enableSending ?? true;

	const created: DomainProvisionCreated = {
		routing: false,
		sendingSubdomain: false,
		catchAllRule: false,
	};
	const rollbacks: Rollback[] = [];

	async function rollback(): Promise<void> {
		for (const entry of [...rollbacks].reverse()) {
			try {
				await entry.undo();
			} catch (error) {
				console.warn(`provisionDomain rollback failed at ${entry.step}`, error);
			}
		}
	}

	async function fail(step: DomainProvisionStep, error: unknown): Promise<never> {
		await rollback();
		throw new DomainProvisionError(step, messageOf(error, `Domain provisioning failed at ${step}`), error);
	}

	// 1. Zone lookup — nothing to roll back yet.
	let zone: { id: string; name: string } | null;
	try {
		zone = await findZoneByHostname(env, hostname);
	} catch (error) {
		throw new DomainProvisionError("zone-lookup", messageOf(error, "Zone lookup failed"), error);
	}
	if (!zone) {
		throw new DomainProvisionError(
			"zone-lookup",
			`Zone not found for "${hostname}". The domain must use Cloudflare DNS on this account.`,
		);
	}
	const zoneId = zone.id;
	const apex = isZoneApex(hostname, zone.name);

	// 2. Email Routing (skip when already enabled).
	let routingEnabled = false;
	let routingStatus: string | undefined;
	if (wantRouting) {
		try {
			const settings = await getEmailRoutingSettings(env, zoneId);
			if (settings.enabled) {
				routingEnabled = true;
				routingStatus = settings.status;
			} else {
				const routing = await enableEmailRouting(env, zoneId, apex ? undefined : hostname);
				routingEnabled = routing.enabled ?? true;
				routingStatus = routing.status;
				created.routing = true;
				rollbacks.push({ step: "routing", undo: () => disableEmailRouting(env, zoneId) });
			}
		} catch (error) {
			return fail("routing", error);
		}
	}

	// 3. Sending subdomain (optional; reuse when it already exists).
	let sendingEnabled = false;
	let sendingSubdomainTag: string | null = null;
	if (wantSending && !apex) {
		try {
			const subdomains = await listSendingSubdomains(env, zoneId);
			const existing = subdomains.find((sub) => sub.name === hostname);
			if (existing) {
				sendingSubdomainTag = existing.tag;
				sendingEnabled = existing.enabled;
			} else {
				const sub = await createSendingSubdomain(env, zoneId, hostname);
				sendingSubdomainTag = sub.tag;
				sendingEnabled = sub.enabled;
				created.sendingSubdomain = true;
				const tag = sub.tag;
				rollbacks.push({ step: "sending", undo: () => deleteSendingSubdomain(env, zoneId, tag) });
			}
		} catch (error) {
			return fail("sending", error);
		}
	}

	// 4. Catch-all rule to the edge worker (reuse when it already points there).
	if (wantRouting) {
		try {
			let previous: CfEmailRoutingRule | null = null;
			try {
				previous = await getEmailRoutingCatchAllRule(env, zoneId);
			} catch (error) {
				console.warn("getEmailRoutingCatchAllRule", error);
			}
			if (!catchAllRoutesToWorker(previous, getEmailWorkerName(env))) {
				await ensureEmailRoutingCatchAllToWorker(env, zoneId);
				created.catchAllRule = true;
				const restoreTo = previous;
				rollbacks.push({
					step: "rules",
					undo: () => restoreEmailRoutingCatchAllRule(env, zoneId, restoreTo),
				});
			}
		} catch (error) {
			return fail("rules", error);
		}
	}

	// 5. DB row, in a transaction.
	let domain: DomainRow | null = null;
	if (options.userId) {
		const userId = options.userId;
		try {
			const db = getDb(env);
			domain = await db.transaction(async (tx) => {
				const [existing] = await tx
					.select()
					.from(domains)
					.where(eq(domains.hostname, hostname))
					.limit(1);
				if (existing && existing.userId !== userId) {
					throw new Error("Domain is already registered");
				}

				const mergedRouting = routingEnabled || (existing?.routingEnabled ?? false);
				const mergedSending = sendingEnabled || (existing?.sendingEnabled ?? false);
				const values = {
					userId,
					hostname,
					zoneId,
					status: (mergedRouting || mergedSending ? "active" : "pending") as "active" | "pending",
					routingStatus: routingStatus ?? existing?.routingStatus ?? null,
					sendingSubdomainTag: sendingSubdomainTag ?? existing?.sendingSubdomainTag ?? null,
					sendingEnabled: mergedSending,
					routingEnabled: mergedRouting,
				};

				if (existing) {
					await tx.update(domains).set(values).where(eq(domains.id, existing.id));
					const [updated] = await tx.select().from(domains).where(eq(domains.id, existing.id)).limit(1);
					return updated!;
				}

				const [inserted] = await tx
					.insert(domains)
					.values({ id: newId("dom"), ...values })
					.returning();
				return inserted!;
			});
		} catch (error) {
			return fail("db", error);
		}
	}

	return {
		hostname,
		zone,
		routingEnabled,
		sendingEnabled,
		sendingSubdomainTag,
		routingStatus,
		domain,
		created,
	};
}
