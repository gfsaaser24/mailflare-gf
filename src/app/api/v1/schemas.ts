/** Request bodies and query strings for the v1 API (T6.2). */
import { z } from "zod";
import { MAX_RECIPIENTS, normalizeRecipients } from "@/lib/email/recipients";

/**
 * A draft recipient field: one address, several separated by `,`/`;`, or an
 * array. Unlike a send, a draft is not required to hold valid addresses — it is
 * half-written by definition — so only the shape and the total count are checked.
 */
const draftRecipientField = z
	.union([z.string().max(8000), z.array(z.string().max(500)).max(MAX_RECIPIENTS)])
	.transform((value) => normalizeRecipients(value));

/** `POST /api/v1/conversations/[id]/reply`. */
export const v1ReplySchema = z
	.object({
		/** Defaults to the newest inbound sender on the conversation. */
		to: z.string().min(3).max(500).optional(),
		/** Defaults to `Re: <conversation subject>`. */
		subject: z.string().min(1).max(500).optional(),
		text: z
			.string()
			.max(2 * 1024 * 1024)
			.optional(),
		html: z
			.string()
			.max(2 * 1024 * 1024)
			.optional(),
		/** Defaults to the newest message in the conversation that has a Message-ID. */
		replyToMessageId: z.string().min(1).max(200).optional(),
	})
	.refine((value) => !!value.text || !!value.html, { message: "text or html is required" });

/** `PATCH /api/v1/messages/[id]`. */
export const v1MessagePatchSchema = z
	.object({
		read: z.boolean().optional(),
		starred: z.boolean().optional(),
		status: z.enum(["received", "sent", "draft", "trash", "spam"]).optional(),
		/** An ISO timestamp in the future, or `null` to clear the snooze. */
		snoozedUntil: z
			.union([z.string().datetime({ offset: true }), z.string().datetime(), z.null()])
			.optional(),
	})
	.refine((value) => Object.values(value).some((field) => field !== undefined), {
		message: "Nothing to update",
	});

/** `GET /api/v1/search`. */
export const v1SearchQuerySchema = z.object({
	q: z.string().trim().min(1).max(200),
	mailboxId: z.string().min(1).max(200).optional(),
	cursor: z.string().min(1).max(500).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** `GET /api/v1/contacts`. */
export const v1ContactQuerySchema = z.object({
	/** Case-insensitive substring match on the address or display name. */
	q: z.string().trim().min(1).max(200).optional(),
	cursor: z.string().min(1).max(500).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** `POST /api/v1/drafts`. */
export const v1DraftSchema = z
	.object({
		mailboxId: z.string().min(1).max(200),
		/** Defaults to the mailbox's own address. */
		from: z.string().min(3).max(500).optional(),
		to: z.string().max(500).optional(),
		cc: draftRecipientField.optional(),
		bcc: draftRecipientField.optional(),
		subject: z.string().max(500).optional(),
		text: z
			.string()
			.max(2 * 1024 * 1024)
			.optional(),
		html: z
			.string()
			.max(2 * 1024 * 1024)
			.optional(),
	})
	// The ceiling is the envelope one a send has: `to` + `cc` + `bcc` together,
	// not per field.
	.refine(
		(value) =>
			normalizeRecipients(value.to).length + (value.cc?.length ?? 0) + (value.bcc?.length ?? 0) <=
			MAX_RECIPIENTS,
		{ message: `A message can have at most ${MAX_RECIPIENTS} recipients in total`, path: ["to"] },
	);
