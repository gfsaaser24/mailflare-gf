import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { messages } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { MessageStatusPayload } from "./types";
import { isAllowedMessageStatus } from "./utils";

export const POST = withOrg(
	async (
		{ env, db, user, orgId, scoped },
		request,
		{ params }: { params: Promise<{ messageId: string }> },
	) => {
		const { messageId } = await params;

		const payload = (await request.json()) as MessageStatusPayload;
		if (!isAllowedMessageStatus(payload.status)) {
			return NextResponse.json({ error: "Invalid message status" }, { status: 400 });
		}

		const [message] = await db
			.select({ id: messages.id, mailboxId: messages.mailboxId })
			.from(messages)
			.where(and(scoped(messages), eq(messages.id, messageId)))
			.limit(1);
		if (!message?.mailboxId) {
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}

		const access = await getMailboxAccessLevel(db, user, message.mailboxId, orgId);
		if (!access?.canManage) {
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}

		await db
			.update(messages)
			.set({
				status: payload.status,
				// Retention purges by time in trash, not by message age.
				trashedAt: payload.status === "trash" ? new Date() : null,
			})
			.where(and(scoped(messages), eq(messages.id, messageId)));
		await createAuditLog(env, {
			actorUserId: user.id,
			mailboxId: message.mailboxId,
			messageId,
			action: "email.delete",
			metadata: { status: payload.status },
		});

		return NextResponse.json({ success: true });
	},
);
