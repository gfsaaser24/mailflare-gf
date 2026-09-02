import { NextResponse } from "next/server";
import { withOrg, type RouteContext } from "@/lib/api/with-org";
import { assertAdmin } from "@/lib/auth/admin";
import { retryInboundFailure } from "@/lib/inbound-failures/service";

export const POST = withOrg<RouteContext<{ id: string }>>(
	async ({ env, user }, _request, { params }) => {
		try {
			assertAdmin(user);
			const { id } = await params;
			const result = await retryInboundFailure(env, id);
			if (result.status === "not_found") {
				return NextResponse.json({ error: "Inbound failure not found" }, { status: 404 });
			}
			if (result.status === "failed") {
				return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
			}
			return NextResponse.json({ ok: true });
		} catch {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}
	},
);
