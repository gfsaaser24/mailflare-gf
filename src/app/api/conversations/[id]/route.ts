import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import {
	getConversationWithMessages,
	updateConversationStatus,
} from "@/lib/conversations/service";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { updateConversationSchema } from "@/lib/validators";
import { requireConversationAccess, type ConversationRouteParams } from "../access";

/** `GET /api/conversations/[id]` — the conversation with its messages and notes. */
export const GET = withOrg(async (ctx, _request, { params }: ConversationRouteParams) => {
	const { id } = await params;

	const access = await requireConversationAccess(ctx, id, "read_only");
	if ("response" in access) return access.response;

	const conversation = await getConversationWithMessages(ctx.db, id, ctx.orgId);
	if (!conversation) {
		return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	}
	return NextResponse.json({ conversation });
});

/** `PATCH /api/conversations/[id]` — change status and/or the snooze time. */
export const PATCH = withOrg(async (ctx, request, { params }: ConversationRouteParams) => {
	const { id } = await params;

	let body: unknown;
	try {
		body = await readJsonBody<unknown>(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid request body" }, { status });
	}
	const parsed = updateConversationSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid conversation update" }, { status: 400 });
	}

	const access = await requireConversationAccess(ctx, id, "send_on_behalf");
	if ("response" in access) return access.response;

	const snoozedUntil =
		parsed.data.snoozedUntil === undefined
			? undefined
			: parsed.data.snoozedUntil === null
				? null
				: new Date(parsed.data.snoozedUntil);
	if (snoozedUntil instanceof Date && Number.isNaN(snoozedUntil.getTime())) {
		return NextResponse.json({ error: "Invalid snoozedUntil" }, { status: 400 });
	}

	const updated = await updateConversationStatus(
		ctx.db,
		id,
		{ status: parsed.data.status, snoozedUntil },
		ctx.orgId,
	);
	if (!updated) {
		return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	}
	return NextResponse.json({ conversation: updated });
});
