/**
 * Agent mail — the inboxes an automated agent owns, and what that means for
 * two-factor authentication.
 *
 * Cloudflare's Email Service / Agents SDK lets an agent own an inbox. Nothing
 * is there to read a code out of an authenticator app, so a human-style TOTP
 * step must never stand in front of such an account.
 *
 * Two-factor is per USER (`users.totp_enabled_at`), not per mailbox, so the
 * rule is applied to the mailbox OWNER (`mailboxes.user_id`) — delegated access
 * to a shared agent inbox says nothing about the delegate's own account and
 * must never relax their second factor.
 *
 * The two directions of the same rule:
 *  - an owner of an agent mailbox cannot enrol, and is exempt from the
 *    organisation's `require_two_factor` (`agentMailBlocksTwoFactor`);
 *  - a mailbox cannot be flagged while its owner already has two-factor on
 *    (`ownerBlocksAgentMail`) — they have to turn it off first.
 */
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";

/** The `error` code every two-factor route returns for an agent-mail owner. */
export const TWO_FACTOR_UNAVAILABLE_AGENT_MAIL = "two_factor_unavailable_agent_mail";
/** The `error` code returned when the owner has to drop two-factor first. */
export const OWNER_HAS_TWO_FACTOR = "owner_has_two_factor";

/** One flagged mailbox, with the address a human recognises it by. */
export type AgentMailbox = {
	id: string;
	address: string;
};

/**
 * Every mailbox in `orgId` that `userId` OWNS and that is flagged as agent
 * mail. Empty for a user who merely has delegated access to one.
 *
 * Disabled rows count: the flag, not the state, is what decides.
 */
export async function getAgentMailMailboxesForUser(
	db: AppDatabase,
	userId: string,
	orgId: string,
): Promise<AgentMailbox[]> {
	const rows = await db
		.select({
			id: mailboxes.id,
			localPart: mailboxes.localPart,
			hostname: domains.hostname,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(
			and(
				eq(mailboxes.organizationId, orgId),
				eq(mailboxes.userId, userId),
				eq(mailboxes.agentMail, true),
			),
		)
		.orderBy(domains.hostname, mailboxes.localPart);

	return rows.map((row) => ({ id: row.id, address: `${row.localPart}@${row.hostname}` }));
}

/** True when this user owns at least one agent mailbox. */
export async function ownsAgentMailMailbox(
	db: AppDatabase,
	userId: string,
	orgId: string,
): Promise<boolean> {
	return (await getAgentMailMailboxesForUser(db, userId, orgId)).length > 0;
}

/** "support@acme.test" / "support@acme.test and one other" — for a sentence. */
export function describeAgentMailboxes(list: AgentMailbox[]): string {
	const addresses = list.map((item) => item.address);
	if (addresses.length <= 2) return addresses.join(" and ");
	return `${addresses.slice(0, -1).join(", ")} and ${addresses[addresses.length - 1]}`;
}

/**
 * The 400 body for a two-factor route when the caller owns agent mail, or null
 * when they do not and enrolment may go ahead.
 */
export async function agentMailBlocksTwoFactor(
	db: AppDatabase,
	userId: string,
	orgId: string,
): Promise<{ error: string; message: string } | null> {
	const list = await getAgentMailMailboxesForUser(db, userId, orgId);
	if (list.length === 0) return null;
	return {
		error: TWO_FACTOR_UNAVAILABLE_AGENT_MAIL,
		message:
			`Two-factor authentication is not available on this account: it owns ` +
			`${describeAgentMailboxes(list)}, ` +
			`${list.length === 1 ? "an inbox" : "inboxes"} operated by an automated agent. ` +
			`Turn agent mail off first.`,
	};
}

/**
 * The 400 body for flagging a mailbox whose owner already has two-factor on, or
 * null when the flag may be set. Only ever called for `agentMail = true`;
 * clearing the flag is always allowed.
 */
export async function ownerBlocksAgentMail(
	db: AppDatabase,
	ownerUserId: string,
	orgId: string,
): Promise<{ error: string; message: string } | null> {
	const [owner] = await db
		.select({ email: users.email, totpEnabledAt: users.totpEnabledAt })
		.from(users)
		.where(and(eq(users.organizationId, orgId), eq(users.id, ownerUserId)))
		.limit(1);
	if (!owner?.totpEnabledAt) return null;
	return {
		error: OWNER_HAS_TWO_FACTOR,
		message:
			`${owner.email} has two-factor authentication on. An agent cannot type a code, ` +
			`so turn two-factor off for that account before marking one of its inboxes as agent mail.`,
	};
}
