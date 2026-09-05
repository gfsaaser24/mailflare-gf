/**
 * Client IP resolution behind the trusted reverse proxy (Coolify/Traefik).
 *
 * Traefik sets X-Real-IP to the connecting peer and appends that peer to
 * X-Forwarded-For. Client-supplied entries sit at the front of that list, so
 * we never use the first entry: prefer X-Real-IP, then the LAST forwarded
 * entry, which is the one written by our own proxy.
 *
 * `CF-Connecting-IP` is checked FIRST, but only when `TRUST_CF_HEADERS=true`.
 * The app is moving behind the Cloudflare proxy, where that header is written
 * by Cloudflare and is the only honest client address. Without Cloudflare in
 * front, anyone can set it on a direct request, so trusting it by default would
 * hand every attacker a free rate-limit bypass. Hence: opt-in, and only turn it
 * on when the origin refuses traffic that did not come through Cloudflare.
 *
 * The flag is read from `AppEnv` (`src/lib/env.ts`), which is the one place
 * `process.env` is parsed. Callers that already hold an env should pass it;
 * everyone else falls back to `getEnv()`.
 */

import { getEnv } from "@/lib/env";

/** Just the slice of the env this module needs. */
type TrustEnv = Pick<AppEnv, "TRUST_CF_HEADERS">;

/**
 * `src/lib/env.ts` pulls in the database, storage and mail transport, none of
 * which import this module, so the import above is not a cycle. `getEnv()` is
 * still called defensively: a half-configured env must not turn IP resolution
 * into a throw, and the failure mode is "do not trust the Cloudflare header".
 */
function trustsCloudflareHeaders(env?: TrustEnv): boolean {
	if (env) return env.TRUST_CF_HEADERS === "true";
	try {
		return getEnv().TRUST_CF_HEADERS === "true";
	} catch {
		return false;
	}
}

export function getClientIp(request: Request, env?: TrustEnv): string {
	if (trustsCloudflareHeaders(env)) {
		const cfIp = request.headers.get("cf-connecting-ip")?.trim();
		if (cfIp) return cfIp;
	}

	const realIp = request.headers.get("x-real-ip")?.trim();
	if (realIp) return realIp;

	const forwardedFor = request.headers.get("x-forwarded-for");
	if (forwardedFor) {
		const entries = forwardedFor.split(",").map((entry) => entry.trim()).filter(Boolean);
		const last = entries[entries.length - 1];
		if (last) return last;
	}

	return "unknown";
}
