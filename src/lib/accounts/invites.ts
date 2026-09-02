/**
 * Set-password invites (T3.5).
 *
 * A 32-byte random token is generated, its SHA-256 hex stored in `user_invites`
 * and the raw token handed back exactly once (in an email, or to the admin who
 * created the account when there is no mailbox to send from). Accepting an
 * invite sets the password, spends the token, drops every other pending invite
 * for that user and revokes their sessions.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, isNull, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxes, organizations, sessions, userInvites, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { formatEmailAddress } from "@/lib/email/address";
import { getEnv } from "@/lib/env";
import { newId } from "@/lib/ids";

/** Accepts the shared database handle or a transaction handle. */
export type InviteDb = Pick<AppDatabase, "select" | "insert" | "update" | "delete">;

/** How long an invite stays usable. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateInviteToken(): string {
	return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/**
 * The URL of the set-password page. `APP_URL` is optional, so this degrades to a
 * site-relative path rather than inventing an origin.
 */
export function inviteUrlFor(token: string, env: Pick<AppEnv, "APP_URL"> = getEnv()): string {
	const base = (env.APP_URL ?? "").trim().replace(/\/+$/, "");
	return `${base}/invite/${token}`;
}

export type CreatedInvite = {
	id: string;
	/** The raw token. Never stored, never logged; shown or emailed once. */
	token: string;
	url: string;
	expiresAt: Date;
};

/**
 * Issues an invite for `userId`. Any pending invite of that user is dropped
 * first, so a resend always invalidates the previous link.
 */
export async function createInvite(
	db: InviteDb,
	input: { organizationId: string; userId: string; createdByUserId?: string | null },
): Promise<CreatedInvite> {
	await db
		.delete(userInvites)
		.where(and(eq(userInvites.userId, input.userId), isNull(userInvites.acceptedAt)));

	const token = generateInviteToken();
	const id = newId("inv");
	const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

	await db.insert(userInvites).values({
		id,
		organizationId: input.organizationId,
		userId: input.userId,
		tokenHash: hashInviteToken(token),
		expiresAt,
		createdByUserId: input.createdByUserId ?? null,
	});

	return { id, token, url: inviteUrlFor(token), expiresAt };
}

export type InviteTarget = {
	inviteId: string;
	organizationId: string;
	userId: string;
	email: string;
	name: string;
	organizationName: string;
	expiresAt: Date;
};

/**
 * The invite behind a raw token, or `null` when it is unknown, expired, already
 * accepted, or belongs to a disabled account.
 */
export async function findUsableInvite(db: InviteDb, token: string): Promise<InviteTarget | null> {
	if (!token || token.length > 256) return null;
	const [row] = await db
		.select({
			inviteId: userInvites.id,
			organizationId: userInvites.organizationId,
			userId: userInvites.userId,
			expiresAt: userInvites.expiresAt,
			email: users.email,
			name: users.name,
			disabled: users.disabled,
			organizationName: organizations.name,
		})
		.from(userInvites)
		.innerJoin(users, eq(userInvites.userId, users.id))
		.innerJoin(organizations, eq(userInvites.organizationId, organizations.id))
		.where(
			and(
				eq(userInvites.tokenHash, hashInviteToken(token)),
				isNull(userInvites.acceptedAt),
				gt(userInvites.expiresAt, new Date()),
			),
		)
		.limit(1);
	if (!row || row.disabled) return null;
	return {
		inviteId: row.inviteId,
		organizationId: row.organizationId,
		userId: row.userId,
		email: row.email,
		name: row.name,
		organizationName: row.organizationName,
		expiresAt: row.expiresAt,
	};
}

export type AcceptInviteResult =
	| { ok: true; userId: string; email: string }
	| { ok: false; reason: "invalid" };

/**
 * Spends an invite: sets the password, marks the row accepted, deletes the
 * user's other pending invites and revokes every session they still hold.
 */
