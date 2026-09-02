import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import {
	getConversationWithMessages,
	updateConversationStatus,
} from "@/lib/conversations/service";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { updateConversationSchema } from "@/lib/validators";
import { requireConversationAccess, type ConversationRouteParams } from "../access";

/** `GET /api/conversations/[id]` — the conversation with its messages and notes. */
export async function GET(request: Request, { params }: ConversationRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const db = getDb(env);
	const access = await requireConversationAccess(db, user, id, "read_only");
	if ("response" in access) return access.response;

	const conversation = await getConversationWithMessages(db, id);
	if (!conversation) {
		return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	}
	return NextResponse.json({ conversation });
}

/** `PATCH /api/conversations/[id]` — change status and/or the snooze time. */
export async function PATCH(request: Request, { params }: ConversationRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

	const db = getDb(env);
	const access = await requireConversationAccess(db, user, id, "send_on_behalf");
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

	const updated = await updateConversationStatus(db, id, {
		status: parsed.data.status,
		snoozedUntil,
	});
	if (!updated) {
		return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	}
	return NextResponse.json({ conversation: updated });
}
