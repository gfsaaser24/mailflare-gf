import { NextResponse } from "next/server";
import { withOrg, type RouteContext } from "@/lib/api/with-org";
import { getDomainDns, getDomainForUser } from "@/lib/domains/service";

type Params = RouteContext<{ id: string }>;

export const GET = withOrg<Params>(async ({ env, user, orgId }, _request, { params }) => {
	const { id } = await params;
	const domain = await getDomainForUser(env, orgId, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });

	try {
		const dns = await getDomainDns(env, domain);
		return NextResponse.json({ domain, dns });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to fetch DNS";
		return NextResponse.json({ error: message }, { status: 500 });
	}
});
