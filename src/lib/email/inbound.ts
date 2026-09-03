import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { inboundFailures, messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { resolveInboundAddress, resolveInboxRuleDestination } from "@/lib/email/routing";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { getMessageContactNames, upsertContactFromAddress } from "@/lib/contacts/service";
import {
	deleteConversationIfEmpty,
	parseMessageIdList,
	resolveConversationForInbound,
	touchConversation,
} from "@/lib/conversations/service";
import { formatEmailAddress, getEmailAddress } from "@/lib/email/address";
import { sendMailboxAutoReply } from "@/lib/email/auto-reply";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { listMessageAttachments, storeMessageAttachments } from "@/lib/email/attachments";
import { getUnsubscribeUrlFromRawR2Key } from "@/lib/email/unsubscribe";
import { getUserOrganizationId } from "@/lib/organizations/service";
import { isQuotaExceededError } from "@/lib/quotas/errors";
import { releaseQuota, reserveQuota } from "@/lib/quotas/service";
import type { SessionUser } from "@/lib/auth/types";
import {
	getMailboxNotificationUserIds,
	notifyUsersOfNewMessage,
} from "@/lib/realtime/utils";

/** Raw inbound message metadata handed over by the edge worker relay. */
export type InboundMessagePayload = {
	from: string;
	to: string;
	rawR2Key: string;
	headers?: Record<string, string>;
};

export async function processInboundMessage(
	env: CloudflareEnv,
	payload: InboundMessagePayload,
): Promise<void> {
	const db = getDb(env);
	const decision = await resolveInboundAddress(db, payload.to);

	if (!decision) {
		console.warn(`No routing for inbound address: ${payload.to}`);
		return;
	}

	if (decision.action === "reject") {
		console.warn(`Rejected inbound: ${payload.to}`);
		return;
	}

	if (decision.action === "forward" && decision.forwardTo) {
		console.info(`Forward ${payload.to} -> ${decision.forwardTo}`);
		return;
	}

	if (!decision.mailbox) return;

	const raw = await env.BUCKET.get(payload.rawR2Key);
	if (!raw) {
		console.error(`Missing R2 object: ${payload.rawR2Key}`);
		return;
	}

	const buffer = await raw.arrayBuffer();
	const parsed = await parseRawMime(buffer);
	const messageId = newId("msg");
	const snippet = buildSnippet(parsed.text, parsed.html);
	const deliveredAddress = getEmailAddress(payload.to) || `${decision.mailbox.localPart}@${decision.mailbox.hostname}`;
	const toAddr = formatEmailAddress(deliveredAddress, decision.mailbox.displayName ?? decision.mailbox.localPart);
	const fromAddr = parsed.fromAddr ?? payload.from;
	const destination = await resolveInboxRuleDestination(db, {
		mailboxId: decision.mailbox.mailboxId,
		toAddress: toAddr,
		fromAddress: fromAddr,
		subject: parsed.subject,
		content: [parsed.text, parsed.html, snippet].filter(Boolean).join(" "),
	});
	// The edge worker retries on error, so the same message can arrive twice.
	// Treat an inbound message we already stored for this mailbox as delivered.
	if (parsed.messageId) {
		const [existing] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.mailboxId, decision.mailbox.mailboxId),
					eq(messages.direction, "inbound"),
					eq(messages.providerMessageId, parsed.messageId),
				),
			)
			.limit(1);
		if (existing) {
			await discardDuplicateRaw(env, payload.rawR2Key);
			return;
		}
	}

	// Quota (T5.1): the raw object plus its attachments must fit in the organisation's
	// storage allowance. On a breach nothing is inserted, the raw object is kept and an
	// `inbound_failures` row records it, so it can be retried once the quota is raised.
	const incomingBytes =
		buffer.byteLength +
		parsed.attachments.reduce((total, attachment) => total + attachment.content.byteLength, 0);
	const organizationId = await getUserOrganizationId(db, decision.mailbox.userId);
	try {
		await reserveQuota(db, organizationId, { storageBytes: incomingBytes });
	} catch (error) {
		if (!isQuotaExceededError(error)) throw error;
		console.warn(`Storage quota exceeded for ${payload.to}; keeping ${payload.rawR2Key}`);
		await db
			.insert(inboundFailures)
			.values({
				id: newId("inf"),
				organizationId,
				rawR2Key: payload.rawR2Key,
				mailboxId: decision.mailbox.mailboxId,
				fromAddr,
				toAddr,
				error: "quota exceeded",
				attempts: 1,
			})
			.onConflictDoUpdate({
				target: inboundFailures.rawR2Key,
				set: {
					attempts: sql`${inboundFailures.attempts} + 1`,
					error: "quota exceeded",
					resolvedAt: null,
				},
			});
		return;
	}

	const contact = await upsertContactFromAddress(env, {
		userId: decision.mailbox.userId,
		address: fromAddr,
		source: "inbound",
	});

	const receivedAt = parsed.date ?? new Date();
	const references = mergeReferences(parsed.references, parsed.inReplyTo);
	const conversation = await resolveConversationForInbound(db, {
		organizationId,
		mailboxId: decision.mailbox.mailboxId,
		subject: parsed.subject,
		fromAddr,
		toAddr,
		referencedMessageIds: references,
		mailboxAddress: deliveredAddress,
		receivedAt,
	});

	try {
		await db.insert(messages).values({
			id: messageId,
			organizationId,
			userId: decision.mailbox.userId,
			mailboxId: decision.mailbox.mailboxId,
			folderId: destination.folderId,
			direction: "inbound",
			providerMessageId: parsed.messageId,
			fromAddr,
			toAddr,
			subject: parsed.subject,
			snippet,
			textBody: parsed.text,
			htmlBody: parsed.html,
			rawR2Key: payload.rawR2Key,
			status: destination.status,
			trashedAt: destination.status === "trash" ? receivedAt : null,
			threadId: parsed.messageId,
			conversationId: conversation.id,
			inReplyTo: parsed.inReplyTo,
			referencesHeader: references.length ? references : null,
		});
	} catch (error) {
		// Lost the race against a concurrent delivery of the same message: it is stored.
		if (isUniqueViolation(error)) {
			await releaseQuota(db, organizationId, { storageBytes: incomingBytes });
			await deleteConversationIfEmpty(db, conversation.id);
			await discardDuplicateRaw(env, payload.rawR2Key);
			return;
		}
		await releaseQuota(db, organizationId, { storageBytes: incomingBytes });
		throw error;
	}

	await touchConversation(db, conversation.id, receivedAt);

	try {
		await storeMessageAttachments(env, messageId, parsed.attachments, { validate: false });
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, messageId));
		await releaseQuota(db, organizationId, { storageBytes: incomingBytes });
		throw error;
	}

	if (destination.status === "received") {
		try {
			await sendMailboxAutoReply(env, {
				mailboxId: decision.mailbox.mailboxId,
				userId: decision.mailbox.userId,
				deliveredAddress,
				fromAddress: fromAddr,
				incomingMessageId: parsed.messageId,
				headers: payload.headers,
			});
		} catch (error) {
			console.error(`Auto-reply failed for mailbox ${decision.mailbox.mailboxId}`, error);
		}
	}

	const notificationUserIds = await getMailboxNotificationUserIds(
		env,
		decision.mailbox.mailboxId,
		decision.mailbox.userId,
	);
	await notifyUsersOfNewMessage(env, notificationUserIds, {
		type: "new_message",
		messageId,
		mailboxId: decision.mailbox.mailboxId,
		from: fromAddr,
		fromName: contact?.displayName ?? null,
		subject: parsed.subject,
	});
	await dispatchWebhooks(env, decision.mailbox.userId, "message.inbound", {
		messageId,
		from: fromAddr,
		to: toAddr,
		subject: parsed.subject,
	});
}

