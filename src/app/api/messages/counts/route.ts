import { and, eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { messages } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { buildMessageCounts } from "./utils";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";

export const GET = withOrg(async ({ db, user, orgId, scoped }, request) => {
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const conditions: SQL[] = [];

	if (mailboxId) {
		const access = await getMailboxAccessLevel(db, user, mailboxId, orgId);
		if (!access?.canRead) {
			return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		}
		conditions.push(eq(messages.mailboxId, mailboxId));
	} else {
		const accessibleMailboxIds = await listAccessibleMailboxIds(db, user);
		if (accessibleMailboxIds.length > 0) {
			conditions.push(inArray(messages.mailboxId, accessibleMailboxIds));
		} else {
			conditions.push(eq(messages.userId, user.id));
		}
	}

	const rows = await db
		.select({
			mailboxId: messages.mailboxId,
			folderId: messages.folderId,
			direction: messages.direction,
			status: messages.status,
			read: messages.read,
			starred: messages.starred,
			snoozedUntil: messages.snoozedUntil,
		})
		.from(messages)
		.where(and(scoped(messages), ...conditions));

	return NextResponse.json({ counts: buildMessageCounts(rows) });
});
