import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, users } from "@/db/schema";
import { verifyApiKey, parseScopes } from "@/lib/api-keys";
import { isSessionToken } from "@/lib/auth/session";

/** Mirrors `KEY_PREFIX` in `src/lib/api-keys.ts`; every issued API key starts with it. */
const API_KEY_PREFIX = "ep_";

export type ApiAuthResult = {
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

export async function authenticateApiKey(
	env: CloudflareEnv,
	authorization: string | null,
): Promise<ApiAuthResult | null> {
	if (!authorization?.startsWith("Bearer ")) return null;
	const key = authorization.slice(7).trim();
	if (!key) return null;
	// Bearer is for API keys only. A session token presented here is never
	// accepted: session auth is cookie-only.
	if (isSessionToken(key) || !key.startsWith(API_KEY_PREFIX)) return null;

	const prefix = key.slice(0, 12);
	const db = getDb(env);
	const candidates = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix));

	for (const candidate of candidates) {
		if (!verifyApiKey(key, candidate.keyHash)) continue;
		const [user] = await db.select().from(users).where(eq(users.id, candidate.userId)).limit(1);
		if (!user || user.disabled) continue;

		await db
			.update(apiKeys)
			.set({ lastUsedAt: new Date() })
			.where(eq(apiKeys.id, candidate.id));

		return {
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
