import { and, eq } from "drizzle-orm";
import { domains, mailboxes } from "@/db/schema";
import type { OrgContext } from "@/lib/api/with-org";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { newId } from "@/lib/ids";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";

/**
 * The mailboxes the caller can open, creating their personal one on the way if the
 * organisation owns the domain of their address and nothing claims it yet.
 */
export async function ensurePersonalMailbox(ctx: OrgContext) {
	const { db, env, orgId, scoped, insertValues, user } = ctx;
	const current = await listAccessibleMailboxes(db, user, orgId);
	if (current.some((mailbox) => mailbox.userId === user.id && mailbox.type === "personal")) return current;

	const [localPart, hostname] = user.email.toLowerCase().split("@");
	if (!localPart || !hostname) return current;
	const [domain] = await db
		.select()
		.from(domains)
		.where(and(scoped(domains), eq(domains.hostname, hostname)))
		.limit(1);
	if (!domain) return current;

	const [existing] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(
			and(scoped(mailboxes), eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, localPart)),
		)
		.limit(1);
	if (existing) return current;

	try {
		await ensureEmailRoutingRuleToWorker(env, domain.zoneId, user.email);
	} catch {
		// Mailbox visibility should not depend on routing API availability.
	}

	const id = newId("mbx");
	try {
		await db.insert(mailboxes).values(
			insertValues(mailboxes, {
				id,
				userId: user.id,
				domainId: domain.id,
				localPart,
				displayName: user.name || localPart,
				type: "personal",
			}),
		);
	} catch {
		return current;
	}
	try {
		await ensureMailboxDomainRouting(
			env,
			db,
			{ id, domainId: domain.id, localPart, useAllDomains: true },
			orgId,
		);
	} catch {
		// Mailbox visibility should not depend on routing API availability.
	}

	return listAccessibleMailboxes(db, user, orgId);
}
