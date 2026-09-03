/**
 * One-time auth links: password reset and magic-link sign-in.
 *
 * Rules that must not be lost:
 * - only the SHA-256 hex of the token is stored (same treatment as sessions and
 *   invites), so a database dump cannot be replayed as a login;
 * - issuing a new token spends every unused token of that user+purpose, so an
 *   old link in an old email stops working the moment a new one is asked for;
 * - redeeming is a single UPDATE ... RETURNING, so two concurrent requests can
 *   never both win: the second sees `used_at IS NOT NULL` and gets null.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { authTokens } from "@/db/schema";
import { newId } from "@/lib/ids";
import { hashSessionToken } from "@/lib/auth/session";

export type AuthTokenPurpose = (typeof authTokens.$inferSelect)["purpose"];

export type IssueAuthTokenInput = {
	userId: string;
	purpose: AuthTokenPurpose;
	/** Lifetime in milliseconds. */
	ttlMs: number;
	/** IP that asked for the link, for the abuse trail. */
	requestIp?: string;
};

/** Mints a token, returns it raw (the only time it exists in plain text). */
export async function issueAuthToken(env: CloudflareEnv, input: IssueAuthTokenInput): Promise<string> {
	const db = getDb(env);
	// Newest link wins: retire anything still outstanding for this user+purpose.
	await db
		.update(authTokens)
		.set({ usedAt: new Date() })
		.where(
			and(
				eq(authTokens.userId, input.userId),
				eq(authTokens.purpose, input.purpose),
				isNull(authTokens.usedAt),
			),
		);

	const token = newId("tok");
	await db.insert(authTokens).values({
		id: newId(),
		userId: input.userId,
		purpose: input.purpose,
		tokenHash: await hashSessionToken(token),
		expiresAt: new Date(Date.now() + input.ttlMs),
		requestIp: input.requestIp ?? null,
	});
	return token;
}

/** Spends the token. Null when it is unknown, expired or already used. */
export async function consumeAuthToken(
	env: CloudflareEnv,
	input: { token: string; purpose: AuthTokenPurpose },
): Promise<{ userId: string } | null> {
	if (!input.token) return null;
	const db = getDb(env);
	const tokenHash = await hashSessionToken(input.token);
	const [row] = await db
		.update(authTokens)
		.set({ usedAt: new Date() })
		.where(
			and(
				eq(authTokens.tokenHash, tokenHash),
				eq(authTokens.purpose, input.purpose),
				isNull(authTokens.usedAt),
				sql`${authTokens.expiresAt} > now()`,
			),
		)
		.returning({ userId: authTokens.userId });
	return row ? { userId: row.userId } : null;
}

/**
 * Drops spent and long-expired rows.
 *
 * Called once per run by `runRetention()` (`src/lib/retention/service.ts`), so
 * the daily 03:30 cron sweeps it with everything else.
 */
export async function purgeExpiredAuthTokens(
	env: CloudflareEnv,
	options?: { now?: Date; graceMs?: number },
): Promise<number> {
	const db = getDb(env);
	const now = options?.now ?? new Date();
	// Keep spent rows briefly so "this link was already used" can still be told
	// apart from "never existed" while a user retries.
	const cutoff = new Date(now.getTime() - (options?.graceMs ?? 24 * 60 * 60 * 1000));
	const rows = await db
		.delete(authTokens)
		.where(or(lt(authTokens.expiresAt, cutoff), lt(authTokens.usedAt, cutoff)))
		.returning({ id: authTokens.id });
	return rows.length;
}
