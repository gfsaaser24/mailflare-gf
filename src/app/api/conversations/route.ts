import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { listConversations } from "@/lib/conversations/service";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { conversationListQuerySchema } from "@/lib/validators";

/**
 * `GET /api/conversations` — one page of conversations, newest activity first.
 *
 * Without `mailboxId` the page spans every mailbox the caller can read.
 * Paging is keyset-based on `(last_message_at, id)`; pass back `nextCursor`.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

	const db = getDb(env);
	let mailboxIds: string[];
	if (query.mailboxId) {
		const access = await getMailboxAccessLevel(db, user, query.mailboxId);
		if (!access?.canRead) {
			return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		}
		mailboxIds = [query.mailboxId];
	} else {
		mailboxIds = await listAccessibleMailboxIds(db, user);
	}

	const page = await listConversations(db, {
		mailboxIds,
		status: query.status ?? null,
		assignedUserId: query.assignedUserId ?? null,
		q: query.q ?? null,
		cursor: query.cursor ?? null,
		limit: query.limit,
	});

	return NextResponse.json(page);
}
