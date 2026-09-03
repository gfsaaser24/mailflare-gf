/**
 * `POST /api/auth/magic-link/consume` — spends a sign-in link and logs in.
 *
 * Deliberately POST-only and on its own path: mail scanners and link previewers
 * fetch every URL in a message with GET, and a GET that logged in would burn the
 * link (or hand a session to the scanner). `/magic-link/verify` renders a button
 * instead; this route is what the button calls.
 *
 * The session, the cookie flags and the two-factor gate all come from
 * `completeLogin()`, so a magic-link sign-in cannot drift from a password one.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { completeLogin } from "@/lib/auth/login-flow";
import { allowAttempt, rateLimitKeyForRequest } from "@/lib/auth/rate-limit";
import { consumeAuthToken } from "@/lib/auth/tokens";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { magicLinkConsumeSchema } from "../utils";

const INVALID_TOKEN = { error: "This sign-in link is no longer valid. Ask for a new one." };

export async function POST(request: Request) {
	const env = getEnv();

	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid request" }, { status });
	}

	const parsed = magicLinkConsumeSchema.safeParse(body);
	if (!parsed.success) return NextResponse.json(INVALID_TOKEN, { status: 400 });

	if (!(await allowAttempt(env, "magicLink", rateLimitKeyForRequest(request)))) {
		return NextResponse.json(
			{ error: "Too many attempts. Try again shortly." },
			{ status: 429, headers: { "Retry-After": "900" } },
		);
	}

	const consumed = await consumeAuthToken(env, {
		token: parsed.data.token,
		purpose: "magic_link",
	});
	if (!consumed) return NextResponse.json(INVALID_TOKEN, { status: 400 });

	const db = getDb(env);
	const [user] = await db
		.select({ id: users.id, disabled: users.disabled, totpEnabledAt: users.totpEnabledAt })
		.from(users)
		.where(eq(users.id, consumed.userId))
		.limit(1);
	if (!user) return NextResponse.json(INVALID_TOKEN, { status: 400 });
	// The account may have been disabled after the link was mailed.
	if (user.disabled) return NextResponse.json({ error: "Account disabled" }, { status: 403 });

	return completeLogin(env, request, user, { method: "magic_link" });
}
