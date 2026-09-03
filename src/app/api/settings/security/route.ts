/**
 * `/api/settings/security` — the organisation-wide two-factor policy.
 *
 * `organizations` is not a `TENANT_TABLES` entry: `ctx.orgId` IS the primary key
 * of the row, which is all the scoping this needs (same shape as
 * `/api/settings/retention`).
 *
 * GET is on the enrolment allowlist in `withOrg()`, so an admin who is not yet
 * enrolled can still read the policy while the settings panel walks them
 * through setting it up. PATCH is not: turning the requirement on is only
 * possible from an account that already has an authenticator paired, otherwise
 * an admin could lock themselves out of their own organisation.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { organizations, users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { isAdmin } from "@/lib/auth/admin";
import { organizationRequiresTwoFactor } from "@/lib/auth/totp";
import { readJsonBody } from "@/lib/http/request";

function forbidden(): NextResponse {
	return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export const GET = withOrg(async ({ db, user, orgId }) => {
	if (!isAdmin(user)) return forbidden();
	const response = NextResponse.json({
		requireTwoFactor: await organizationRequiresTwoFactor(db, orgId),
	});
	response.headers.set("Cache-Control", "no-store");
	return response;
});

export const PATCH = withOrg(async ({ db, user, orgId, scoped }, request) => {
	if (!isAdmin(user)) return forbidden();

	let body: { requireTwoFactor?: unknown };
	try {
		body = await readJsonBody<{ requireTwoFactor?: unknown }>(request, 1024);
	} catch {
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}
	if (typeof body.requireTwoFactor !== "boolean") {
		return NextResponse.json({ error: "requireTwoFactor must be true or false" }, { status: 400 });
	}

	if (body.requireTwoFactor) {
		const [row] = await db
			.select({ totpEnabledAt: users.totpEnabledAt })
			.from(users)
			.where(and(scoped(users), eq(users.id, user.id)))
			.limit(1);
		if (!row?.totpEnabledAt) {
			return NextResponse.json(
				{
					error:
						"Set up two-factor authentication on your own account before you require it for everyone.",
				},
				{ status: 400 },
			);
		}
	}

	await db
		.update(organizations)
		.set({ requireTwoFactor: body.requireTwoFactor })
		.where(eq(organizations.id, orgId));

	const response = NextResponse.json({ requireTwoFactor: body.requireTwoFactor });
	response.headers.set("Cache-Control", "no-store");
	return response;
});
