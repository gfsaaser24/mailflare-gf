import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
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
/** Full session lifetime in seconds; also the cookie max-age. */
export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;
/** A session waiting on the TOTP step is short-lived: pass the code or start again. */
export const PENDING_TWO_FACTOR_MS = 10 * 60 * 1000;
/** `last_seen_at` is refreshed at most this often, so reads stay read-mostly. */
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

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
 * Optional extras for a session. `/api/platform/orgs/[id]/impersonate` (T3.3)
 * passes the impersonation pair; `completeLogin()` passes the client details and
 * the two-factor flag. Ordinary callers still use `createSession(env, userId)`.
 */
export type CreateSessionOptions = {
	/** Lifetime in milliseconds. Defaults to `SESSION_DAYS`. */
	expiresInMs?: number;
	/** Platform operator acting as this user. */
	impersonatedByUserId?: string;
	/** Organisation the operator asked to enter. */
	impersonatedOrganizationId?: string;
	/** Password accepted, TOTP still outstanding. Such a session is not logged in. */
	pendingTwoFactor?: boolean;
	/** Client details captured at login, for the sessions list. */
	ipAddress?: string;
	userAgent?: string;
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
		pendingTwoFactor: options.pendingTwoFactor ?? false,
		ipAddress: options.ipAddress ?? null,
		userAgent: options.userAgent ?? null,
	});

	return token;
}

/**
 * Resolves a session cookie to the user row.
 *
 * The full `users` row is selected, so `organizationId` always comes back: it is
 * the tenant scope every route runs under (see `src/lib/api/with-org.ts`). The
 * row therefore satisfies `SessionUser` (`src/lib/auth/types.d.ts`).
 *
 * A session with `pending_two_factor` has only passed the password step, so it
 * is treated as not logged in here. Only `getPendingTwoFactorSession()` can see
 * it, and only `promotePendingSession()` can turn it into a real session.
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
	if (session.pendingTwoFactor) return null;
	const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
	if (!user) return null;
	await touchSession(env, session.id, session.lastSeenAt);
	// Additive: null on every ordinary session, the operator's id while impersonating.
	return { ...user, impersonatedByUserId: session.impersonatedByUserId };
}

/**
 * Bumps `last_seen_at`, but only when it is stale by more than
 * `LAST_SEEN_REFRESH_MS`. The stored value is compared first (in JS and again in
 * the WHERE clause), so a busy session costs one UPDATE per five minutes, not
 * one per request. Failure is swallowed: a session must not break because a
 * bookkeeping write did.
 */
async function touchSession(
	env: CloudflareEnv,
	sessionId: string,
	lastSeenAt: Date | null,
): Promise<void> {
	const now = new Date();
	if (lastSeenAt && now.getTime() - lastSeenAt.getTime() < LAST_SEEN_REFRESH_MS) return;
	const staleBefore = new Date(now.getTime() - LAST_SEEN_REFRESH_MS);
	try {
		await getDb(env)
			.update(sessions)
			.set({ lastSeenAt: now })
			.where(
				and(
					eq(sessions.id, sessionId),
					or(isNull(sessions.lastSeenAt), lt(sessions.lastSeenAt, staleBefore)),
				),
			);
	} catch (error) {
		console.warn("Could not refresh session last_seen_at", error);
	}
}

/**
 * The half-authenticated session behind `/login/two-factor`. Returns a row only
 * while the session is pending and unexpired; anything else is null.
 */
export async function getPendingTwoFactorSession(
	env: CloudflareEnv,
	token: string | undefined,
): Promise<{ session: typeof sessions.$inferSelect; user: typeof users.$inferSelect } | null> {
	if (!token) return null;
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	const [session] = await db
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.tokenHash, tokenHash),
				eq(sessions.pendingTwoFactor, true),
				gt(sessions.expiresAt, new Date()),
			),
		)
		.limit(1);
	if (!session) return null;
	const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
	if (!user) return null;
	return { session, user };
}

/**
 * Turns a pending session into a full one once the TOTP step passed: clears the
 * flag and extends the short 10-minute window to the normal 30 days. The
 * `pending_two_factor = true` guard makes it a no-op on an already-promoted
 * session, so it cannot be used to extend an ordinary session.
 */
export async function promotePendingSession(env: CloudflareEnv, token: string): Promise<boolean> {
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
	const rows = await db
		.update(sessions)
		.set({ pendingTwoFactor: false, expiresAt, lastSeenAt: new Date() })
		.where(
			and(
				eq(sessions.tokenHash, tokenHash),
				eq(sessions.pendingTwoFactor, true),
				sql`${sessions.expiresAt} > now()`,
			),
		)
		.returning({ id: sessions.id });
	return rows.length > 0;
}

export async function deleteSession(env: CloudflareEnv, token: string): Promise<void> {
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}
