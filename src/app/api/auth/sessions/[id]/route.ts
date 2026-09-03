/**
 * Revokes one session of the current user.
 *
 * The `user_id` is part of the WHERE clause, so an id belonging to somebody
 * else deletes nothing and reads back as 404 — the caller cannot even learn
 * that the session exists.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { sessions } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";

type SessionRouteParams = { params: Promise<{ id: string }> };

export const DELETE = withOrg<SessionRouteParams>(async ({ db, user }, _request, { params }) => {
	const { id } = await params;
	const removed = await db
		.delete(sessions)
		.where(and(eq(sessions.id, id), eq(sessions.userId, user.id)))
		.returning({ id: sessions.id });

	if (removed.length === 0) {
		return NextResponse.json({ error: "Session not found" }, { status: 404 });
	}
	return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
});
