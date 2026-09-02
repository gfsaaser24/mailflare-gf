import { NextResponse } from "next/server";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { searchMessages } from "@/lib/search/service";
import { v1SearchQuerySchema } from "../schemas";
import { v1Error, v1Route } from "../route-helpers";

/**
 * `GET /api/v1/search?q=` — Postgres full-text search over the messages the
 * key's owner may read. Best match first; page with `cursor`.
 */
export const GET = v1Route(
	async (ctx, request) => {
		const url = new URL(request.url);
		const parsed = v1SearchQuerySchema.safeParse(
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

		const page = await searchMessages(
			ctx.db,
			ctx.orgId,
			mailboxIds,
			query.q,
			query.cursor ?? null,
			query.limit,
		);
		return NextResponse.json({ query: query.q, ...page });
	},
	{ requiredScope: "messages:read" },
);
