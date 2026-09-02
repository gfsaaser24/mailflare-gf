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

/**
 * Optional extras for a session. Only `/api/platform/orgs/[id]/impersonate`
 * (T3.3) passes them; ordinary logins call `createSession(env, userId)`.
 */
export type CreateSessionOptions = {
	/** Lifetime in milliseconds. Defaults to `SESSION_DAYS`. */
	expiresInMs?: number;
	/** Platform operator acting as this user. */
	impersonatedByUserId?: string;
	/** Organisation the operator asked to enter. */
	impersonatedOrganizationId?: string;
};

export async function createSession(
	env: CloudflareEnv,
	userId: string,
	options: CreateSessionOptions = {},
): Promise<string> {
	const db = getDb(env);
	const token = generateSessionToken();
	const tokenHash = await hashSessionToken(token);
	const expiresAt =
		options.expiresInMs === undefined
			? (() => {
					const at = new Date();
					at.setDate(at.getDate() + SESSION_DAYS);
					return at;
				})()
			: new Date(Date.now() + options.expiresInMs);

	await db.insert(sessions).values({
		id: newId(),
		userId,
		tokenHash,
		expiresAt,
		impersonatedByUserId: options.impersonatedByUserId ?? null,
		impersonatedOrganizationId: options.impersonatedOrganizationId ?? null,
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
): Promise<(typeof users.$inferSelect & { impersonatedByUserId: string | null }) | null> {
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
	if (!user) return null;
	// Additive: null on every ordinary session, the operator's id while impersonating.
	return { ...user, impersonatedByUserId: session.impersonatedByUserId };
}

export async function deleteSession(env: CloudflareEnv, token: string): Promise<void> {
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}
