import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { conversations, messages } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { newId } from "@/lib/ids";

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
		mailboxId: input.mailboxId,
		subject: input.subject,
		createdAt: input.receivedAt ?? new Date(),
	});
}

type ResolveOutboundInput = {
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

export async function getConversation(
	db: AppDatabase,
	conversationId: string,
): Promise<ConversationRow | null> {
	const [row] = await db
		.select()
		.from(conversations)
		.where(eq(conversations.id, conversationId))
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
	input: { mailboxId: string; subject: string | null; createdAt: Date },
): Promise<ConversationRow> {
	const [row] = await db
		.insert(conversations)
		.values({
			id: newId("cnv"),
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
