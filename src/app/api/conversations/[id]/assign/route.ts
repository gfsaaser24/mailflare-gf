import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { assignConversation } from "@/lib/conversations/service";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { assignConversationSchema } from "@/lib/validators";
import { requireConversationAccess, type ConversationRouteParams } from "../../access";

/** `POST /api/conversations/[id]/assign` — `{ userId }`, or `{ userId: null }` to unassign. */
export const POST = withOrg(async (ctx, request, { params }: ConversationRouteParams) => {
	const { id } = await params;
	const { db, scoped } = ctx;

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

	const access = await requireConversationAccess(ctx, id, "send_on_behalf");
	if ("response" in access) return access.response;

	const assigneeId = parsed.data.userId;
	if (assigneeId) {
		// An assignee outside the organisation does not exist as far as this route is concerned.
		const [assignee] = await db
			.select()
			.from(users)
			.where(and(scoped(users), eq(users.id, assigneeId)))
			.limit(1);
		if (!assignee || assignee.disabled) {
			return NextResponse.json({ error: "User not found" }, { status: 404 });
		}
		// An assignee who cannot open the mailbox could never work the conversation.
		const assigneeAccess = await getMailboxAccessLevel(
			db,
			assignee,
			access.conversation.mailboxId,
			ctx.orgId,
		);
		if (!assigneeAccess?.canRead) {
			return NextResponse.json(
				{ error: "User has no access to this mailbox" },
				{ status: 400 },
			);
		}
	}

	const updated = await assignConversation(db, id, assigneeId, ctx.orgId);
	if (!updated) {
		return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
	}
	return NextResponse.json({ conversation: updated });
});
