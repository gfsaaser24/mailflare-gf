import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { getMessageWithBodyForUser } from "@/lib/email/inbound";

type MessageRouteParams = {
	params: Promise<{ messageId: string }>;
};

export const GET = withOrg(async (ctx, _request, { params }: MessageRouteParams) => {
	const { messageId } = await params;
	const data = await getMessageWithBodyForUser(ctx.env, ctx.user, messageId, ctx.orgId);
	if (!data) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	return NextResponse.json(data);
});
