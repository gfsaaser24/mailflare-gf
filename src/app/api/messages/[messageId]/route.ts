import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { messages } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { getMessageWithBodyForUser } from "@/lib/email/inbound";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { deleteMessagesPermanently } from "@/lib/retention/service";

type MessageRouteParams = {
	params: Promise<{ messageId: string }>;
};

export const GET = withOrg(async (ctx, _request, { params }: MessageRouteParams) => {
	const { messageId } = await params;
	const data = await getMessageWithBodyForUser(ctx.env, ctx.user, messageId, ctx.orgId);
	if (!data) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	return NextResponse.json(data);
});

/**
 * Permanent delete. Not the same as `POST /status { status: "trash" }`, which
 * only moves the message: this removes the raw object, the attachments, the rows
 * and gives the bytes back, through the one delete path
 * (`deleteMessagesPermanently`).
 */
export const DELETE = withOrg(
	async ({ env, db, user, orgId, scoped }, _request, { params }: MessageRouteParams) => {
		const { messageId } = await params;

		const [message] = await db
			.select({ id: messages.id, mailboxId: messages.mailboxId, userId: messages.userId })
			.from(messages)
			.where(and(scoped(messages), eq(messages.id, messageId)))
			.limit(1);
		if (!message) {
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}

		if (message.mailboxId) {
			const access = await getMailboxAccessLevel(db, user, message.mailboxId, orgId);
			if (!access?.canManage) {
				return NextResponse.json({ error: "Message not found" }, { status: 404 });
			}
		} else if (message.userId !== user.id) {
			// A message with no mailbox (a draft) belongs to its author alone.
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}

		const counts = await deleteMessagesPermanently(env, orgId, [message.id]);
		await createAuditLog(env, {
			actorUserId: user.id,
			mailboxId: message.mailboxId,
			// The message row is gone, so it cannot be referenced; keep the id in metadata.
			messageId: null,
			action: "email.delete",
			metadata: { messageId: message.id, permanent: true, ...counts },
		});

		return NextResponse.json({ success: true, ...counts });
	},
);
