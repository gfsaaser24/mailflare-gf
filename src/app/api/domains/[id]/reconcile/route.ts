import { NextResponse } from "next/server";
import { withOrg, type RouteContext } from "@/lib/api/with-org";
import { getDomainForUser } from "@/lib/domains/service";
import { reconcileDomain } from "@/lib/domains/status";

type Params = RouteContext<{ id: string }>;

/** Explicit "check now": re-reads live Cloudflare state and rewrites the row. */
export const POST = withOrg<Params>(async ({ env, user, orgId }, _request, { params }) => {
	const { id } = await params;
	const owned = await getDomainForUser(env, orgId, user.id, id);
	if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

	try {
		const result = await reconcileDomain(env, owned.id, orgId);
		const domain = await getDomainForUser(env, orgId, user.id, id);
		return NextResponse.json({ domain, result });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to reconcile domain";
		return NextResponse.json({ error: message }, { status: 500 });
	}
});
