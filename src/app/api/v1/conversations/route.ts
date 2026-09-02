import { NextResponse } from "next/server";
import { listConversations } from "@/lib/conversations/service";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { conversationListQuerySchema } from "@/lib/validators";
import { v1Error, v1Route } from "../route-helpers";

/**
 * `GET /api/v1/conversations` — one page, newest activity first.
 *
 * Same query string and the same opaque `(last_message_at, id)` cursor as the
 * internal route: pass `nextCursor` back as `cursor`.
 */
export const GET = v1Route(
	async (ctx, request) => {
		const url = new URL(request.url);
		const parsed = conversationListQuerySchema.safeParse(
			Object.fromEntries([...url.searchParams.entries()].filter(([, value]) => value !== "")),
		);
		if (!parsed.success) return v1Error("Invalid query", 400, "invalid_query");
		const query = parsed.data;

		let mailboxIds: string[];
		if (query.mailboxId) {
			const access = await getMailboxAccessLevel(ctx.db, ctx.user, query.mailboxId, ctx.orgId);
			if (!access?.canRead) return v1Error("Mailbox not found", 404, "not_found");
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
	},
	{ requiredScope: "conversations:read" },
);
