import { and, eq, gt } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";

export const SESSION_COOKIE = "ep_session";
/**
 * Session tokens are minted as `sess_<nanoid>`. API keys use the `ep_` prefix
 * (`KEY_PREFIX` in `src/lib/api-keys.ts`), so the two namespaces never overlap
 * and a session token can be recognised (and refused) on the bearer path.
 */
export const SESSION_TOKEN_PREFIX = "sess_";
const SESSION_DAYS = 30;

export function generateSessionToken(): string {
	return newId("sess");
}

/** True when the value looks like a session token rather than an API key. */
export function isSessionToken(value: string): boolean {
	return value.startsWith(SESSION_TOKEN_PREFIX);
}

export async function hashSessionToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function createSession(env: CloudflareEnv, userId: string): Promise<string> {
	const db = getDb(env);
	const token = generateSessionToken();
	const tokenHash = await hashSessionToken(token);
	const expiresAt = new Date();
	expiresAt.setDate(expiresAt.getDate() + SESSION_DAYS);

	await db.insert(sessions).values({
		id: newId(),
		userId,
		tokenHash,
		expiresAt,
	});

	return token;
}

/**
 * Resolves a session cookie to the user row.
 *
 * The full `users` row is selected, so `organizationId` always comes back: it is
 * the tenant scope every route runs under (see `src/lib/api/with-org.ts`). The
 * row therefore satisfies `SessionUser` (`src/lib/auth/types.d.ts`).
 */
export async function getUserFromSession(
	env: CloudflareEnv,
	token: string | undefined,
): Promise<typeof users.$inferSelect | null> {
	if (!token) return null;
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	const [session] = await db
		.select()
		.from(sessions)
		.where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
		.limit(1);
	if (!session) return null;
	const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
	return user ?? null;
}

export async function deleteSession(env: CloudflareEnv, token: string): Promise<void> {
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}
