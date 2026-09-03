/**
 * The signed-in devices of the current user.
 *
 * Only the metadata is ever returned: `token_hash` (and of course the token) is
 * never selected, so this endpoint cannot become a session-stealing oracle. The
 * "current" flag is derived by hashing the caller's own cookie and comparing —
 * the same one-way function the session lookup uses.
 *
 * Sessions that are still `pending_two_factor` are hidden: they are half a
 * login, not a device, and they die on their own inside ten minutes.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sessions } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session";

export const GET = withOrg(async ({ db, user }) => {
	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;
	const currentHash = token ? await hashSessionToken(token) : null;

	const rows = await db
		.select({
			id: sessions.id,
			tokenHash: sessions.tokenHash,
			createdAt: sessions.createdAt,
			lastSeenAt: sessions.lastSeenAt,
			ipAddress: sessions.ipAddress,
			userAgent: sessions.userAgent,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.userId, user.id),
				eq(sessions.pendingTwoFactor, false),
				gt(sessions.expiresAt, new Date()),
			),
		)
		.orderBy(desc(sessions.createdAt));

	return NextResponse.json(
		{
			sessions: rows.map((row) => ({
				id: row.id,
				createdAt: row.createdAt,
				lastSeenAt: row.lastSeenAt,
				ipAddress: row.ipAddress,
				userAgent: row.userAgent,
				current: currentHash !== null && row.tokenHash === currentHash,
			})),
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
});
