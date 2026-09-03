import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { conversationNotes, conversations, messages, users } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { newId } from "@/lib/ids";
import { emitWebhookEvent } from "@/lib/webhooks/dispatch";

/** How far back a subject+participant match is still considered the same conversation. */
export const SUBJECT_MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Strips any number of leading reply/forward prefixes and folds case/whitespace.
 * Must stay in step with the SQL in the `conversations` backfill migration.
 */
export function normalizeSubject(subject: string | null | undefined): string {
	if (!subject) return "";
	return subject
		.trim()
		.replace(/^((re|fw|fwd)\s*:\s*)+/i, "")
		.trim()
		.toLowerCase();
}

/** Splits an In-Reply-To/References header value into individual `<message-id>` tokens. */
export function parseMessageIdList(value: string | null | undefined): string[] {
	if (!value) return [];
	const found = value.match(/<[^<>\s]+>/g);
	if (found) return dedupe(found);
	// Some senders omit the angle brackets; fall back to whitespace splitting.
	return dedupe(
		value
			.split(/\s+/)
			.map((token) => token.trim())
			.filter(Boolean),
	);
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

/** Every address that identifies a party to a message, lowercased and bare. */
function participantsOf(...addresses: Array<string | null | undefined>): string[] {
	const list: string[] = [];
	for (const address of addresses) {
		for (const part of (address ?? "").split(",")) {
			const bare = getEmailAddress(part).trim().toLowerCase();
			if (bare) list.push(bare);
		}
	}
	return dedupe(list);
}

/**
 * The other parties to a message. The mailbox's own address is on every message
 * in the mailbox, so it can never tell two conversations apart.
 */
function counterparties(
	addresses: Array<string | null | undefined>,
	...own: Array<string | null | undefined>
): string[] {
	const ownAddresses = new Set(participantsOf(...own));
	return participantsOf(...addresses).filter((address) => !ownAddresses.has(address));
}

export type ConversationRow = typeof conversations.$inferSelect;

type ResolveInboundInput = {
	/** The organisation the mailbox belongs to; stamped on any conversation created. */
	organizationId: string;
	mailboxId: string;
	subject: string | null;
	fromAddr: string | null;
	toAddr: string | null;
	/** Message-IDs from In-Reply-To and References, in order. */
	referencedMessageIds: string[];
	/** The mailbox's own address, so it is not treated as a shared participant. */
	mailboxAddress?: string | null;
	receivedAt?: Date;
};

/**
 * Picks the conversation an inbound message belongs to:
 *  1. any referenced Message-ID that we already stored in this mailbox,
 *  2. else the same mailbox + normalised subject + a shared participant within 7 days,
 *  3. else a new conversation.
 */
export async function resolveConversationForInbound(
	db: AppDatabase,
	input: ResolveInboundInput,
): Promise<ConversationRow> {
	const byReference = await findConversationByReferences(db, input.mailboxId, input.referencedMessageIds);
	if (byReference) return byReference;

	const bySubject = await findConversationBySubjectAndParticipant(db, {
		mailboxId: input.mailboxId,
		subject: input.subject,
		participants: counterparties([input.fromAddr, input.toAddr], input.mailboxAddress),
		at: input.receivedAt ?? new Date(),
	});
	if (bySubject) return bySubject;

	return createConversation(db, {
		organizationId: input.organizationId,
		mailboxId: input.mailboxId,
		subject: input.subject,
		createdAt: input.receivedAt ?? new Date(),
	});
}

type ResolveOutboundInput = {
	/** The organisation the mailbox belongs to; stamped on any conversation created. */
	organizationId: string;
	mailboxId: string;
	subject: string | null;
	fromAddr: string | null;
	toAddr: string | null;
	/** Our own message row the user is replying to, when the caller knows it. */
	replyToMessageId?: string | null;
	sentAt?: Date;
};

export type OutboundThread = {
	conversation: ConversationRow;
	/** Ready-to-send header values; both absent when this starts a new thread. */
	inReplyTo: string | null;
	references: string[];
};

/**
 * Picks the conversation an outbound message belongs to and derives the
 * `In-Reply-To`/`References` headers from the message it answers.
 */
export async function resolveConversationForOutbound(
	db: AppDatabase,
	input: ResolveOutboundInput,
): Promise<OutboundThread> {
	const parent = await findParentMessage(db, input);
	if (parent) {
		const conversation = parent.conversationId
			? await getConversation(db, parent.conversationId)
			: null;
		const target =
			conversation ??
			(await createConversation(db, {
				organizationId: input.organizationId,
				mailboxId: input.mailboxId,
				subject: input.subject,
				createdAt: input.sentAt ?? new Date(),
			}));
		if (!conversation && parent.id) {
			await db
				.update(messages)
				.set({ conversationId: target.id })
				.where(eq(messages.id, parent.id));
		}
		const parentId = parent.providerMessageId;
		return {
			conversation: target,
			inReplyTo: parentId,
			references: parentId ? dedupe([...(parent.referencesHeader ?? []), parentId]) : [],
		};
	}

	const bySubject = await findConversationBySubjectAndParticipant(db, {
		mailboxId: input.mailboxId,
		subject: input.subject,
		participants: counterparties([input.toAddr], input.fromAddr),
		at: input.sentAt ?? new Date(),
	});
	const conversation =
		bySubject ??
		(await createConversation(db, {
			organizationId: input.organizationId,
			mailboxId: input.mailboxId,
			subject: input.subject,
			createdAt: input.sentAt ?? new Date(),
		}));
	return { conversation, inReplyTo: null, references: [] };
}

/** Bumps `last_message_at` and `message_count` after a message was attached. */
export async function touchConversation(
	db: AppDatabase,
	conversationId: string,
	messageAt: Date = new Date(),
): Promise<void> {
	const at = sql`${messageAt.toISOString()}::timestamptz`;
	await db
		.update(conversations)
		.set({
			messageCount: sql`${conversations.messageCount} + 1`,
			// Bound as text + cast: postgres-js will not serialise a Date inside a raw fragment.
			lastMessageAt: sql`GREATEST(COALESCE(${conversations.lastMessageAt}, ${at}), ${at})`,
		})
		.where(eq(conversations.id, conversationId));
}

/**
 * One conversation by id.
 *
 * Pass `orgId` (`ctx.orgId` from `withOrg`) from anything serving a request: a
 * conversation in another organisation then reads as missing. It is optional
 * only for the inbound/outbound threading paths, which run without a request.
 */
export async function getConversation(
	db: AppDatabase,
	conversationId: string,
	orgId?: string,
): Promise<ConversationRow | null> {
	const [row] = await db
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.id, conversationId),
				...(orgId ? [eq(conversations.organizationId, orgId)] : []),
			),
		)
		.limit(1);
	return row ?? null;
}

