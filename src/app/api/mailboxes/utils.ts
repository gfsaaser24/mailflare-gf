import { and, eq } from "drizzle-orm";
import { domains, mailboxes, users } from "@/db/schema";
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

/**
 * The 409 message for an address that is already taken, naming the owning account.
 *
 * Admin-only: the owner's email is looked up on the conflict path alone, and only
 * because the caller may already provision mailboxes for those accounts.
 */
export async function describeMailboxConflict(
	{ db, scoped }: OrgContext,
	existing: { userId: string },
	address: string,
): Promise<string> {
	const [owner] = await db
		.select({ email: users.email })
		.from(users)
		.where(and(scoped(users), eq(users.id, existing.userId)))
		.limit(1);
	return owner ? `${address} is already assigned to ${owner.email}` : "Mailbox already exists";
}
