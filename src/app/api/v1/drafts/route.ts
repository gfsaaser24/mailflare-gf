import { NextResponse } from "next/server";
import { messages } from "@/db/schema";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { buildSnippet } from "@/lib/email/parse";
import { newId } from "@/lib/ids";
import { getMailboxAddress } from "../access";
import { v1DraftSchema } from "../schemas";
import { readV1Json, v1Error, v1Route } from "../route-helpers";

/**
 * `POST /api/v1/drafts` — store an unsent outbound message.
 *
 * `from` defaults to the mailbox's own address, so an agent only has to name the
 * mailbox. The sender is authorised exactly as a real send would be.
 */
export const POST = v1Route(
	async (ctx, request) => {
		const json = await readV1Json(request, 4 * 1024 * 1024);
		if ("response" in json) return json.response;
		const parsed = v1DraftSchema.safeParse(json.body);
		if (!parsed.success) return v1Error("Invalid draft", 400, "invalid_body");
		const input = parsed.data;

		const from = input.from ?? (await getMailboxAddress(ctx, input.mailboxId));
		if (!from) return v1Error("Mailbox not found", 404, "not_found");

		let sender: { fromAddr: string; mailboxId: string };
		try {
			sender = await getAuthorizedSenderAddress(ctx.env, {
				userId: ctx.user.id,
				from,
				mailboxId: input.mailboxId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Mailbox is not authorized";
			return v1Error(message, 403, "forbidden");
		}

		const id = newId("msg");
		const text = input.text ?? "";
		const html = input.html ?? "";
		await ctx.db.insert(messages).values(
			ctx.insertValues(messages, {
				id,
				userId: ctx.user.id,
				mailboxId: sender.mailboxId,
				direction: "outbound",
				fromAddr: sender.fromAddr,
				toAddr: input.to ?? "",
				subject: input.subject ?? null,
				snippet: buildSnippet(text || null, html || null),
				textBody: text || null,
				htmlBody: html || null,
				status: "draft",
				read: true,
			}),
		);

		return NextResponse.json(
			{
				draft: {
					id,
					mailboxId: sender.mailboxId,
					from: sender.fromAddr,
					to: input.to ?? "",
					subject: input.subject ?? null,
					status: "draft",
				},
			},
			{ status: 201 },
		);
	},
	{ requiredScope: "messages:write" },
);
