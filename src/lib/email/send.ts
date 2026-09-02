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
import type { AttachmentContent } from "@/lib/email/attachment-types";

export type SendEmailInput = {
	userId: string;
	from: string;
	to: string;
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
	const sender = await getAuthorizedSenderAddress(env, input);
	const attachments = input.attachments ?? [];
	validateAttachments(attachments);
	await upsertContactFromAddress(env, {
		userId: input.userId,
		address: input.to,
		source: "outbound",
	});
	const messageId = newId("msg");
	const snippet = buildSnippet(input.text ?? null, input.html ?? null);
	const sentAt = new Date();
	const thread = await resolveConversationForOutbound(db, {
		mailboxId: sender.mailboxId,
		subject: input.subject,
		fromAddr: sender.fromAddr,
		toAddr: input.to,
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
		userId: input.userId,
		mailboxId: sender.mailboxId,
		direction: "outbound",
		fromAddr: sender.fromAddr,
		toAddr: input.to,
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
		await storeMessageAttachments(env, messageId, attachments);
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
		const response = await env.EMAIL.send({
			from: sender.fromAddr,
			to: input.to,
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
			to: input.to,
		});
		await createAuditLog(env, {
			actorUserId: input.userId,
			mailboxId: sender.mailboxId,
			messageId,
			action: "email.send",
			metadata: { to: input.to, subject: input.subject },
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
