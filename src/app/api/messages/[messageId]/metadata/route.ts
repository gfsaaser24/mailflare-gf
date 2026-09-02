import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { getMessageMetadataForUser } from "@/lib/email/inbound";
import type { MessageMetadataRouteParams } from "./types";

export const GET = withOrg(async (ctx, _request, { params }: MessageMetadataRouteParams) => {
	const { messageId } = await params;
	const metadata = await getMessageMetadataForUser(ctx.env, ctx.user, messageId, ctx.orgId);
	if (!metadata) return NextResponse.json({ error: "Not found" }, { status: 404 });
	return NextResponse.json(metadata);
});
