/**
 * "Sign out everywhere else": drops every session of the current user apart
 * from the one making the request.
 *
 * The survivor is picked by token hash, not by id, so the caller keeps exactly
 * the session it presented — there is no window where a request could revoke
 * itself and leave the user logged out of the device they are on.
 */
import { and, eq, ne } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sessions } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { recordAuthActivity } from "@/lib/auth/activity";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session";

export const POST = withOrg(async ({ env, db, user }, request) => {
	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;
	// withOrg authenticated this request from the cookie, so the token is there.
	if (!token) return NextResponse.json({ error: "No session cookie" }, { status: 401 });
	const currentHash = await hashSessionToken(token);

	const removed = await db
		.delete(sessions)
		.where(and(eq(sessions.userId, user.id), ne(sessions.tokenHash, currentHash)))
		.returning({ id: sessions.id });

	await recordAuthActivity(env, {
		action: "auth.sessions_revoked",
		userId: user.id,
		request,
		details: { revoked: removed.length, scope: "others" },
	});

	return NextResponse.json(
		{ ok: true, revoked: removed.length },
		{ headers: { "Cache-Control": "no-store" } },
	);
});