/** In-Reply-To first, then References: the order a threading client walks them. */
function mergeReferences(references: string[], inReplyTo: string | null): string[] {
	const fromInReplyTo = parseMessageIdList(inReplyTo);
	return [...new Set([...fromInReplyTo, ...references])];
}

/** Postgres unique_violation, raised by the partial index on (mailbox_id, provider_message_id). */
function isUniqueViolation(error: unknown): boolean {
	const code = (error as { code?: unknown })?.code;
	if (code === "23505") return true;
	const cause = (error as { cause?: unknown })?.cause;
	return !!cause && cause !== error && isUniqueViolation(cause);
}

/** Removes the raw object stored for a delivery we are dropping, so nothing is orphaned. */
async function discardDuplicateRaw(env: CloudflareEnv, rawR2Key: string): Promise<void> {
	try {
		await env.BUCKET.delete(rawR2Key);
	} catch (error) {
		console.error(`Could not delete duplicate raw object ${rawR2Key}`, error);
	}
}

export async function storeRawToR2(
	env: CloudflareEnv,
	from: string,
	to: string,
	raw: ArrayBuffer | ReadableStream<Uint8Array>,
): Promise<string> {
	const key = `inbound/${Date.now()}-${newId()}.eml`;
	const buffer = raw instanceof ArrayBuffer ? raw : await new Response(raw).arrayBuffer();
	await env.BUCKET.put(key, buffer, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { from, to },
	});
	return key;
}

/**
 * The message with its body, contact names and attachments.
 *
 * `orgId` is the caller's organisation (`ctx.orgId` from `withOrg`): a message
 * that belongs to another organisation is treated as missing.
 */
export async function getMessageWithBody(
	env: CloudflareEnv,
	userId: string,
	messageId: string,
	orgId: string,
) {
	const db = getDb(env);
	const [message] = await db
		.select()
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.organizationId, orgId)))
		.limit(1);
	if (!message || message.userId !== userId) return null;
	const contactNames = await getMessageContactNames(env, userId, message.fromAddr, message.toAddr);
	const attachments = await listMessageAttachments(env, messageId);
	const unsubscribeUrl = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	return { message: { ...message, ...contactNames }, body: message, attachments, unsubscribeUrl };
}

/** As `getMessageWithBody`, but authorised through the mailbox the message sits in. */
export async function getMessageWithBodyForUser(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	orgId: string,
) {
	const db = getDb(env);
	const [message] = await db
		.select()
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.organizationId, orgId)))
		.limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId, orgId);
	if (!access?.canRead) return null;
	const contactNames = await getMessageContactNames(env, message.userId, message.fromAddr, message.toAddr);
	const attachments = await listMessageAttachments(env, messageId);
	const unsubscribeUrl = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	return { message: { ...message, ...contactNames }, body: message, attachments, unsubscribeUrl };
}

/** Attachment list and unsubscribe link only, for the message detail pane. */
export async function getMessageMetadataForUser(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	orgId: string,
) {
	const db = getDb(env);
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.organizationId, orgId)))
		.limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId, orgId);
	if (!access?.canRead) return null;
	const [attachments, unsubscribeUrl] = await Promise.all([
		listMessageAttachments(env, messageId),
		getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key),
	]);
	return { attachments, unsubscribeUrl };
}
