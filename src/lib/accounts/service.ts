/**
 * Org-scoped account operations (T3.5).
 *
 * The invite machinery lives in `./invites.ts` and the ownership move in
 * `./transfer.ts`; this file holds the small account-lifecycle pieces and
 * re-exports the rest so routes have one import.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { sessions, users } from "@/db/schema";

export * from "./invites";
export * from "./transfer";

/**
 * A throwaway password for an account that will set its own via an invite. It is
 * never shown to anybody: the row needs a `password_hash`, and until the invite
 * is accepted nothing can log in as that account.
 */
export function generateRandomPassword(): string {
	return randomBytes(24).toString("base64url");
}

/**
 * Disables an account and revokes every session it holds, so the user is out
 * immediately rather than at the next cookie expiry. Idempotent.
 *
 * Returns `false` when the id does not name an account of `organizationId`.
 */
export async function disableUser(
	db: AppDatabase,
	organizationId: string,
	userId: string,
): Promise<boolean> {
	return db.transaction(async (tx) => {
		const updated = await tx
			.update(users)
			.set({ disabled: true })
			.where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
			.returning({ id: users.id });
		if (updated.length === 0) return false;
		await tx.delete(sessions).where(eq(sessions.userId, userId));
		return true;
	});
}