export async function acceptInvite(
	db: AppDatabase,
	token: string,
	password: string,
): Promise<AcceptInviteResult> {
	const invite = await findUsableInvite(db, token);
	if (!invite) return { ok: false, reason: "invalid" };

	const passwordHash = hashPassword(password);
	const spent = await db.transaction(async (tx) => {
		// Claimed inside the transaction, so two concurrent accepts cannot both win.
		const claimed = await tx
			.update(userInvites)
			.set({ acceptedAt: new Date() })
			.where(and(eq(userInvites.id, invite.inviteId), isNull(userInvites.acceptedAt)))
			.returning({ id: userInvites.id });
		if (claimed.length === 0) return false;

		await tx.update(users).set({ passwordHash }).where(eq(users.id, invite.userId));
		await tx
			.delete(userInvites)
			.where(and(eq(userInvites.userId, invite.userId), ne(userInvites.id, invite.inviteId)));
		await tx.delete(sessions).where(eq(sessions.userId, invite.userId));
		return true;
	});

	if (!spent) return { ok: false, reason: "invalid" };
	return { ok: true, userId: invite.userId, email: invite.email };
}

/**
 * The address an organisation sends its own mail from: the oldest enabled
 * mailbox on one of its domains. `null` when the organisation has none yet, in
 * which case the caller hands the invite URL back instead of emailing it.
 *
 * `getAuthorizedSenderAddress` (src/lib/email/sender.ts) is the equivalent for a
 * user-initiated send; it needs a mailbox id and a permission check, neither of
 * which applies to an invite sent by the system.
 */
export async function getOrganizationSenderAddress(
	db: InviteDb,
	organizationId: string,
): Promise<{ address: string; from: string; organizationName: string } | null> {
	const [row] = await db
		.select({
			localPart: mailboxes.localPart,
			hostname: domains.hostname,
			organizationName: organizations.name,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(organizations, eq(mailboxes.organizationId, organizations.id))
		.where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.disabled, false)))
		.orderBy(asc(mailboxes.createdAt))
		.limit(1);
	if (!row) return null;
	const address = `${row.localPart}@${row.hostname}`.toLowerCase();
	return {
		address,
		from: formatEmailAddress(address, row.organizationName),
		organizationName: row.organizationName,
	};
}

export type InviteDelivery = {
	/** True when the message was handed to the transport. */
	sent: boolean;
	/** Present only when it was **not** sent, so the admin can pass it on. */
	url?: string;
	/** Why it was not sent. */
	reason?: string;
};

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function inviteEmailBody(input: { name: string; organizationName: string; url: string }): {
	text: string;
	html: string;
} {
	const text = [
		`Hello ${input.name},`,
		"",
		`You have an account on ${input.organizationName}. Set your password to sign in:`,
		input.url,
		"",
		"The link works once and expires in 7 days.",
	].join("\n");
	const html = [
		`<p>Hello ${escapeHtml(input.name)},</p>`,
		`<p>You have an account on ${escapeHtml(input.organizationName)}. Set your password to sign in:</p>`,
		`<p><a href="${escapeHtml(input.url)}">${escapeHtml(input.url)}</a></p>`,
		"<p>The link works once and expires in 7 days.</p>",
	].join("");
	return { text, html };
}

/**
 * Emails an invite from the organisation's own address. Never throws: a failed
 * send comes back as `{ sent: false, url }` so the caller can show the link.
 */
export async function sendInviteEmail(
	env: Pick<AppEnv, "EMAIL">,
	db: InviteDb,
	input: { organizationId: string; to: string; name: string; url: string },
): Promise<InviteDelivery> {
	const sender = await getOrganizationSenderAddress(db, input.organizationId);
	if (!sender) {
		return {
			sent: false,
			url: input.url,
			reason: "This organisation has no mailbox to send from yet, so the invite was not emailed.",
		};
	}
	const body = inviteEmailBody({
		name: input.name,
		organizationName: sender.organizationName,
		url: input.url,
	});
	try {
		await env.EMAIL.send({
			from: sender.from,
			to: input.to,
			subject: `Set your password for ${sender.organizationName}`,
			text: body.text,
			html: body.html,
		});
		return { sent: true };
	} catch (error) {
		return {
			sent: false,
			url: input.url,
			reason: error instanceof Error ? error.message : "Invite email could not be sent.",
		};
	}
}

/** Creates an invite and tries to email it in one step. */
export async function issueInvite(
	env: Pick<AppEnv, "EMAIL">,
	db: AppDatabase,
	input: {
		organizationId: string;
		userId: string;
		email: string;
		name: string;
		createdByUserId?: string | null;
	},
): Promise<{ invite: CreatedInvite; delivery: InviteDelivery }> {
	const invite = await createInvite(db, input);
	const delivery = await sendInviteEmail(env, db, {
		organizationId: input.organizationId,
		to: input.email,
		name: input.name,
		url: invite.url,
	});
	return { invite, delivery };
}
