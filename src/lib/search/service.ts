/**
 * T6.2 — Postgres full-text search over `messages`.
 *
 * ---------------------------------------------------------------------------
 * MIGRATION SQL — copy this verbatim into the combined migration for this wave.
 * ---------------------------------------------------------------------------
 * drizzle-kit cannot express a generated column, so `messages.search_vector`
 * has to be written by hand. `src/db/schema/index.ts` only declares the column
 * and its GIN index so the rest of the app can read them.
 *
 *   ALTER TABLE messages ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(subject,'') || ' ' || coalesce(from_addr,'') || ' ' || coalesce(to_addr,'') || ' ' || coalesce(text_body,''))) STORED;
 *   CREATE INDEX messages_search_idx ON messages USING gin (search_vector);
 *
 * Until that migration exists, the test suite applies the same two statements
 * itself (`tests/helpers/search-column.ts`), guarded so re-running is a no-op.
 * ---------------------------------------------------------------------------
 *
 * `simple` (not `english`) is deliberate: mail is multilingual and full of
 * addresses and identifiers, so stemming loses more than it gains, and the same
 * dictionary must be used by the generated column and by the query.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";

export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_DEFAULT_LIMIT = 25;

export type SearchHit = {
	id: string;
	mailboxId: string | null;
	conversationId: string | null;
	direction: "inbound" | "outbound";
	from: string;
	to: string;
	subject: string | null;
	snippet: string | null;
	createdAt: Date;
	/** `ts_rank` of the hit; higher is a better match. */
	rank: number;
};

export type SearchPage = {
	hits: SearchHit[];
	nextCursor: string | null;
	limit: number;
};

export type SearchCursor = { rank: number; at: Date; id: string };

/**
 * Opaque page token: base64 of `<rank>|<iso created_at>|<id>`.
 *
 * Same shape as the conversation cursor in `src/lib/conversations/service.ts`
 * (base64url of the sort key plus the row id), with the rank in front because
 * that is the primary sort key here.
 */
export function encodeSearchCursor(rank: number, at: Date, id: string): string {
	return Buffer.from(`${rank}|${at.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeSearchCursor(value: string | null | undefined): SearchCursor | null {
	if (!value) return null;
	let decoded: string;
	try {
		decoded = Buffer.from(value, "base64url").toString("utf8");
	} catch {
		return null;
	}
	const first = decoded.indexOf("|");
	const last = decoded.lastIndexOf("|");
	if (first <= 0 || last <= first) return null;
	const rank = Number(decoded.slice(0, first));
	const at = new Date(decoded.slice(first + 1, last));
	const id = decoded.slice(last + 1);
	if (!Number.isFinite(rank) || Number.isNaN(at.getTime()) || !id) return null;
	return { rank, at, id };
}

/**
 * One page of messages matching `q`, best match first.
 *
 * `mailboxIds` is the set the caller may read; an empty list yields an empty
 * page rather than every mailbox. `orgId` is applied on top, so a mailbox id
 * from another organisation can never widen the result.
 */
export async function searchMessages(
	db: AppDatabase,
	orgId: string,
	mailboxIds: string[],
	q: string,
	cursor?: string | null,
	limit?: number,
): Promise<SearchPage> {
	const pageSize = Math.min(Math.max(limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
	const terms = q.trim();
	if (terms.length === 0 || mailboxIds.length === 0) {
		return { hits: [], nextCursor: null, limit: pageSize };
	}

	const query = sql`websearch_to_tsquery('simple', ${terms})`;
	const rank = sql<number>`ts_rank(${messages.searchVector}, ${query})`;

	const conditions: SQL[] = [
		eq(messages.organizationId, orgId),
		inArray(messages.mailboxId, mailboxIds),
		sql`${messages.searchVector} @@ ${query}`,
	];
	const from = decodeSearchCursor(cursor);
	if (from) {
		// Row-value keyset: stable when several hits share a rank or a timestamp.
		conditions.push(
			sql`(${rank}, ${messages.createdAt}, ${messages.id}) < (${from.rank}::real, ${from.at.toISOString()}::timestamptz, ${from.id})`,
		);
	}

	const rows = await db
		.select({
			id: messages.id,
			mailboxId: messages.mailboxId,
			conversationId: messages.conversationId,
			direction: messages.direction,
			fromAddr: messages.fromAddr,
			toAddr: messages.toAddr,
			subject: messages.subject,
			snippet: messages.snippet,
			createdAt: messages.createdAt,
			rank: rank.mapWith(Number),
		})
		.from(messages)
		.where(and(...conditions))
		.orderBy(sql`${rank} desc`, sql`${messages.createdAt} desc`, sql`${messages.id} desc`)
		.limit(pageSize + 1);

	const page = rows.slice(0, pageSize);
	const last = page.at(-1);
	const nextCursor =
		rows.length > pageSize && last ? encodeSearchCursor(last.rank, last.createdAt, last.id) : null;

	return {
		hits: page.map((row) => ({
			id: row.id,
			mailboxId: row.mailboxId,
			conversationId: row.conversationId,
			direction: row.direction,
			from: row.fromAddr,
			to: row.toAddr,
			subject: row.subject,
			snippet: row.snippet,
			createdAt: row.createdAt,
			rank: row.rank,
		})),
		nextCursor,
		limit: pageSize,
	};
}
