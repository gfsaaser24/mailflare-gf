import { and, desc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import type { OrgContext } from "@/lib/api/with-org";
import { isAdmin } from "@/lib/auth/admin";

type Db = ReturnType<typeof getDb>;

/**
 * Accounts visible to an admin inside one organisation: the admin themselves plus
 * every account they created.
 *
 * `orgId` is `ctx.orgId` from `withOrg`; it is optional only so the unit test that
 * exercises the created-by tree can call this with a bare database handle.
 */
export function listAccountsForAdmin(db: Db, adminUserId: string, orgId?: string) {
	return db
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			resetEmail: users.resetEmail,
			role: users.role,
			disabled: users.disabled,
			avatarKey: users.avatarKey,
			canManageMailboxes: users.canManageMailboxes,
			createdAt: users.createdAt,
		})
		.from(users)
		.where(
			and(
				...(orgId ? [eq(users.organizationId, orgId)] : []),
				or(eq(users.id, adminUserId), eq(users.createdByUserId, adminUserId)),
			),
		)
		.orderBy(desc(users.createdAt));
}

export async function getDomainForAdmin(
	{ db, scoped }: OrgContext,
	adminUserId: string,
	domainId: string,
) {
	const [domain] = await db
		.select()
		.from(domains)
		.where(and(scoped(domains), eq(domains.id, domainId), eq(domains.userId, adminUserId)))
		.limit(1);
	return domain ?? null;
}

export async function getExistingMailbox(
	{ db, scoped }: OrgContext,
	domainId: string,
	localPart: string,
) {
	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(
			and(scoped(mailboxes), eq(mailboxes.domainId, domainId), eq(mailboxes.localPart, localPart)),
		)
		.limit(1);
	return mailbox ?? null;
}

export function accountListItemFromUser(user: {
	id: string;
	email: string;
	name: string;
	resetEmail: string | null;
	role: "admin" | "user";
	disabled: boolean;
	avatarKey?: string | null;
	canManageMailboxes?: boolean;
	createdAt: Date;
}) {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		resetEmail: user.resetEmail,
		role: user.role,
		disabled: user.disabled,
		hasAvatar: !!user.avatarKey,
		canManageMailboxes: !!user.canManageMailboxes,
		createdAt: user.createdAt,
	};
}

/**
 * Team administration is admin-only. `withOrg` has already authenticated the caller
 * and pinned the organisation, so this only checks the role.
 */
export function requireTeamAdmin(ctx: OrgContext): NextResponse | null {
	return isAdmin(ctx.user) ? null : NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
