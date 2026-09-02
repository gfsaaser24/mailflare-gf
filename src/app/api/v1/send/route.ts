import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { sendEmailSchema } from "@/lib/validators";
import { sendEmail } from "@/lib/email/send";
import { decodeBase64Content } from "@/lib/email/attachments";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getSendErrorStatus } from "@/app/api/send/error-utils";

export const POST = withOrg(
	async ({ env, user }, request) => {
		let body: unknown;
		try {
			body = await readJsonBody(request, 30 * 1024 * 1024);
		} catch (error) {
			const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
			return NextResponse.json({ error: "Invalid send request" }, { status });
		}
		const parsed = sendEmailSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
		}

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
		} catch (err) {
			const message = err instanceof Error ? err.message : "Send failed";
			return NextResponse.json({ error: message }, { status: getSendErrorStatus(message) });
		}
	},
	{ allowApiKey: true, requiredScope: "send" },
);
