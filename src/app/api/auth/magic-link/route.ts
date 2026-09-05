/**
 * `POST /api/auth/magic-link` — asks for a passwordless sign-in link.
 *
 * Same contract as `/api/auth/forgot-password`: one answer for every outcome, so
 * the endpoint cannot be used to enumerate accounts. The link is mailed to
 * `users.reset_email`, the address the account nominated for recovery, never to
 * the login address (which is a mailbox inside this app).
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authLinkUrl, magicLinkEmail } from "@/lib/auth/email-templates";
import { allowAttempt, rateLimitKeyForRequest } from "@/lib/auth/rate-limit";
import { issueAuthToken } from "@/lib/auth/tokens";
import { verifyTurnstileToken } from "@/lib/auth/turnstile";
import { getEnv } from "@/lib/cloudflare";
import { sendSystemEmail } from "@/lib/email/system";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getClientIp } from "@/lib/http/ip";
import { readJsonBody } from "@/lib/http/request";
import {
	deferRecoveryWork,
	normaliseEmail,
	recordRecoveryActivity,
} from "../forgot-password/utils";
import { MAGIC_LINK_TTL_MS, magicLinkRequestSchema } from "./utils";

function neutral(): NextResponse {
	const response = NextResponse.json({ ok: true });
	response.headers.set("Cache-Control", "no-store");
	return response;
}

export async function POST(request: Request) {
	const env = getEnv();

	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid request" }, { status });
	}

	const parsed = magicLinkRequestSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
	}
	const email = normaliseEmail(parsed.data.email);

	// Per-IP, then the bot check, then per-EMAIL: the per-email budget is the
	// one an attacker can aim at somebody else's account, so a request that
	// never passed Turnstile must not be able to spend it.
	if (!(await allowAttempt(env, "magicLink", rateLimitKeyForRequest(request)))) {
		return NextResponse.json(
			{ error: "Too many requests. Try again shortly." },
			{ status: 429, headers: { "Retry-After": "900" } },
		);
	}

	if (!(await verifyTurnstileToken(env, request, (body as Record<string, unknown>).turnstileToken))) {
		return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 400 });
	}

	if (!(await allowAttempt(env, "magicLinkPerEmail", email))) {
		return NextResponse.json(
			{ error: "Too many requests. Try again shortly." },
			{ status: 429, headers: { "Retry-After": "3600" } },
		);
	}

	// Checked before the lookup: a 500 that only fired for real accounts would
	// itself leak which addresses exist.
	try {
		authLinkUrl(env, "/magic-link/verify");
	} catch {
		return NextResponse.json(
			{ error: "This server is missing APP_URL, so sign-in links cannot be sent." },
			{ status: 500 },
		);
	}

	const db = getDb(env);
	const [user] = await db
		.select({ id: users.id, disabled: users.disabled, resetEmail: users.resetEmail })
		.from(users)
		.where(eq(users.email, email))
		.limit(1);

	const recoveryAddress = user?.resetEmail?.trim();
	if (!user || user.disabled || !recoveryAddress) return neutral();

	// Detached, exactly as in `/api/auth/forgot-password`: the token insert and
	// the call to the mail transport are the only work a known address does, so
	// awaiting them here timed the answer the body refuses to give.
	const requestIp = getClientIp(request, env);
	const userId = user.id;
	deferRecoveryWork("Magic link email", async () => {
		const token = await issueAuthToken(env, {
			userId,
			purpose: "magic_link",
			ttlMs: MAGIC_LINK_TTL_MS,
			requestIp,
		});
		const mail = magicLinkEmail({
			url: authLinkUrl(env, `/magic-link/verify?token=${encodeURIComponent(token)}`),
			requestIp,
			expiresInMinutes: MAGIC_LINK_TTL_MS / 60_000,
		});
		await sendSystemEmail(env, {
			to: recoveryAddress,
			subject: mail.subject,
			text: mail.text,
			html: mail.html,
		});
		await recordRecoveryActivity(env, {
			action: "auth.magic_link_requested",
			userId,
			request,
		});
	});
	return neutral();
}
