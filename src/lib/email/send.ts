import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, outboundJobs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { resolveConversationForOutbound, touchConversation } from "@/lib/conversations/service";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { storeMessageAttachments, validateAttachments } from "@/lib/email/attachments";
import { getUserOrganizationId } from "@/lib/organizations/service";
import { getOrganizationQuota, reserveQuota } from "@/lib/quotas/service";
import { dedupeRecipients, joinRecipients, normalizeRecipients } from "@/lib/email/recipients";
import type { AttachmentContent } from "@/lib/email/attachment-types";

export type SendEmailInput = {
	userId: string;
	from: string;
	/** One address, or several. A comma/semicolon separated string is split. */
	to: string | string[];
	/** Real envelope recipients that also appear in the `Cc` header. */
	cc?: string[];
	/** Real envelope recipients that appear in no header. */
	bcc?: string[];
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	mailboxId: string;
	attachments?: AttachmentContent[];
	/** The stored message this send replies to, when the caller knows it. */
	replyToMessageId?: string | null;
};

export async function sendEmail(env: CloudflareEnv, input: SendEmailInput): Promise<{ messageId: string }> {
	const db = getDb(env);
	const attachments = input.attachments ?? [];
	// Quotas (T5.1): the per-attachment ceiling is known before anything is written;
	// the daily send counter is booked right before the transport call below.
	const organizationId = await getUserOrganizationId(db, input.userId);
	const toAddresses = normalizeRecipients(input.to);
	if (toAddresses.length === 0) throw new Error("At least one recipient is required");
	const ccAddresses = normalizeRecipients(input.cc);
	const bccAddresses = normalizeRecipients(input.bcc);
	const sender = await getAuthorizedSenderAddress(env, { ...input, organizationId });
	const quota = await getOrganizationQuota(db, organizationId);
	validateAttachments(attachments, quota);
	// Every envelope recipient becomes a contact, Bcc included: the sender chose
	// to write to them, and the row is only ever visible to the sender's own org.
	for (const address of dedupeRecipients([...toAddresses, ...ccAddresses, ...bccAddresses])) {
		await upsertContactFromAddress(env, {
			userId: input.userId,
			address,
			source: "outbound",
		});
	}
	const messageId = newId("msg");
	const snippet = buildSnippet(input.text ?? null, input.html ?? null);
	const sentAt = new Date();
	const thread = await resolveConversationForOutbound(db, {
		organizationId,
		mailboxId: sender.mailboxId,
		subject: input.subject,
		fromAddr: sender.fromAddr,
		// Threading keys off the first recipient; Cc and Bcc never start a thread.
		toAddr: toAddresses[0],
		replyToMessageId: input.replyToMessageId ?? null,
		sentAt,
	});
	// Threading headers the caller set explicitly always win.
	const headers: Record<string, string> = { ...input.headers };
	if (thread.inReplyTo && !hasHeader(headers, "in-reply-to")) headers["In-Reply-To"] = thread.inReplyTo;
	if (thread.references.length && !hasHeader(headers, "references")) {
		headers.References = thread.references.join(" ");
	}

	await db.insert(messages).values({
		id: messageId,
		organizationId,
		userId: input.userId,
		mailboxId: sender.mailboxId,
		direction: "outbound",
		fromAddr: sender.fromAddr,
		toAddr: toAddresses.join(", "),
		ccAddr: joinRecipients(ccAddresses),
		bccAddr: joinRecipients(bccAddresses),
		subject: input.subject,
		snippet,
		textBody: input.text ?? null,
		htmlBody: input.html ?? null,
		status: "queued",
		conversationId: thread.conversation.id,
		inReplyTo: headers["In-Reply-To"] ?? thread.inReplyTo,
		referencesHeader: thread.references.length ? thread.references : null,
	});
	try {
		await storeMessageAttachments(env, messageId, attachments, { quota, organizationId });
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, messageId));
		throw error;
	}
	await touchConversation(db, thread.conversation.id, sentAt);

	const jobId = newId("job");
	await db.insert(outboundJobs).values({
		id: jobId,
		userId: input.userId,
		messageId,
		status: "queued",
		payload: JSON.stringify({
			...input,
			headers: Object.keys(headers).length ? headers : undefined,
			from: sender.fromAddr,
			mailboxId: sender.mailboxId,
			attachments: attachments.map(({ content: _content, ...attachment }) => attachment),
		}),
	});

	try {
		// Books one daily send under the org usage lock; `day_key` rolls the counter.
		// A breach throws here, so the catch below fails the message and job.
		await reserveQuota(db, organizationId, { sendsToday: 1 });
		const response = await env.EMAIL.send({
			from: sender.fromAddr,
			// One recipient stays a plain string, which is exactly what the transport
			// and the Cloudflare binding have always been handed.
			to: toAddresses.length === 1 ? toAddresses[0] : toAddresses,
			cc: ccAddresses.length ? ccAddresses : undefined,
			bcc: bccAddresses.length ? bccAddresses : undefined,
			subject: input.subject,
			headers: Object.keys(headers).length ? headers : undefined,
			html: input.html,
			text: input.text,
			attachments: attachments.map((attachment) =>
				attachment.disposition === "inline" && attachment.contentId
					? {
							filename: attachment.filename,
							type: attachment.type,
							content: attachment.content,
							disposition: "inline" as const,
							contentId: attachment.contentId,
						}
					: {
							filename: attachment.filename,
							type: attachment.type,
							content: attachment.content,
							disposition: "attachment" as const,
						},
			),
		});

		await db
			.update(messages)
			.set({ status: "sent", providerMessageId: response.messageId })
			.where(eq(messages.id, messageId));
		await db.update(outboundJobs).set({ status: "sent", updatedAt: new Date() }).where(eq(outboundJobs.id, jobId));

		await dispatchWebhooks(env, input.userId, "message.outbound", {
			messageId,
			providerMessageId: response.messageId,
			to: toAddresses.join(", "),
			cc: joinRecipients(ccAddresses),
			bcc: joinRecipients(bccAddresses),
		});
		await createAuditLog(env, {
			actorUserId: input.userId,
			mailboxId: sender.mailboxId,
			messageId,
			action: "email.send",
			metadata: {
				to: toAddresses.join(", "),
				ccCount: ccAddresses.length,
				bccCount: bccAddresses.length,
				subject: input.subject,
			},
		});

		return { messageId };
	} catch (err) {
		const error = err instanceof Error ? err.message : "Send failed";
		await db.update(messages).set({ status: "failed" }).where(eq(messages.id, messageId));
		await db
			.update(outboundJobs)
			.set({ status: "failed", error, updatedAt: new Date() })
			.where(eq(outboundJobs.id, jobId));
		await dispatchWebhooks(env, input.userId, "message.failed", { messageId, error });
		throw err;
	}
}

/** Case-insensitive header presence check; RFC 5322 header names are case-insensitive. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === name);
}
