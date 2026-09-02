import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import type { MailboxDomainAddressInput } from "./domain-addresses-types";

/**
 * Every address this mailbox receives on.
 *
 * `orgId` is the caller's organisation (`ctx.orgId` from `withOrg`): pass it and only
 * domains and mailboxes of that organisation are considered. It is optional only
 * while routes are still being migrated.
 */
export async function getMailboxDomainAddresses(
	db: AppDatabase,
	mailbox: MailboxDomainAddressInput,
	orgId?: string,
): Promise<string[]> {
	const inOrgDomains = orgId ? [eq(domains.organizationId, orgId)] : [];
	const inOrgMailboxes = orgId ? [eq(mailboxes.organizationId, orgId)] : [];
	const [primaryDomain] = await db
		.select({ hostname: domains.hostname, userId: domains.userId })
		.from(domains)
		.where(and(eq(domains.id, mailbox.domainId), ...inOrgDomains))
		.limit(1);
	if (!primaryDomain) return [];

	const primaryAddress = `${mailbox.localPart}@${primaryDomain.hostname}`.toLowerCase();
	if (!mailbox.useAllDomains) return [primaryAddress];

	const availableDomains = await db
		.select({ id: domains.id, hostname: domains.hostname })
		.from(domains)
		.where(
			and(eq(domains.userId, primaryDomain.userId), eq(domains.status, "active"), ...inOrgDomains),
		);
	const assignedMailboxes = await db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId })
		.from(mailboxes)
		.where(and(eq(mailboxes.localPart, mailbox.localPart), ...inOrgMailboxes));
	const assignedDomainIds = new Set(
		assignedMailboxes.filter((item) => item.id !== mailbox.id).map((item) => item.domainId),
	);

	return [
		primaryAddress,
		...availableDomains
			.filter((domain) => domain.id !== mailbox.domainId && !assignedDomainIds.has(domain.id))
			.map((domain) => `${mailbox.localPart}@${domain.hostname}`.toLowerCase()),
	];
}

/** As `getMailboxDomainAddresses`; `orgId` scopes the domains that may be touched. */
export async function ensureMailboxDomainRouting(
	env: CloudflareEnv,
	db: AppDatabase,
	mailbox: MailboxDomainAddressInput,
	orgId?: string,
): Promise<void> {
	const inOrgDomains = orgId ? [eq(domains.organizationId, orgId)] : [];
	const addresses = await getMailboxDomainAddresses(db, mailbox, orgId);
	if (addresses.length === 0) return;
	const [primaryDomain] = await db
		.select({ userId: domains.userId })
		.from(domains)
		.where(and(eq(domains.id, mailbox.domainId), ...inOrgDomains))
		.limit(1);
	if (!primaryDomain) return;
	const availableDomains = await db
		.select({ hostname: domains.hostname, zoneId: domains.zoneId })
		.from(domains)
		.where(and(eq(domains.userId, primaryDomain.userId), ...inOrgDomains));
	const domainsByHostname = new Map(availableDomains.map((domain) => [domain.hostname.toLowerCase(), domain]));

	await Promise.all(
		addresses.map(async (address) => {
			const hostname = address.slice(address.lastIndexOf("@") + 1);
			const domain = domainsByHostname.get(hostname);
			if (domain) await ensureEmailRoutingRuleToWorker(env, domain.zoneId, address);
		}),
	);
}
