import { and, desc, ilike, inArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { contacts } from "@/db/schema";
import {
	encodeConversationCursor,
	decodeConversationCursor,
} from "@/lib/conversations/service";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { v1ContactQuerySchema } from "../schemas";
import { v1Error, v1Route } from "../route-helpers";

const DEFAULT_LIMIT = 50;

/**
 * `GET /api/v1/contacts` — contacts of every mailbox owner the key's owner can
 * reach, newest first.
 *
 * Contacts hang off a user, not a mailbox, so the visible set is the owners of
 * the accessible mailboxes plus the caller. Paging reuses the conversation
 * cursor: base64url of `<iso created_at>|<id>`.
 */
export const GET = v1Route(
	async (ctx, request) => {
		const url = new URL(request.url);
		const parsed = v1ContactQuerySchema.safeParse(
			Object.fromEntries([...url.searchParams.entries()].filter(([, value]) => value !== "")),
		);
		if (!parsed.success) return v1Error("Invalid query", 400, "invalid_query");
		const query = parsed.data;
		const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), 100);

		const mailboxes = await listAccessibleMailboxes(ctx.db, ctx.user, ctx.orgId);
		const ownerIds = [...new Set([ctx.user.id, ...mailboxes.map((mailbox) => mailbox.userId)])];

		const conditions: SQL[] = [inArray(contacts.userId, ownerIds)];
		if (query.q) {
			const like = `%${query.q}%`;
			const match = or(ilike(contacts.email, like), ilike(contacts.displayName, like));
			if (match) conditions.push(match);
		}
		const cursor = decodeConversationCursor(query.cursor);
		if (cursor) {
			conditions.push(
				sql`(${contacts.createdAt}, ${contacts.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id})`,
			);
		}

		const rows = await ctx.db
			.select({
				id: contacts.id,
				email: contacts.email,
				displayName: contacts.displayName,
				source: contacts.source,
				blocked: contacts.blocked,
				lastSeenAt: contacts.lastSeenAt,
				createdAt: contacts.createdAt,
			})
			.from(contacts)
			.where(and(ctx.scoped(contacts), ...conditions))
			.orderBy(desc(contacts.createdAt), desc(contacts.id))
			.limit(limit + 1);

		const page = rows.slice(0, limit);
		const last = page.at(-1);
		const nextCursor =
			rows.length > limit && last ? encodeConversationCursor(last.createdAt, last.id) : null;

		return NextResponse.json({ contacts: page, nextCursor, limit });
	},
	{ requiredScope: "contacts:read" },
);
