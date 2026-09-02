import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { addConversationNote, listConversationNotes } from "@/lib/conversations/service";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { conversationNoteSchema } from "@/lib/validators";
import { requireConversationAccess, type ConversationRouteParams } from "../../access";

/** `GET /api/conversations/[id]/notes` — internal notes, oldest first. */
export const GET = withOrg(async (ctx, _request, { params }: ConversationRouteParams) => {
	const { id } = await params;

	const access = await requireConversationAccess(ctx, id, "read_only");
	if ("response" in access) return access.response;

	return NextResponse.json({ notes: await listConversationNotes(ctx.db, id, ctx.orgId) });
});

/** `POST /api/conversations/[id]/notes` — add an internal note. */
export const POST = withOrg(async (ctx, request, { params }: ConversationRouteParams) => {
	const { id } = await params;

	let body: unknown;
	try {
		body = await readJsonBody<unknown>(request, 64 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid request body" }, { status });
	}
	const parsed = conversationNoteSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid note" }, { status: 400 });
	}

	const access = await requireConversationAccess(ctx, id, "send_on_behalf");
	if ("response" in access) return access.response;

	const note = await addConversationNote(ctx.db, {
		conversationId: id,
		userId: ctx.user.id,
		body: parsed.data.body,
		orgId: ctx.orgId,
	});
	if (!note) {
		return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	}
	return NextResponse.json({ note }, { status: 201 });
});
