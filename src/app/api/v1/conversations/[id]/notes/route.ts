import { NextResponse } from "next/server";
import { addConversationNote, listConversationNotes } from "@/lib/conversations/service";
import { conversationNoteSchema } from "@/lib/validators";
import { requireConversation } from "../../../access";
import { readV1Json, v1Error, v1Route, type IdRouteContext } from "../../../route-helpers";

/** `GET /api/v1/conversations/[id]/notes` — internal notes, oldest first. */
export const GET = v1Route<IdRouteContext>(
	async (ctx, _request, { params }) => {
		const { id } = await params;

		const access = await requireConversation(ctx, id, "read_only");
		if ("response" in access) return access.response;

		return NextResponse.json({ notes: await listConversationNotes(ctx.db, id, ctx.orgId) });
	},
	{ requiredScope: "conversations:read" },
);

/** `POST /api/v1/conversations/[id]/notes` — add an internal note. */
export const POST = v1Route<IdRouteContext>(
	async (ctx, request, { params }) => {
		const { id } = await params;

		const json = await readV1Json(request, 64 * 1024);
		if ("response" in json) return json.response;
		const parsed = conversationNoteSchema.safeParse(json.body);
		if (!parsed.success) return v1Error("Invalid note", 400, "invalid_body");

		const access = await requireConversation(ctx, id, "send_on_behalf");
		if ("response" in access) return access.response;

		const note = await addConversationNote(ctx.db, {
			conversationId: id,
			userId: ctx.user.id,
			body: parsed.data.body,
			orgId: ctx.orgId,
		});
		if (!note) return v1Error("Conversation not found", 404, "not_found");
		return NextResponse.json({ note }, { status: 201 });
	},
	{ requiredScope: "conversations:write" },
);
