import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { addConversationNote, listConversationNotes } from "@/lib/conversations/service";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { conversationNoteSchema } from "@/lib/validators";
import { requireConversationAccess, type ConversationRouteParams } from "../../access";

/** `GET /api/conversations/[id]/notes` — internal notes, oldest first. */
export async function GET(request: Request, { params }: ConversationRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const db = getDb(env);
	const access = await requireConversationAccess(db, user, id, "read_only");
	if ("response" in access) return access.response;

	return NextResponse.json({ notes: await listConversationNotes(db, id) });
}

/** `POST /api/conversations/[id]/notes` — add an internal note. */
export async function POST(request: Request, { params }: ConversationRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

	const db = getDb(env);
	const access = await requireConversationAccess(db, user, id, "send_on_behalf");
	if ("response" in access) return access.response;

	const note = await addConversationNote(db, {
		conversationId: id,
		userId: user.id,
		body: parsed.data.body,
	});
	return NextResponse.json({ note }, { status: 201 });
}
