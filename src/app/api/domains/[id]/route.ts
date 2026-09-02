import { NextResponse } from "next/server";
import { withOrg, type RouteContext } from "@/lib/api/with-org";
import { getDomainForUser, removeDomainForUser } from "@/lib/domains/service";

type Params = RouteContext<{ id: string }>;

export const GET = withOrg<Params>(async ({ env, user, orgId }, _request, { params }) => {
	const { id } = await params;
	const domain = await getDomainForUser(env, orgId, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	return NextResponse.json({ domain });
});

export const DELETE = withOrg<Params>(async ({ env, user, orgId }, _request, { params }) => {
	const { id } = await params;
	try {
		await removeDomainForUser(env, orgId, user.id, id);
		return NextResponse.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to remove domain";
		return NextResponse.json({ error: message }, { status: 400 });
	}
});
