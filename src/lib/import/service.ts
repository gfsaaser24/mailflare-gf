import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { storeMessageAttachments } from "@/lib/email/attachments";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { newId } from "@/lib/ids";
import { getImportMessagePlacement } from "./destination";
import type { ImportDestination } from "./destination-types";
import type { ImportMailboxResult, ImportMessageInput } from "./types";

export async function importMessagesToMailbox(
	env: CloudflareEnv,
	input: {
		/** Organisation the imported rows belong to (`ctx.orgId`). */
		organizationId: string;
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		messages: ImportMessageInput[];
	},
): Promise<ImportMailboxResult> {
	const result: ImportMailboxResult = { imported: 0, skipped: 0, errors: [] };
	for (const message of input.messages) {
		try {
			const imported = await importMessageToMailbox(env, {
				organizationId: input.organizationId,
				userId: input.userId,
				mailboxId: input.mailboxId,
				destination: input.destination,
				filename: message.filename,
				raw: message.raw,
			});
			if (imported) {
				result.imported += 1;
			} else {
				result.skipped += 1;
			}
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${message.filename}: ${error instanceof Error ? error.message : "Import failed"}`);
		}
	}
	return result;
}

async function importMessageToMailbox(
	env: CloudflareEnv,
	input: {
		organizationId: string;
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		filename: string;
		raw: ArrayBuffer;
	},
): Promise<boolean> {
	const parsed = await parseRawMime(input.raw);
	const db = getDb(env);
	const providerMessageId = parsed.messageId ?? `import:${input.filename}:${input.raw.byteLength}`;

	const [existing] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.organizationId, input.organizationId),
				eq(messages.mailboxId, input.mailboxId),
				eq(messages.providerMessageId, providerMessageId),
			),
		)
		.limit(1);
	if (existing) return false;

	const messageId = newId("msg");
	const fromAddr = parsed.fromAddr ?? "unknown";
	const toAddr = parsed.toAddr ?? "";
	const createdAt = parsed.date ?? new Date();
	const placement = getImportMessagePlacement(input.destination);

	await db.insert(messages).values({
		id: messageId,
		organizationId: input.organizationId,
		userId: input.userId,
		mailboxId: input.mailboxId,
		folderId: placement.folderId,
		direction: placement.direction,
		providerMessageId,
		fromAddr,
		toAddr,
		subject: parsed.subject,
		snippet: buildSnippet(parsed.text, parsed.html),
		textBody: parsed.text,
		htmlBody: parsed.html,
		status: placement.status,
		// Time in trash starts at import; retention must not purge it at once.
		trashedAt: placement.status === "trash" ? new Date() : null,
		read: placement.direction === "outbound",
		threadId: parsed.messageId,
		createdAt,
	});

	try {
		await storeMessageAttachments(env, messageId, parsed.attachments, { validate: false });
		const contactAddress = placement.direction === "outbound" ? toAddr : fromAddr;
		await upsertContactFromAddress(env, {
			organizationId: input.organizationId,
			userId: input.userId,
			address: contactAddress,
			source: placement.direction === "outbound" ? "outbound" : "inbound",
		});
	} catch (error) {
		await db
			.delete(messages)
			.where(and(eq(messages.organizationId, input.organizationId), eq(messages.id, messageId)));
		throw error;
	}

	return true;
}
