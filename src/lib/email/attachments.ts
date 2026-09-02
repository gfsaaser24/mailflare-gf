import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { addStorageBytes, assertAttachmentBytes } from "@/lib/quotas/service";
import type { QuotaLimits } from "@/lib/quotas/templates";
import type { SessionUser } from "@/lib/auth/types";
import type {
	AttachmentContent,
	AttachmentMetadata,
	StoredAttachment,
} from "./attachment-types";

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_SIZE = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 10;

export function decodeBase64Content(content: string): ArrayBuffer {
	const binary = atob(content.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer;
}

export function normalizeAttachmentContent(
	content: ArrayBuffer | Uint8Array | string,
	encoding?: "base64" | "utf8",
): ArrayBuffer {
	if (content instanceof ArrayBuffer) return content;
	if (content instanceof Uint8Array) {
		return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
	}
	if (encoding === "base64") return decodeBase64Content(content);
	return new TextEncoder().encode(content).buffer;
}

function sanitizeFilename(filename: string): string {
	const normalized = filename.trim().replace(/[/\\\0]/g, "_");
	return normalized || "attachment";
}

/**
 * Static limits first, then the organisation's `max_attachment_bytes` when the
 * caller knows it (T5.1). A breach of the quota throws `QuotaExceededError`,
 * which routes answer with 429.
 */
export function validateAttachments(
	attachments: AttachmentContent[],
	quota?: Pick<QuotaLimits, "maxAttachmentBytes"> | null,
): void {
	if (attachments.length > MAX_ATTACHMENT_COUNT) {
		throw new Error(`A message can include at most ${MAX_ATTACHMENT_COUNT} attachments`);
	}

	let totalSize = 0;
	for (const attachment of attachments) {
		const size = attachment.content.byteLength;
		if (size > MAX_ATTACHMENT_SIZE) {
			throw new Error(`${attachment.filename} exceeds the 10 MB attachment limit`);
		}
		assertAttachmentBytes(quota, size);
		totalSize += size;
	}

	if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
		throw new Error("Attachments exceed the 20 MB total limit");
	}
}

/**
 * Stores the parts and their rows.
 *
 * `options.organizationId` books the stored bytes on `org_usage.storage_bytes`;
 * the inbound path leaves it out because it reserves raw + attachment bytes in
 * one go before the message is inserted.
 */
export async function storeMessageAttachments(
	env: CloudflareEnv,
	messageId: string,
	attachments: AttachmentContent[],
	options?: { validate?: boolean; quota?: Pick<QuotaLimits, "maxAttachmentBytes"> | null; organizationId?: string },
): Promise<StoredAttachment[]> {
	if (options?.validate !== false) validateAttachments(attachments, options?.quota);
	const db = getDb(env);
	const stored: StoredAttachment[] = [];

	try {
		for (const attachment of attachments) {
			const id = newId("att");
			const filename = sanitizeFilename(attachment.filename);
			const r2Key = `attachments/${messageId}/${id}/${filename}`;
			const disposition = attachment.disposition ?? "attachment";

			await env.BUCKET.put(r2Key, attachment.content, {
				httpMetadata: { contentType: attachment.type },
				customMetadata: { filename, messageId },
			});
			stored.push({
				id,
				messageId,
				filename,
				type: attachment.type,
				size: attachment.content.byteLength,
				disposition,
				contentId: attachment.contentId ?? null,
				r2Key,
			});
			await db.insert(messageAttachments).values({
				id,
				messageId,
				filename,
				contentType: attachment.type,
				size: attachment.content.byteLength,
				disposition,
				contentId: attachment.contentId ?? null,
				r2Key,
			});
		}
	} catch (error) {
		await Promise.all(stored.map((attachment) => env.BUCKET.delete(attachment.r2Key)));
		throw error;
	}

	if (options?.organizationId) {
		const bytes = stored.reduce((total, attachment) => total + attachment.size, 0);
		await addStorageBytes(db, options.organizationId, bytes);
	}

	return stored;
}

