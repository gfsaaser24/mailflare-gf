import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, users } from "@/db/schema";
import { verifyApiKey, parseScopes } from "@/lib/api-keys";
import { isSessionToken } from "@/lib/auth/session";
import { getClientIp } from "@/lib/http/ip";

/** Mirrors `KEY_PREFIX` in `src/lib/api-keys.ts`; every issued API key starts with it. */
const API_KEY_PREFIX = "ep_";

export type ApiAuthResult = {
	/** `api_keys.id` of the key that authenticated the request. */
	apiKeyId: string;
	userId: string;
	email: string;
	/**
	 * Tenant scope for the request, taken from `api_keys.organization_id` (not
	 * from the owning user): a key is issued inside one organisation and can only
	 * ever act there. `withOrg()` uses this as `ctx.orgId`.
	 */
	organizationId: string;
	scopes: string[];
	/** The key owner's row, so callers do not have to re-query `users`. */
	user: typeof users.$inferSelect;
};

/**
 * A key that matched a row but must not be used. Callers answer 401 with
 * `message`, so the operator can tell "revoked" apart from "never existed".
 */
export type ApiAuthFailure = {
	reason: "revoked" | "expired";
	message: "API key revoked" | "API key expired";
};

export type ApiAuthOutcome = ApiAuthResult | ApiAuthFailure | null;

export function isApiAuthFailure(outcome: ApiAuthOutcome): outcome is ApiAuthFailure {
	return outcome !== null && "reason" in outcome;
}

/**
 * Resolves `Authorization: Bearer ep_...` to its owner.
 *
 * Returns `null` for anything unrecognised, an `ApiAuthFailure` for a key that
 * exists but is revoked or expired, and an `ApiAuthResult` otherwise. `request`
 * is optional and only used to record `last_used_ip`.
 */
export async function authenticateApiKey(
	env: CloudflareEnv,
	authorization: string | null,
	request?: Request,
): Promise<ApiAuthOutcome> {
	if (!authorization?.startsWith("Bearer ")) return null;
	const key = authorization.slice(7).trim();
	if (!key) return null;
	// Bearer is for API keys only. A session token presented here is never
	// accepted: session auth is cookie-only.
	if (isSessionToken(key) || !key.startsWith(API_KEY_PREFIX)) return null;

	const prefix = key.slice(0, 12);
	const db = getDb(env);
	const candidates = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix));

	const now = new Date();
	for (const candidate of candidates) {
		if (!verifyApiKey(key, candidate.keyHash, candidate.hashAlgo)) continue;
		// The key is genuine from here on, so a bad state is reported rather than
		// silently falling through to "unknown credentials".
		if (candidate.revokedAt) return { reason: "revoked", message: "API key revoked" };
		if (candidate.expiresAt && candidate.expiresAt.getTime() < now.getTime()) {
			return { reason: "expired", message: "API key expired" };
		}

		const [user] = await db.select().from(users).where(eq(users.id, candidate.userId)).limit(1);
		if (!user || user.disabled) continue;

		// Fire-and-forget: usage bookkeeping must never fail or slow the request.
		void db
			.update(apiKeys)
			.set({ lastUsedAt: now, lastUsedIp: request ? getClientIp(request) : null })
			.where(eq(apiKeys.id, candidate.id))
			.catch(() => {});

		return {
			apiKeyId: candidate.id,
			userId: user.id,
			email: user.email,
			organizationId: candidate.organizationId,
			scopes: parseScopes(candidate.scopes),
			user,
		};
	}
	return null;
}

export function requireScope(scopes: string[], required: string): boolean {
	return scopes.includes(required) || scopes.includes("*");
}
