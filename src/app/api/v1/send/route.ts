import { NextResponse } from "next/server";
import { getSendErrorStatus } from "@/app/api/send/error-utils";
import { decodeBase64Content } from "@/lib/email/attachments";
import { sendEmail } from "@/lib/email/send";
import { sendEmailSchema } from "@/lib/validators";
import { readV1Json, v1Error, v1Route } from "../route-helpers";

/**
 * `POST /api/v1/send` — send a new message.
 *
 * Declared with `v1Route` like every other v1 route, so it shares the per-key
 * rate limit and the `{ error, code }` error shape.
 */
export const POST = v1Route(
	async ({ env, user }, request) => {
		const json = await readV1Json(request, 30 * 1024 * 1024);
		if ("response" in json) return json.response;

		const parsed = sendEmailSchema.safeParse(json.body);
		if (!parsed.success) return v1Error("Invalid send request", 400, "invalid_body");

		try {
			const { attachments, ...fields } = parsed.data;
			const result = await sendEmail(env, {
				userId: user.id,
				...fields,
				attachments: attachments?.map((attachment) => ({
					filename: attachment.filename,
					type: attachment.type,
					content: decodeBase64Content(attachment.contentBase64),
					disposition: "attachment",
				})),
			});
			return NextResponse.json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Send failed";
			return v1Error(message, getSendErrorStatus(message), "send_failed");
		}
	},
	{ requiredScope: "send" },
);
