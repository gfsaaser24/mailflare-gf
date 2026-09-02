import { and, eq, ne } from "drizzle-orm";
import type { getDb } from "@/db";
import { mailboxes, users } from "@/db/schema";
import type { OrgContext } from "@/lib/api/with-org";
import { hashPassword } from "@/lib/auth/password";

// Accepts the shared db or a transaction handle.
type Db = Pick<ReturnType<typeof getDb>, "select" | "update" | "insert" | "delete">;

/** One account of one organisation; an id from another organisation reads as missing. */
export async function selectAccountById(db: Db, orgId: string, id: string) {
	const [account] = await db
		.select()
		.from(users)
		.where(and(eq(users.organizationId, orgId), eq(users.id, id)))
		.limit(1);
	return account ?? null;
}

/**
 * The account an admin may administer: themselves or somebody they created, always
 * inside the request's organisation. Returns null for everything else, so callers
 * answer 404.
 */
export async function getManagedAccount(ctx: OrgContext, id: string) {
	const account = await selectAccountById(ctx.db, ctx.orgId, id);
	if (!account) return null;
	if (account.id !== ctx.user.id && account.createdByUserId !== ctx.user.id) return null;
	return account;
}

export async function emailBelongsToAnotherAccount(
	db: Db,
	orgId: string,
	accountId: string,
	email: string,
) {
	const [account] = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.organizationId, orgId), eq(users.email, email), ne(users.id, accountId)))
		.limit(1);
	return !!account;
}

export async function updateAccountCredentials(
	db: Db,
	orgId: string,
	id: string,
	input: { email?: string; name: string; password: string | null; disabled?: boolean },
) {
	await db
		.update(users)
		.set({
			...(input.email ? { email: input.email.trim().toLowerCase() } : {}),
			name: input.name,
			...(typeof input.disabled === "boolean" ? { disabled: input.disabled } : {}),
			...(input.password ? { passwordHash: hashPassword(input.password) } : {}),
		})
		.where(and(eq(users.organizationId, orgId), eq(users.id, id)));

	await db
		.update(mailboxes)
		.set({ displayName: input.name })
		.where(
			and(
				eq(mailboxes.organizationId, orgId),
				eq(mailboxes.userId, id),
				eq(mailboxes.type, "personal"),
			),
		);
}
