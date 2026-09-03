import { getClientIp } from "@/lib/http/ip";

/**
 * Rate limiting for the auth surfaces.
 *
 * `allowLoginAttempt` is the original per-IP login guard and keeps its exact
 * behaviour. `allowAttempt` is the general form: pick a named bucket from
 * `env.AUTH_RATE_LIMITS` (built in `src/lib/env.ts`) and give it the key you
 * want to count against — an IP, an email, a session hash.
 *
 * A missing limiter always allows: the limiters are in-process, so a misbuilt
 * env must not lock everyone out of the app.
 */
export async function allowLoginAttempt(env: CloudflareEnv, request: Request): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	const ip = getClientIp(request);
	try {
		const outcome = await env.LOGIN_RATE_LIMIT.limit({ key: ip });
		return outcome.success;
	} catch (error) {
		console.warn("Login rate limiter unavailable", error);
		return true;
	}
}

/** True when the attempt is within budget for that bucket and key. */
export async function allowAttempt(
	env: CloudflareEnv,
	bucket: AuthRateLimitBucket,
	key: string,
): Promise<boolean> {
	const limiter = env.AUTH_RATE_LIMITS?.[bucket];
	if (!limiter) return true;
	try {
		const outcome = await limiter.limit({ key });
		return outcome.success;
	} catch (error) {
		console.warn(`Auth rate limiter "${bucket}" unavailable`, error);
		return true;
	}
}

/** The per-IP key every request-scoped bucket should use. */
export function rateLimitKeyForRequest(request: Request): string {
	return getClientIp(request);
}
