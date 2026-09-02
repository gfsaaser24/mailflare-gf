import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import {
	disableEmailRouting,
	getEmailRoutingDns,
	getEmailRoutingSettings,
	getSendingSubdomainDns,
	deleteSendingSubdomain,
	type CfDnsRecord,
} from "@/lib/cloudflare-api";
import { deleteEmailRoutingRulesForDomain } from "@/lib/domains/cloudflare-cleanup";
import { provisionDomain } from "@/lib/domains/provision";
import type { DomainRow } from "@/lib/domains/types";

/**
 * Every function here takes the caller's organisation (`ctx.orgId` from
 * `withOrg()`) and both filters and stamps on it: a domain that belongs to
 * another organisation is invisible, never merely unauthorised.
 */

export type DomainDnsView = {
	routing: { records: CfDnsRecord[]; missing: CfDnsRecord[]; status?: string };
	sending: CfDnsRecord[];
};

export async function listUserDomains(env: CloudflareEnv, orgId: string, userId: string) {
	const db = getDb(env);
	return db
		.select()
		.from(domains)
		.where(and(eq(domains.organizationId, orgId), eq(domains.userId, userId)));
}

export async function addDomainForUser(
	env: CloudflareEnv,
	orgId: string,
	userId: string,
	hostname: string,
	options?: { enableRouting?: boolean; enableSending?: boolean },
): Promise<{ domain: DomainRow; dns: DomainDnsView }> {
	const { domain } = await provisionDomain(env, {
		hostname,
		organizationId: orgId,
		userId,
		enableRouting: options?.enableRouting,
		enableSending: options?.enableSending,
	});
	// `userId` was given, so a row is always returned.
	const row = domain!;

	await syncAliasMailboxRouting(env, orgId, userId);

	const dns = await getDomainDns(env, row);
	return { domain: row, dns };
}

/**
 * First-run helper: the domain may already have been provisioned by
 * `POST /api/setup/domain` before any user existed. Attach that row to the new
 * admin instead of provisioning the same hostname a second time.
 */
export async function attachOrProvisionDomainForUser(
	env: CloudflareEnv,
	orgId: string,
	userId: string,
	hostname: string,
	options?: { enableRouting?: boolean; enableSending?: boolean },
): Promise<DomainRow> {
	const normalized = hostname.toLowerCase().trim();
	const db = getDb(env);
	const [existing] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.organizationId, orgId), eq(domains.hostname, normalized)))
		.limit(1);

	if (existing) {
		if (existing.userId !== userId) {
			await db
				.update(domains)
				.set({ userId })
				.where(and(eq(domains.organizationId, orgId), eq(domains.id, existing.id)));
		}
		await syncAliasMailboxRouting(env, orgId, userId);
		const [row] = await db
			.select()
			.from(domains)
			.where(and(eq(domains.organizationId, orgId), eq(domains.id, existing.id)))
			.limit(1);
		return row!;
	}

	const { domain } = await addDomainForUser(env, orgId, userId, normalized, options);
	return domain;
}

/** Re-points every "all domains" alias mailbox of this user at current routing. */
async function syncAliasMailboxRouting(
	env: CloudflareEnv,
	orgId: string,
	userId: string,
): Promise<void> {
	const db = getDb(env);
	const aliasMailboxes = await db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart, useAllDomains: mailboxes.useAllDomains })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(
			and(
				eq(mailboxes.organizationId, orgId),
				eq(domains.organizationId, orgId),
				eq(domains.userId, userId),
				eq(mailboxes.useAllDomains, true),
			),
		);
	const routingResults = await Promise.allSettled(
		aliasMailboxes.map((mailbox) => ensureMailboxDomainRouting(env, db, mailbox)),
	);
	for (const result of routingResults) {
		if (result.status === "rejected") console.warn("ensureMailboxDomainRouting", result.reason);
	}
}

export async function getDomainDns(
	env: CloudflareEnv,
	domain: Pick<DomainRow, "zoneId" | "sendingSubdomainTag">,
): Promise<DomainDnsView> {
	const routingDns = await getEmailRoutingDns(env, domain.zoneId);
	const routingSettings = await getEmailRoutingSettings(env, domain.zoneId);
	let sending: CfDnsRecord[] = [];
	if (domain.sendingSubdomainTag) {
		sending = await getSendingSubdomainDns(env, domain.zoneId, domain.sendingSubdomainTag);
	}
	return {
		routing: {
			records: routingDns.records,
			missing: routingDns.missing,
			status: routingSettings.status,
		},
		sending,
	};
}

export async function removeDomainForUser(
	env: CloudflareEnv,
	orgId: string,
	userId: string,
	domainId: string,
): Promise<void> {
	const db = getDb(env);
	const domain = await getDomainForUser(env, orgId, userId, domainId);
	if (!domain) throw new Error("Domain not found");

	try {
		await deleteEmailRoutingRulesForDomain(env, domain.zoneId, domain.hostname);
	} catch (err) {
		console.warn("deleteEmailRoutingRulesForDomain", err);
	}

	if (domain.routingEnabled) {
		try {
			await disableEmailRouting(env, domain.zoneId);
		} catch (err) {
			console.warn("disableEmailRouting", err);
		}
	}

	if (domain.sendingSubdomainTag) {
		try {
			await deleteSendingSubdomain(env, domain.zoneId, domain.sendingSubdomainTag);
		} catch (err) {
			console.warn("deleteSendingSubdomain", err);
		}
	}

	await db
		.delete(domains)
		.where(and(eq(domains.organizationId, orgId), eq(domains.id, domainId)));
}

export async function getDomainForUser(
	env: CloudflareEnv,
	orgId: string,
	userId: string,
	domainId: string,
) {
	const db = getDb(env);
	const [domain] = await db
		.select()
		.from(domains)
		.where(
			and(
				eq(domains.organizationId, orgId),
				eq(domains.id, domainId),
				eq(domains.userId, userId),
			),
		)
		.limit(1);
	return domain ?? null;
}
