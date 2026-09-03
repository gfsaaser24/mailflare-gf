/**
 * The one place an authenticated user becomes a session.
 *
 * Every entry point that proves identity — password login, register, magic link
 * — ends here, so the cookie flags, the session lifetime, the activity record
 * and the two-factor gate can never drift apart between routes.
 *
 * With TOTP enrolled the session is minted as `pending_two_factor`: the cookie
 * is set (the second step needs it) but `getUserFromSession()` refuses it, so
 * nothing in the app is reachable until `/api/auth/two-factor` promotes it. The
 * response shape for a user WITHOUT two-factor is unchanged.
 */
import { NextResponse } from "next/server";
import { recordAuthActivity } from "@/lib/auth/activity";
import { getClientIp } from "@/lib/http/ip";
import {
	createSession,
	PENDING_TWO_FACTOR_MS,
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth/session";

export type LoginMethod = "password" | "magic_link";

/** The bits of a user row `completeLogin` needs; the full row satisfies it. */
export type LoginUser = {
	id: string;
	totpEnabledAt: Date | null;
};

/** Applies the session cookie. Identical flags on every auth route. */
export function setSessionCookie(
	response: NextResponse,
	token: string,
	maxAgeSeconds: number,
): NextResponse {
	response.cookies.set(SESSION_COOKIE, token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: maxAgeSeconds,
	});
	return response;
}

export async function completeLogin(
	env: CloudflareEnv,
	request: Request,
	user: LoginUser,
	options: { method: LoginMethod },
): Promise<NextResponse> {
	const ipAddress = getClientIp(request);
	const userAgent = request.headers.get("user-agent") ?? undefined;

	if (user.totpEnabledAt) {
		// Half a session: enough to carry the user to the code prompt, nothing more.
		const token = await createSession(env, user.id, {
			expiresInMs: PENDING_TWO_FACTOR_MS,
			pendingTwoFactor: true,
			ipAddress,
			userAgent,
		});
		const response = NextResponse.json({
			ok: true,
			requiresTwoFactor: true,
			redirect: "/login/two-factor",
		});
		response.headers.set("Cache-Control", "no-store");
		return setSessionCookie(response, token, Math.floor(PENDING_TWO_FACTOR_MS / 1000));
	}

	const token = await createSession(env, user.id, { ipAddress, userAgent });
	await recordAuthActivity(env, {
		action: "auth.login",
		userId: user.id,
		request,
		details: { method: options.method },
	});
	// The token goes into the httpOnly cookie only; never into the body.
	const response = NextResponse.json({ ok: true, redirect: "/inbox" });
	response.headers.set("Cache-Control", "no-store");
	return setSessionCookie(response, token, SESSION_MAX_AGE_SECONDS);
}
