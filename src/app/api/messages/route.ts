import { NextResponse } from "next/server";
// ilike: SQLite's LIKE was case-insensitive; Postgres' LIKE is not.
import { eq, desc, and, ilike as like, or, count, isNull, inArray, lte, gt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { messages } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { getContactDisplayNameMap } from "@/lib/contacts/service";
import { normalizeEmailAddress } from "@/lib/email/address";
import { getMailboxAccessLevel, listAccessibleMailboxes } from "@/lib/mailboxes/access";

/**
 * List columns only.
 *
 * `text_body`/`html_body` are the two fat columns on `messages` and the list
 * never renders them: rows show the stored `snippet`. `raw_r2_key` and the
 * generated `search_vector` have no business in a response at all.
 */
const listColumns = {
	id: messages.id,
	organizationId: messages.organizationId,
	userId: messages.userId,
	mailboxId: messages.mailboxId,
	conversationId: messages.conversationId,
	direction: messages.direction,
	providerMessageId: messages.providerMessageId,
	folderId: messages.folderId,
	fromAddr: messages.fromAddr,
	toAddr: messages.toAddr,
	subject: messages.subject,
	snippet: messages.snippet,
	status: messages.status,
	read: messages.read,
	starred: messages.starred,
	snoozedUntil: messages.snoozedUntil,
	threadId: messages.threadId,
	createdAt: messages.createdAt,
};

/** Below this, `websearch_to_tsquery` has nothing useful to lex; fall back to LIKE. */
const FULL_TEXT_MIN_LENGTH = 3;

export const GET = withOrg(async ({ env, db, user, orgId, scoped }, request) => {
	const url = new URL(request.url);
	const direction = url.searchParams.get("direction");
	const mailboxId = url.searchParams.get("mailboxId");
	const folderId = url.searchParams.get("folderId");
	const status = url.searchParams.get("status");
	const query = url.searchParams.get("q")?.trim();
	const title = url.searchParams.get("title")?.trim();
	const read = url.searchParams.get("read");
	const starred = url.searchParams.get("starred");
	const snoozed = url.searchParams.get("snoozed");
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
	const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

	const accessibleMailboxes = await listAccessibleMailboxes(db, user, orgId);
	const accessibleMailboxIds = accessibleMailboxes.map((mailbox) => mailbox.id);
	const conditions: SQL[] = [];
	if (mailboxId) {
		const access = await getMailboxAccessLevel(db, user, mailboxId, orgId);
		if (!access?.canRead) {
			return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
		}
		conditions.push(eq(messages.mailboxId, mailboxId));
	} else if (accessibleMailboxIds.length > 0) {
		conditions.push(inArray(messages.mailboxId, accessibleMailboxIds));
	} else {
		conditions.push(eq(messages.userId, user.id));
	}
	if (direction === "inbound" || direction === "outbound") {
		conditions.push(eq(messages.direction, direction));
	}
	if (folderId) {
		conditions.push(eq(messages.folderId, folderId));
	}
	if (status) {
		conditions.push(eq(messages.status, status));
	}
	if (status === "received" && !folderId) {
		conditions.push(isNull(messages.folderId));
		conditions.push(or(isNull(messages.snoozedUntil), lte(messages.snoozedUntil, new Date()))!);
	}
	if (starred === "true") {
		conditions.push(eq(messages.starred, true));
	}
	if (snoozed === "true") {
		conditions.push(eq(messages.status, "received"));
		conditions.push(isNull(messages.folderId));
		conditions.push(gt(messages.snoozedUntil, new Date()));
	}
	if (read === "read") {
		conditions.push(eq(messages.read, true));
	}
	if (read === "unread") {
		conditions.push(eq(messages.read, false));
	}
	if (query) {
		if (query.length >= FULL_TEXT_MIN_LENGTH) {
			// `messages_search_idx` (GIN over the generated `search_vector`) covers
			// subject + participants + text body. Beats four unanchored ILIKEs.
			conditions.push(sql`${messages.searchVector} @@ websearch_to_tsquery('simple', ${query})`);
		} else {
			const pattern = `%${query}%`;
			const queryCondition = or(
				like(messages.fromAddr, pattern),
				like(messages.toAddr, pattern),
				like(messages.subject, pattern),
				like(messages.snippet, pattern),
			);
			if (queryCondition) conditions.push(queryCondition);
		}
	}
	if (title) {
		conditions.push(like(messages.subject, `%${title}%`));
	}
	// `scoped(messages)` is repeated at both call sites: the org filter has to be
	// visible inside each `.where(...)` (see eslint-rules/require-org-scope.js).
	const where = and(...conditions);

	const [totalRows, rows] = await Promise.all([
		db
			.select({ total: count() })
			.from(messages)
			.where(and(scoped(messages), where)),
		db
			.select(listColumns)
			.from(messages)
			.where(and(scoped(messages), where))
			.orderBy(desc(messages.createdAt))
			.limit(limit)
			.offset(offset),
	]);
	const totalRow = totalRows[0];
	const mailboxNameMap = new Map(
		accessibleMailboxes.map((mailbox) => [
			mailbox.id,
			mailbox.displayName ?? mailbox.localPart,
		]),
	);
	const contactMapsByUserId = new Map(
		await Promise.all(
			Array.from(new Set(rows.map((message) => message.userId))).map(async (userId) => [
				userId,
				await getContactDisplayNameMap(
					env,
					userId,
					rows
						.filter((message) => message.userId === userId)
						.flatMap((message) => [message.fromAddr, message.toAddr]),
				),
			] as const),
		),
	);
	const enrichedRows = rows.map((message) => {
		const contactMap = contactMapsByUserId.get(message.userId);
		const accountName = message.mailboxId ? mailboxNameMap.get(message.mailboxId) : null;
		return {
			...message,
			// Stored snippet only. A row written before snippets existed shows its
			// subject in the list instead; the bodies are not worth fetching here.
			snippet: message.snippet,
			fromContactName:
				(message.direction === "outbound" ? accountName : null) ??
				contactMap?.get(normalizeEmailAddress(message.fromAddr)) ??
				null,
			toContactName: contactMap?.get(normalizeEmailAddress(message.toAddr)) ?? null,
		};
	});

	return NextResponse.json({ messages: enrichedRows, total: totalRow?.total ?? 0, limit, offset });
});