/** Drops a conversation we created for a message that was not stored after all. */
export async function deleteConversationIfEmpty(db: AppDatabase, conversationId: string): Promise<void> {
	await db
		.delete(conversations)
		.where(and(eq(conversations.id, conversationId), eq(conversations.messageCount, 0)));
}

async function createConversation(
	db: AppDatabase,
	input: { organizationId: string; mailboxId: string; subject: string | null; createdAt: Date },
): Promise<ConversationRow> {
	const [row] = await db
		.insert(conversations)
		.values({
			id: newId("cnv"),
			organizationId: input.organizationId,
			mailboxId: input.mailboxId,
			subject: input.subject,
			subjectNormalized: normalizeSubject(input.subject),
			lastMessageAt: input.createdAt,
			messageCount: 0,
			createdAt: input.createdAt,
		})
		.returning();
	return row;
}

/** Rule 1: a referenced Message-ID we already stored in the same mailbox. */
async function findConversationByReferences(
	db: AppDatabase,
	mailboxId: string,
	referencedMessageIds: string[],
): Promise<ConversationRow | null> {
	if (referencedMessageIds.length === 0) return null;
	const [match] = await db
		.select({ conversationId: messages.conversationId })
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, mailboxId),
				isNotNull(messages.conversationId),
				inArray(messages.providerMessageId, referencedMessageIds),
			),
		)
		.orderBy(desc(messages.createdAt))
		.limit(1);
	if (!match?.conversationId) return null;
	return getConversation(db, match.conversationId);
}

