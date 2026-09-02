import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { users } from "@/db/schema";
import { assignConversation } from "@/lib/conversations/service";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { assignConversationSchema } from "@/lib/validators";
import { requireConversation } from "../../../access";
import { readV1Json, v1Error, v1Route, type IdRouteContext } from "../../../route-helpers";

/** `POST /api/v1/conversations/[id]/assign` — `{ userId }`, or `{ userId: null }` to unassign. */
export const POST = v1Route<IdRouteContext>(
	async (ctx, request, { params }) => {
		const { id } = await params;
		const { db, scoped } = ctx;

		const json = await readV1Json(request, 16 * 1024);
		if ("response" in json) return json.response;
		const parsed = assignConversationSchema.safeParse(json.body);
		if (!parsed.success) return v1Error("Invalid assignment", 400, "invalid_body");

		const access = await requireConversation(ctx, id, "send_on_behalf");
		if ("response" in access) return access.response;

		const assigneeId = parsed.data.userId;
		if (assigneeId) {
			// An assignee outside the organisation does not exist to this route.
			const [assignee] = await db
				.select()
				.from(users)
				.where(and(scoped(users), eq(users.id, assigneeId)))
				.limit(1);
			if (!assignee || assignee.disabled) return v1Error("User not found", 404, "not_found");

			// Someone who cannot open the mailbox could never work the conversation.
			const assigneeAccess = await getMailboxAccessLevel(
				db,
				assignee,
				access.conversation.mailboxId,
				ctx.orgId,
			);
			if (!assigneeAccess?.canRead) {
				return v1Error("User has no access to this mailbox", 400, "invalid_assignee");
			}
		}

		const updated = await assignConversation(db, id, assigneeId, ctx.orgId);
		if (!updated) return v1Error("Conversation not found", 404, "not_found");
		return NextResponse.json({ conversation: updated });
	},
	{ requiredScope: "conversations:write" },
);
