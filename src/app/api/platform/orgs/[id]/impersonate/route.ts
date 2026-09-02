/**
 * `POST /api/platform/orgs/[id]/impersonate` — become the organisation's first
 * admin for one hour.
 *
 * The session it mints carries `impersonated_by_user_id` (the operator) and
 * expires after `IMPERSONATION_TTL_MS`; an audit row `platform.impersonate` is
 * written against the target organisation. The cookie replaces the operator's
 * own session, so `POST /api/platform/impersonate/stop` is the way back.
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { requirePlatformOperator } from "@/lib/platform/guard";
import {
	IMPERSONATION_TTL_MS,
	impersonateOrganization,
	NoOrganizationAdminError,
} from "@/lib/platform/service";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
	const guard = await requirePlatformOperator(request);
	if (guard instanceof Response) return guard;

	const { id } = await context.params;

	let result: Awaited<ReturnType<typeof impersonateOrganization>>;
	try {
		result = await impersonateOrganization(guard.env, guard.db, id, guard.user.id);
	} catch (error) {
		if (error instanceof NoOrganizationAdminError) {
			return NextResponse.json({ error: error.message }, { status: 409 });
		}
		throw error;
	}
	if (!result) {
		return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
	}

	const response = NextResponse.json({
		ok: true,
		organizationId: result.organizationId,
		targetUserId: result.targetUserId,
		expiresAt: result.expiresAt.toISOString(),
		redirect: "/inbox",
	});
	response.headers.set("Cache-Control", "no-store");
	// Same cookie shape as the login route; only the lifetime differs.
	response.cookies.set(SESSION_COOKIE, result.token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: IMPERSONATION_TTL_MS / 1000,
	});
	return response;
}