/** Rule 2: same mailbox + normalised subject + a shared participant within 7 days. */
async function findConversationBySubjectAndParticipant(
	db: AppDatabase,
	input: { mailboxId: string; subject: string | null; participants: string[]; at: Date },
): Promise<ConversationRow | null> {
	const subjectNormalized = normalizeSubject(input.subject);
	if (!subjectNormalized || input.participants.length === 0) return null;
	const since = new Date(input.at.getTime() - SUBJECT_MATCH_WINDOW_MS);

	const candidates = await db
		.select({ conversationId: messages.conversationId })
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(
			and(
				eq(conversations.mailboxId, input.mailboxId),
				eq(conversations.subjectNormalized, subjectNormalized),
				gte(messages.createdAt, since),
				or(
					participantMatches(messages.fromAddr, input.participants),
					participantMatches(messages.toAddr, input.participants),
				),
			),
		)
		.orderBy(desc(messages.createdAt))
		.limit(1);

	const conversationId = candidates[0]?.conversationId;
	if (!conversationId) return null;
	return getConversation(db, conversationId);
}

/** `addr` may be `Name <a@b>` or a comma list, so match on a case-insensitive substring. */
function participantMatches(column: AnyColumn, participants: string[]) {
	return or(...participants.map((address) => sql`lower(${column}) LIKE ${`%${address}%`}`));
}

/** Finds the message an outbound reply answers, if any. */
async function findParentMessage(db: AppDatabase, input: ResolveOutboundInput) {
	const columns = {
		id: messages.id,
		conversationId: messages.conversationId,
		providerMessageId: messages.providerMessageId,
		referencesHeader: messages.referencesHeader,
	};

	if (input.replyToMessageId) {
		const [explicit] = await db
			.select(columns)
			.from(messages)
			.where(and(eq(messages.id, input.replyToMessageId), eq(messages.mailboxId, input.mailboxId)))
			.limit(1);
		if (explicit) return explicit;
	}

	// No explicit parent: thread onto the newest message in this mailbox that
	// shares the normalised subject and a participant, and has a Message-ID.
	const subjectNormalized = normalizeSubject(input.subject);
	const participants = counterparties([input.toAddr], input.fromAddr);
	if (!subjectNormalized || participants.length === 0) return null;
	const since = new Date((input.sentAt ?? new Date()).getTime() - SUBJECT_MATCH_WINDOW_MS);

	const [candidate] = await db
		.select(columns)
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(
			and(
				eq(conversations.mailboxId, input.mailboxId),
				eq(conversations.subjectNormalized, subjectNormalized),
				isNotNull(messages.providerMessageId),
				gte(messages.createdAt, since),
				or(
					participantMatches(messages.fromAddr, participants),
					participantMatches(messages.toAddr, participants),
				),
			),
		)
		.orderBy(desc(messages.createdAt))
		.limit(1);
	return candidate ?? null;
}

/* ------------------------------------------------------------------ *
 * T2.2 — read/write helpers behind the internal conversation API.
 * ------------------------------------------------------------------ */

export type ConversationStatus = ConversationRow["status"];

/** Sort key for the conversation list: newest activity first, creation time as fallback. */
const listSortKey = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;

export type ConversationCursor = { at: Date; id: string };

