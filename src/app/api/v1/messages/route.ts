import { NextResponse } from "next/server";
import { eq, desc, and, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { messages } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";

export const GET = withOrg(
	async ({ db, user, orgId, scoped }, request) => {
		const url = new URL(request.url);
		const mailboxId = url.searchParams.get("mailboxId");
		const direction = url.searchParams.get("direction");
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);

		const conditions: SQL[] = [];
		if (mailboxId) {
			const access = await getMailboxAccessLevel(db, user, mailboxId, orgId);
			if (!access?.canRead) {
				return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
			}
			conditions.push(eq(messages.mailboxId, mailboxId));
		} else {
			const accessibleMailboxIds = await listAccessibleMailboxIds(db, user, orgId);
			if (accessibleMailboxIds.length > 0) {
				conditions.push(inArray(messages.mailboxId, accessibleMailboxIds));
			} else {
				conditions.push(eq(messages.userId, user.id));
			}
		}
		if (direction === "inbound" || direction === "outbound") {
			conditions.push(eq(messages.direction, direction));
		}

		// Explicit columns: `messages.search_vector` is a generated FTS column and
		// has no business in an API response.
		const rows = await db
			.select({
				id: messages.id,
				organizationId: messages.organizationId,
				userId: messages.userId,
				mailboxId: messages.mailboxId,
				direction: messages.direction,
				providerMessageId: messages.providerMessageId,
				folderId: messages.folderId,
				fromAddr: messages.fromAddr,
				toAddr: messages.toAddr,
				subject: messages.subject,
				snippet: messages.snippet,
				textBody: messages.textBody,
				htmlBody: messages.htmlBody,
				rawR2Key: messages.rawR2Key,
				status: messages.status,
				read: messages.read,
				starred: messages.starred,
				snoozedUntil: messages.snoozedUntil,
				threadId: messages.threadId,
				conversationId: messages.conversationId,
				inReplyTo: messages.inReplyTo,
				referencesHeader: messages.referencesHeader,
				createdAt: messages.createdAt,
			})
			.from(messages)
			.where(and(scoped(messages), ...conditions))
			.orderBy(desc(messages.createdAt))
			.limit(limit);

		return NextResponse.json({ messages: rows });
	},
	{ allowApiKey: true, requiredScope: "messages:read" },
);
