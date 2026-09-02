import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { messages } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

export const POST = withOrg(
	async (
		{ db, user, orgId, scoped },
		_request,
		{ params }: { params: Promise<{ messageId: string }> },
	) => {
		const { messageId } = await params;

		const [message] = await db
			.select({ id: messages.id, mailboxId: messages.mailboxId, starred: messages.starred })
			.from(messages)
			.where(and(scoped(messages), eq(messages.id, messageId)))
			.limit(1);
		if (!message?.mailboxId) {
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}

		const access = await getMailboxAccessLevel(db, user, message.mailboxId, orgId);
		if (!access?.canRead) {
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}

		const starred = !message.starred;
		await db
			.update(messages)
			.set({ starred })
			.where(and(scoped(messages), eq(messages.id, message.id)));
		return NextResponse.json({ starred });
	},
);