/** Opaque page token: base64 of `<iso last_message_at>|<id>`. */
export function encodeConversationCursor(at: Date, id: string): string {
	return Buffer.from(`${at.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeConversationCursor(value: string | null | undefined): ConversationCursor | null {
	if (!value) return null;
	let decoded: string;
	try {
		decoded = Buffer.from(value, "base64url").toString("utf8");
	} catch {
		return null;
	}
	const separator = decoded.lastIndexOf("|");
	if (separator <= 0) return null;
	const at = new Date(decoded.slice(0, separator));
	const id = decoded.slice(separator + 1);
	if (Number.isNaN(at.getTime()) || !id) return null;
	return { at, id };
}

export type ConversationListItem = {
	id: string;
	mailboxId: string;
	subject: string | null;
	status: ConversationStatus;
	snoozedUntil: Date | null;
	lastMessageAt: Date | null;
	createdAt: Date;
	messageCount: number;
	unreadCount: number;
	assignee: { id: string; name: string | null } | null;
	lastMessage: {
		id: string;
		direction: "inbound" | "outbound";
		from: string;
		to: string;
		snippet: string | null;
		read: boolean;
		createdAt: Date;
	} | null;
};

export type ListConversationsInput = {
	/** The caller's organisation (`ctx.orgId` from `withOrg`). */
	orgId: string;
	/** The mailboxes the caller may read. An empty list yields an empty page. */
	mailboxIds: string[];
	status?: ConversationStatus | null;
	/** A user id, or `"none"` for unassigned conversations. */
	assignedUserId?: string | null;
	/** Case-insensitive substring match on the subject. */
	q?: string | null;
	cursor?: string | null;
	limit?: number;
};

export const CONVERSATION_LIST_MAX_LIMIT = 100;
export const CONVERSATION_LIST_DEFAULT_LIMIT = 50;

export async function listConversations(
	db: AppDatabase,
	input: ListConversationsInput,
): Promise<{ conversations: ConversationListItem[]; nextCursor: string | null; limit: number }> {
	const limit = Math.min(
		Math.max(input.limit ?? CONVERSATION_LIST_DEFAULT_LIMIT, 1),
		CONVERSATION_LIST_MAX_LIMIT,
	);
	if (input.mailboxIds.length === 0) return { conversations: [], nextCursor: null, limit };

	const conditions: SQL[] = [
		eq(conversations.organizationId, input.orgId),
		inArray(conversations.mailboxId, input.mailboxIds),
	];
	if (input.status) conditions.push(eq(conversations.status, input.status));
	if (input.assignedUserId === "none") {
		conditions.push(isNull(conversations.assignedUserId));
	} else if (input.assignedUserId) {
		conditions.push(eq(conversations.assignedUserId, input.assignedUserId));
	}
	if (input.q) conditions.push(ilike(conversations.subject, `%${input.q}%`));
	const cursor = decodeConversationCursor(input.cursor);
	if (cursor) {
		// Row-value comparison keeps the keyset stable when two rows share a timestamp.
		conditions.push(
			sql`(${listSortKey}, ${conversations.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id})`,
		);
	}

	const rows = await db
		.select({
			id: conversations.id,
			mailboxId: conversations.mailboxId,
			subject: conversations.subject,
			status: conversations.status,
			snoozedUntil: conversations.snoozedUntil,
			lastMessageAt: conversations.lastMessageAt,
			createdAt: conversations.createdAt,
			assignedUserId: conversations.assignedUserId,
			assigneeName: users.name,
		})
		.from(conversations)
		.leftJoin(users, eq(users.id, conversations.assignedUserId))
		.where(and(...conditions))
		.orderBy(sql`${listSortKey} desc`, desc(conversations.id))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const ids = page.map((row) => row.id);
	const [lastMessages, counts] = await Promise.all([
		lastMessageByConversation(db, ids),
		messageCountsByConversation(db, ids),
	]);

	const items: ConversationListItem[] = page.map((row) => ({
		id: row.id,
		mailboxId: row.mailboxId,
		subject: row.subject,
		status: row.status,
		snoozedUntil: row.snoozedUntil,
		lastMessageAt: row.lastMessageAt,
		createdAt: row.createdAt,
		messageCount: counts.get(row.id)?.total ?? 0,
		unreadCount: counts.get(row.id)?.unread ?? 0,
		assignee: row.assignedUserId ? { id: row.assignedUserId, name: row.assigneeName ?? null } : null,
		lastMessage: lastMessages.get(row.id) ?? null,
	}));

	const last = page.at(-1);
	const nextCursor =
		rows.length > limit && last
			? encodeConversationCursor(last.lastMessageAt ?? last.createdAt, last.id)
			: null;
	return { conversations: items, nextCursor, limit };
}

async function lastMessageByConversation(db: AppDatabase, conversationIds: string[]) {
	const map = new Map<string, NonNullable<ConversationListItem["lastMessage"]>>();
	if (conversationIds.length === 0) return map;
	const rows = await db
		.selectDistinctOn([messages.conversationId], {
			conversationId: messages.conversationId,
			id: messages.id,
			direction: messages.direction,
			fromAddr: messages.fromAddr,
			toAddr: messages.toAddr,
			snippet: messages.snippet,
			read: messages.read,
			createdAt: messages.createdAt,
		})
		.from(messages)
		.where(inArray(messages.conversationId, conversationIds))
		.orderBy(messages.conversationId, desc(messages.createdAt), desc(messages.id));
	for (const row of rows) {
		if (!row.conversationId) continue;
		map.set(row.conversationId, {
			id: row.id,
			direction: row.direction,
			from: row.fromAddr,
			to: row.toAddr,
			snippet: row.snippet,
			read: row.read,
			createdAt: row.createdAt,
		});
	}
	return map;
}

async function messageCountsByConversation(db: AppDatabase, conversationIds: string[]) {
	const map = new Map<string, { total: number; unread: number }>();
	if (conversationIds.length === 0) return map;
	const rows = await db
		.select({
			conversationId: messages.conversationId,
			total: count(),
			unread: sql<number>`count(*) filter (where ${messages.read} = false)`.mapWith(Number),
		})
		.from(messages)
		.where(inArray(messages.conversationId, conversationIds))
		.groupBy(messages.conversationId);
	for (const row of rows) {
		if (!row.conversationId) continue;
		map.set(row.conversationId, { total: Number(row.total), unread: Number(row.unread) });
	}
	return map;
}

export type ConversationMessage = {
	id: string;
	direction: "inbound" | "outbound";
	from: string;
	to: string;
	subject: string | null;
	snippet: string | null;
	read: boolean;
	createdAt: Date;
};

export type ConversationNote = {
	id: string;
	body: string;
	createdAt: Date;
	author: { id: string; name: string | null } | null;
};

export type ConversationDetail = Omit<ConversationListItem, "lastMessage"> & {
	messages: ConversationMessage[];
	notes: ConversationNote[];
};

/** The conversation plus its messages (oldest first) and its notes. */
export async function getConversationWithMessages(
	db: AppDatabase,
	conversationId: string,
	orgId: string,
): Promise<ConversationDetail | null> {
	const [row] = await db
		.select({
			id: conversations.id,
			mailboxId: conversations.mailboxId,
			subject: conversations.subject,
			status: conversations.status,
			snoozedUntil: conversations.snoozedUntil,
			lastMessageAt: conversations.lastMessageAt,
			createdAt: conversations.createdAt,
			assignedUserId: conversations.assignedUserId,
			assigneeName: users.name,
		})
		.from(conversations)
		.leftJoin(users, eq(users.id, conversations.assignedUserId))
		.where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, orgId)))
		.limit(1);
	if (!row) return null;

	const [messageRows, notes] = await Promise.all([
		db
			.select({
				id: messages.id,
				direction: messages.direction,
				fromAddr: messages.fromAddr,
				toAddr: messages.toAddr,
				subject: messages.subject,
				snippet: messages.snippet,
				read: messages.read,
				createdAt: messages.createdAt,
			})
			.from(messages)
			.where(
				and(eq(messages.conversationId, conversationId), eq(messages.organizationId, orgId)),
			)
			.orderBy(asc(messages.createdAt), asc(messages.id)),
		listConversationNotes(db, conversationId, orgId),
	]);

	return {
		id: row.id,
		mailboxId: row.mailboxId,
		subject: row.subject,
		status: row.status,
		snoozedUntil: row.snoozedUntil,
		lastMessageAt: row.lastMessageAt,
		createdAt: row.createdAt,
		messageCount: messageRows.length,
		unreadCount: messageRows.filter((message) => !message.read).length,
		assignee: row.assignedUserId ? { id: row.assignedUserId, name: row.assigneeName ?? null } : null,
		messages: messageRows.map((message) => ({
			id: message.id,
			direction: message.direction,
			from: message.fromAddr,
			to: message.toAddr,
			subject: message.subject,
			snippet: message.snippet,
			read: message.read,
			createdAt: message.createdAt,
		})),
		notes,
	};
}

/** Sets or clears the assignee. Returns the updated row, or null if it vanished. */
export async function assignConversation(
	db: AppDatabase,
	conversationId: string,
	userId: string | null,
	orgId: string,
): Promise<ConversationRow | null> {
	const [row] = await db
		.update(conversations)
		.set({ assignedUserId: userId })
		.where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, orgId)))
		.returning();
	if (!row) return null;
	// T6.3: `conversation.assigned` also fires on unassign (`userId === null`).
	await emitWebhookEvent(db, {
		orgId,
		type: "conversation.assigned",
		data: {
			conversationId: row.id,
			assignedUserId: row.assignedUserId,
			subject: row.subject,
			status: row.status,
		},
	});
	return row;
}

export type ConversationStatusUpdate = {
	status?: ConversationStatus;
	/** `null` clears the snooze; a date implies `status: "snoozed"` unless one is given. */
	snoozedUntil?: Date | null;
};

export async function updateConversationStatus(
	db: AppDatabase,
	conversationId: string,
	update: ConversationStatusUpdate,
	orgId: string,
): Promise<ConversationRow | null> {
	const values: Partial<typeof conversations.$inferInsert> = {};
	if (update.status !== undefined) values.status = update.status;
	if (update.snoozedUntil !== undefined) {
		values.snoozedUntil = update.snoozedUntil;
		if (update.status === undefined) values.status = update.snoozedUntil ? "snoozed" : "open";
	}
	// Leaving "snoozed" without saying so drops the wake-up time with it.
	if (update.status && update.status !== "snoozed" && update.snoozedUntil === undefined) {
		values.snoozedUntil = null;
	}
	if (Object.keys(values).length === 0) return getConversation(db, conversationId, orgId);

	const [row] = await db
		.update(conversations)
		.set(values)
		.where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, orgId)))
		.returning();
	return row ?? null;
}

/**
 * Notes on one conversation, oldest first.
 *
 * `conversation_notes` has no `organization_id`; it is scoped through the parent
 * conversation, which is joined for exactly that reason.
 */
export async function listConversationNotes(
	db: AppDatabase,
	conversationId: string,
	orgId: string,
): Promise<ConversationNote[]> {
	const rows = await db
		.select({
			id: conversationNotes.id,
			body: conversationNotes.body,
			createdAt: conversationNotes.createdAt,
			userId: conversationNotes.userId,
			authorName: users.name,
		})
		.from(conversationNotes)
		.innerJoin(conversations, eq(conversations.id, conversationNotes.conversationId))
		.leftJoin(users, eq(users.id, conversationNotes.userId))
		.where(
			and(
				eq(conversationNotes.conversationId, conversationId),
				eq(conversations.organizationId, orgId),
			),
		)
		.orderBy(asc(conversationNotes.createdAt), asc(conversationNotes.id));
	return rows.map((row) => ({
		id: row.id,
		body: row.body,
		createdAt: row.createdAt,
		author: row.userId ? { id: row.userId, name: row.authorName ?? null } : null,
	}));
}

/** Adds an internal note. Null when the conversation is not in `input.orgId`. */
export async function addConversationNote(
	db: AppDatabase,
	input: { conversationId: string; userId: string | null; body: string; orgId: string },
): Promise<ConversationNote | null> {
	const parent = await getConversation(db, input.conversationId, input.orgId);
	if (!parent) return null;
	const [row] = await db
		.insert(conversationNotes)
		.values({
			id: newId("cnote"),
			conversationId: input.conversationId,
			userId: input.userId,
			body: input.body,
		})
		.returning();
	const author = input.userId
		? await db
				.select({ id: users.id, name: users.name })
				.from(users)
				.where(eq(users.id, input.userId))
				.limit(1)
				.then((found) => found[0] ?? null)
		: null;
	// T6.3.
	await emitWebhookEvent(db, {
		orgId: input.orgId,
		type: "conversation.note",
		data: {
			conversationId: input.conversationId,
			noteId: row.id,
			body: row.body,
			authorId: input.userId,
		},
	});
	return { id: row.id, body: row.body, createdAt: row.createdAt, author };
}
