import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { listConversations } from "@/lib/conversations/service";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { conversationListQuerySchema } from "@/lib/validators";

/**
 * `GET /api/conversations` — one page of conversations, newest activity first.
 *
 * Without `mailboxId` the page spans every mailbox the caller can read.
 * Paging is keyset-based on `(last_message_at, id)`; pass back `nextCursor`.
 */
export const GET = withOrg(async (ctx, request) => {
	const url = new URL(request.url);
	const parsed = conversationListQuerySchema.safeParse(
		Object.fromEntries(
			[...url.searchParams.entries()].filter(([, value]) => value !== ""),
		),
	);
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid query" }, { status: 400 });
	}
	const query = parsed.data;

	let mailboxIds: string[];
	if (query.mailboxId) {
		const access = await getMailboxAccessLevel(ctx.db, ctx.user, query.mailboxId, ctx.orgId);
		if (!access?.canRead) {
			return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		}
		mailboxIds = [query.mailboxId];
	} else {
		mailboxIds = await listAccessibleMailboxIds(ctx.db, ctx.user, ctx.orgId);
	}

	const page = await listConversations(ctx.db, {
		orgId: ctx.orgId,
		mailboxIds,
		status: query.status ?? null,
		assignedUserId: query.assignedUserId ?? null,
		q: query.q ?? null,
		cursor: query.cursor ?? null,
		limit: query.limit,
	});

	return NextResponse.json(page);
});