export async function listMessageAttachments(
	env: CloudflareEnv,
	messageId: string,
): Promise<AttachmentMetadata[]> {
	const db = getDb(env);
	const rows = await db
		.select()
		.from(messageAttachments)
		.where(eq(messageAttachments.messageId, messageId));

	return rows.map((attachment) => ({
		id: attachment.id,
		messageId: attachment.messageId,
		filename: attachment.filename,
		type: attachment.contentType,
		size: attachment.size,
		disposition: attachment.disposition as "attachment" | "inline",
		contentId: attachment.contentId,
	}));
}

/**
 * One attachment plus its stored object, or null when the caller may not have it.
 *
 * `orgId` is the caller's organisation (`ctx.orgId` from `withOrg`): the parent
 * message must belong to it, so an attachment in another organisation is
 * indistinguishable from one that does not exist.
 */
export async function getAttachmentForUser(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	attachmentId: string,
	orgId: string,
) {
	const db = getDb(env);
	const [message] = await db
		.select()
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.organizationId, orgId)))
		.limit(1);
	if (!message) return null;

	if (message.mailboxId) {
		const access = await getMailboxAccessLevel(db, user, message.mailboxId, orgId);
		if (!access?.canRead) return null;
	} else if (message.userId !== user.id) {
		return null;
	}

	const [attachment] = await db
		.select()
		.from(messageAttachments)
		.where(
			and(
				eq(messageAttachments.id, attachmentId),
				eq(messageAttachments.messageId, messageId),
			),
		)
		.limit(1);
	if (!attachment) return null;

	const object = await env.BUCKET.get(attachment.r2Key);
	if (!object) return null;
	return { attachment, object };
}

/** Chunk size for `IN (...)` lookups so we never build an unbounded statement. */
const ATTACHMENT_LOOKUP_CHUNK = 200;

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

/**
 * Collects every stored attachment key for the given messages.
 * Does not touch the database rows; those cascade with their message.
 */
export async function listAttachmentKeysForMessages(
	env: CloudflareEnv,
	messageIds: string[],
): Promise<string[]> {
	if (messageIds.length === 0) return [];
	const db = getDb(env);
	const keys: string[] = [];

	for (const ids of chunk(messageIds, ATTACHMENT_LOOKUP_CHUNK)) {
		const rows = await db
			.select({ r2Key: messageAttachments.r2Key })
			.from(messageAttachments)
			.where(inArray(messageAttachments.messageId, ids));
		for (const row of rows) keys.push(row.r2Key);
	}

	return keys;
}

/** Total stored bytes of every attachment of the given messages. */
export async function sumAttachmentBytesForMessages(
	env: CloudflareEnv,
	messageIds: string[],
): Promise<number> {
	if (messageIds.length === 0) return 0;
	const db = getDb(env);
	let total = 0;

	for (const ids of chunk(messageIds, ATTACHMENT_LOOKUP_CHUNK)) {
		const rows = await db
			.select({ size: messageAttachments.size })
			.from(messageAttachments)
			.where(inArray(messageAttachments.messageId, ids));
		for (const row of rows) total += row.size ?? 0;
	}

	return total;
}

/**
 * Best-effort bulk removal of the stored objects for the given messages.
 * Failures are logged and counted, never thrown: storage cleanup must not block
 * the database work that follows it. Attachment rows are left to cascade.
 */
export async function deleteAttachmentsForMessages(
	env: CloudflareEnv,
	messageIds: string[],
): Promise<{ deleted: number; failed: number }> {
	const keys = await listAttachmentKeysForMessages(env, messageIds);
	let deleted = 0;
	let failed = 0;

	for (const key of keys) {
		try {
			await env.BUCKET.delete(key);
			deleted += 1;
		} catch (error) {
			failed += 1;
			console.error("deleteAttachmentsForMessages", key, error);
		}
	}

	return { deleted, failed };
}
