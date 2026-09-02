/**
 * `POST /api/platform/impersonate/stop` — end an impersonation session.
 *
 * Called from inside the impersonated session, so it must not go through
 * `requirePlatformOperator` (that guard deliberately refuses impersonation
 * sessions). It deletes the session row and clears the cookie; the operator logs
 * in again to get back to the platform console.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, deleteSession, getUserFromSession } from "@/lib/auth/session";
import { getEnv } from "@/lib/cloudflare";

export async function POST() {
	const env = getEnv();
	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;
	if (!token) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const user = await getUserFromSession(env, token);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	if (!user.impersonatedByUserId) {
		return NextResponse.json({ error: "Not impersonating" }, { status: 400 });
	}

	await deleteSession(env, token);

	const response = NextResponse.json({ ok: true, redirect: "/login" });
	response.headers.set("Cache-Control", "no-store");
	response.cookies.set(SESSION_COOKIE, "", {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: 0,
	});
	return response;
}
