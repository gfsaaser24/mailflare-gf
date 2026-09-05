import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";
import { enforceTwoFactorPolicy } from "@/lib/auth/two-factor-policy";

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

/** The user row a route gets once it is past authentication and the 2FA gate. */
export type RouteUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/**
 * Either the caller, or the response the route must return instead.
 * `ok: false` covers both 401 (anonymous) and 403 (`two_factor_required`).
 */
export type RouteAuth = { ok: true; user: RouteUser } | { ok: false; response: NextResponse };

/**
 * The door for an API route that resolves its own cookie session instead of
 * going through `withOrg()`.
 *
 * `requireUser()` threw a bare `Error` on an anonymous request, which the App
 * Router turned into a 500, and it skipped the organisation's two-factor policy
 * entirely — that gate used to live only inside `withOrg()`. This returns a
 * proper 401 and runs the same shared gate, so the policy cannot be bypassed by
 * picking a different authentication helper.
 *
 *   const auth = await requireUserForRoute(env, request);
 *   if (!auth.ok) return auth.response;
 *   // auth.user is the caller
 *
 * Prefer `withOrg()` for anything that touches tenant tables; this exists for
 * the routes that legitimately do not need an org-scoped context.
 */
export async function requireUserForRoute(
	env: CloudflareEnv,
	request: Request,
): Promise<RouteAuth> {
	const user = await getCurrentUser(env, request);
	if (!user) {
		return {
			ok: false,
			response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
		};
	}
	const gated = await enforceTwoFactorPolicy(env, user, request);
	if (gated) return { ok: false, response: gated };
	return { ok: true, user };
}
