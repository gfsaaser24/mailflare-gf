/**
 * `requirePlatformOperator()` — the only door into `/api/platform/**`.
 *
 * Decision D2: a platform operator is a row in `platform_operators`, never a
 * `users.role` value. Nothing else in the codebase may read that table, and no
 * platform route may go through `withOrg()`: `withOrg()` pins every query to the
 * caller's own organisation, which is exactly the opposite of what the platform
 * plane needs.
 *
 * Auth is **cookie session only**. API keys are deliberately refused: a leaked
 * key must never be able to reach across organisations or mint an impersonation
 * session.
 *
 *   export const GET = async (request: Request) => {
 *     const guard = await requirePlatformOperator(request);
 *     if (guard instanceof Response) return guard;
 *     const { db, user } = guard;
 *     ...
 *   };
 */
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb, type AppDatabase } from "@/db";
import { platformOperators } from "@/db/schema";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/types";
import { getEnv } from "@/lib/cloudflare";

export type PlatformContext = {
	env: AppEnv;
	db: AppDatabase;
	/** The operator. Their own `organizationId` is irrelevant on this plane. */
	user: SessionUser;
};

/** True when the user is a platform operator. */
export async function isPlatformOperator(db: AppDatabase, userId: string): Promise<boolean> {
	const [row] = await db
		.select({ userId: platformOperators.userId })
		.from(platformOperators)
		.where(eq(platformOperators.userId, userId))
		.limit(1);
	return row !== undefined;
}

/**
 * Returns the platform context, or a `Response` (401 unauthenticated, 403 not an
 * operator) that the route must return as-is.
 */
export async function requirePlatformOperator(
	_request?: Request,
): Promise<PlatformContext | Response> {
	const env = getEnv();
	const db = getDb(env);

	const jar = await cookies();
	const user = await getUserFromSession(env, jar.get(SESSION_COOKIE)?.value);
	// Disabled accounts are unauthenticated, never merely forbidden.
	if (!user || user.disabled) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	// An impersonation session must not be able to re-enter the platform plane.
	if (user.impersonatedByUserId) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
	if (!(await isPlatformOperator(db, user.id))) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	return { env, db, user };
}
