import { cookies } from "next/headers";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";

/**
 * Session authentication is cookie-only. `Authorization: Bearer` is reserved for
 * API keys (see `src/lib/api/auth.ts`) and is deliberately ignored here, so an
 * XSS that can forge headers still cannot present a stolen session token.
 *
 * `_request` is kept so existing callers (`getCurrentUser(env, request)`) compile.
 */
export async function getCurrentUser(env: CloudflareEnv, _request?: Request) {
	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;
	const user = await getUserFromSession(env, token);
	return user?.disabled ? null : user;
}

export async function requireUser(env: CloudflareEnv, request?: Request) {
	const user = await getCurrentUser(env, request);
	if (!user) throw new Error("Unauthorized");
	return user;
}
