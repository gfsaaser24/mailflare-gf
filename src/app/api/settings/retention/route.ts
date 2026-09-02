import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { assertAdmin } from "@/lib/auth/admin";
import { getRetention, parseRetentionInput, setRetention } from "@/lib/retention/settings";

// `org_retention` is keyed by `organization_id` and is therefore not a
// `TENANT_TABLES` entry: `ctx.orgId` is the primary key of the row, which is all
// the scoping it needs. `withOrg` still gives us authentication, the
// suspended-org check and the organisation the settings belong to.

export const GET = withOrg(async ({ db, user, orgId }) => {
	try {
		assertAdmin(user);
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
	return NextResponse.json({ retention: await getRetention(db, orgId) });
});

export const PUT = withOrg(async ({ db, user, orgId }, request) => {
	try {
		assertAdmin(user);
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const input = parseRetentionInput(await request.json().catch(() => null));
	if (!input) {
		return NextResponse.json({ error: "Invalid retention settings" }, { status: 400 });
	}

	return NextResponse.json({ retention: await setRetention(db, orgId, input) });
});
