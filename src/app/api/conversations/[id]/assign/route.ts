import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { assignConversation } from "@/lib/conversations/service";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { assignConversationSchema } from "@/lib/validators";
import { requireConversationAccess, type ConversationRouteParams } from "../../access";

/** `POST /api/conversations/[id]/assign` — `{ userId }`, or `{ userId: null }` to unassign. */
export async function POST(request: Request, { params }: ConversationRouteParams) {
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
	const parsed = assignConversationSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid assignment" }, { status: 400 });
	}

	const db = getDb(env);
	const access = await requireConversationAccess(db, user, id, "send_on_behalf");
	if ("response" in access) return access.response;

	const assigneeId = parsed.data.userId;
	if (assigneeId) {
		const [assignee] = await db.select().from(users).where(eq(users.id, assigneeId)).limit(1);
		if (!assignee || assignee.disabled) {
			return NextResponse.json({ error: "User not found" }, { status: 404 });
		}
		// An assignee who cannot open the mailbox could never work the conversation.
		const assigneeAccess = await getMailboxAccessLevel(
			db,
			assignee,
			access.conversation.mailboxId,
		);
		if (!assigneeAccess?.canRead) {
			return NextResponse.json(
				{ error: "User has no access to this mailbox" },
				{ status: 400 },
			);
		}
	}

	const updated = await assignConversation(db, id, assigneeId);
	if (!updated) {
		return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	}
	return NextResponse.json({ conversation: updated });
}
