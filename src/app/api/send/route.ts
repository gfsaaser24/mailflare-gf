import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUserForRoute } from "@/lib/auth/cookies";
import { sendEmailSchema } from "@/lib/validators";
import { sendEmail } from "@/lib/email/send";
import { parseSendRequest } from "./utils";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getSendErrorStatus } from "./error-utils";

export async function POST(request: Request) {
	const env = getEnv();
	// `requireUserForRoute` answers 401 for an anonymous caller (the old
	// `requireUser` threw, which the router turned into a 500) and applies the
	// organisation's two-factor policy, which this route used to skip.
	const auth = await requireUserForRoute(env, request);
	if (!auth.ok) return auth.response;
	const user = auth.user;
	let input;
	try {
		input = await parseSendRequest(request);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid send request" }, { status });
	}
	const { attachments, ...fields } = input;
	const parsed = sendEmailSchema.omit({ attachments: true }).safeParse(fields);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	try {
		const result = await sendEmail(env, {
			userId: user.id,
			...parsed.data,
			attachments,
		});
		return NextResponse.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Send failed";
		return NextResponse.json({ error: message }, { status: getSendErrorStatus(message) });
	}
}
