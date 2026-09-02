import { and, desc, eq, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSendErrorStatus } from "@/app/api/send/error-utils";
import { messages } from "@/db/schema";
import { normalizeSubject } from "@/lib/conversations/service";
import { sendEmail } from "@/lib/email/send";
import { getMailboxAddress, requireConversation } from "../../../access";
import { v1ReplySchema } from "../../../schemas";
import { readV1Json, v1Error, v1Route, type IdRouteContext } from "../../../route-helpers";

/**
 * `POST /api/v1/conversations/[id]/reply` — send into an existing thread.
 *
 * Everything but the body is optional: the recipient, the subject and the
 * message being answered are all derived from the conversation, so an agent can
 * reply with `{ "text": "..." }`. `In-Reply-To`/`References` come from
 * `sendEmail`, which threads the outbound row into the same conversation.
 */
export const POST = v1Route<IdRouteContext>(
	async (ctx, request, { params }) => {
		const { id } = await params;

		const json = await readV1Json(request, 4 * 1024 * 1024);
		if ("response" in json) return json.response;
		const parsed = v1ReplySchema.safeParse(json.body);
		if (!parsed.success) return v1Error("Invalid reply", 400, "invalid_body");

		const access = await requireConversation(ctx, id, "send_on_behalf");
		if ("response" in access) return access.response;
		const { conversation } = access;

		const from = await getMailboxAddress(ctx, conversation.mailboxId);
		if (!from) return v1Error("Mailbox not found", 404, "not_found");

		// The newest stored message that carries a Message-ID is the one a reply
		// should answer; it is also the best source for the recipient.
		const [parent] = await ctx.db
			.select({
				id: messages.id,
				direction: messages.direction,
				fromAddr: messages.fromAddr,
				toAddr: messages.toAddr,
			})
			.from(messages)
			.where(
				and(
					ctx.scoped(messages),
					eq(messages.conversationId, conversation.id),
					isNotNull(messages.providerMessageId),
				),
			)
			.orderBy(desc(messages.createdAt), desc(messages.id))
			.limit(1);

		const to =
			parsed.data.to ?? (parent?.direction === "inbound" ? parent.fromAddr : parent?.toAddr);
		if (!to) return v1Error("No recipient for this conversation", 400, "no_recipient");

		const subject = parsed.data.subject ?? replySubject(conversation.subject);

		try {
			const result = await sendEmail(ctx.env, {
				userId: ctx.user.id,
				from,
				to,
				subject,
				text: parsed.data.text,
				html: parsed.data.html,
				mailboxId: conversation.mailboxId,
				replyToMessageId: parsed.data.replyToMessageId ?? parent?.id ?? null,
			});
			const [sent] = await ctx.db
				.select({
					id: messages.id,
					conversationId: messages.conversationId,
					inReplyTo: messages.inReplyTo,
					status: messages.status,
				})
				.from(messages)
				.where(and(ctx.scoped(messages), eq(messages.id, result.messageId)))
				.limit(1);
			return NextResponse.json({ message: sent ?? { id: result.messageId } }, { status: 201 });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Send failed";
			return v1Error(message, getSendErrorStatus(message), "send_failed");
		}
	},
	{ requiredScope: "send" },
);

/** `Re: ` exactly once, whatever prefixes the stored subject already carries. */
function replySubject(subject: string | null): string {
	const bare = normalizeSubject(subject);
	if (!bare) return "Re:";
	const original = (subject ?? "").trim();
	return /^re\s*:/i.test(original) ? original : `Re: ${original}`;
}
