import { NextResponse } from "next/server";
import { getConversationWithMessages } from "@/lib/conversations/service";
import { requireConversation } from "../../access";
import { v1Error, v1Route, type IdRouteContext } from "../../route-helpers";

/** `GET /api/v1/conversations/[id]` — the conversation with its messages and notes. */
export const GET = v1Route<IdRouteContext>(
	async (ctx, _request, { params }) => {
		const { id } = await params;

		const access = await requireConversation(ctx, id, "read_only");
		if ("response" in access) return access.response;

		const conversation = await getConversationWithMessages(ctx.db, id, ctx.orgId);
		if (!conversation) return v1Error("Conversation not found", 404, "not_found");
		return NextResponse.json({ conversation });
	},
	{ requiredScope: "conversations:read" },
);
