import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { assertAdmin } from "@/lib/auth/admin";
import { listInboundFailures } from "@/lib/inbound-failures/service";

// Inbound failures are an instance-level operations queue; `withOrg` supplies
// authentication and the suspended-organisation check, `assertAdmin` the
// permission check.
export const GET = withOrg(async ({ env, user }, request) => {
	try {
		assertAdmin(user);
		const includeResolved = new URL(request.url).searchParams.get("includeResolved") === "true";
		const failures = await listInboundFailures(env, { includeResolved });
		return NextResponse.json({ failures });
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
});
