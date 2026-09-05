/**
 * `POST /api/auth/forgot-password` — asks for a password reset link.
 *
 * The response is identical whether or not the address belongs to an account:
 * this endpoint is unauthenticated, so any difference in status, body or shape
 * would turn it into an account-existence oracle. Everything that can differ
 * (unknown address, disabled account, no recovery address on file, a transport
 * failure) ends at the same `200 {ok:true}`.
 *
 * The link is mailed to `users.reset_email`, never to the login address: the
 * login address is a mailbox inside this app, and a user locked out of it could
 * not read the message.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { allowAttempt, rateLimitKeyForRequest } from "@/lib/auth/rate-limit";
import { authLinkUrl, passwordResetEmail } from "@/lib/auth/email-templates";
import { issueAuthToken } from "@/lib/auth/tokens";
import { verifyTurnstileToken } from "@/lib/auth/turnstile";
import { getEnv } from "@/lib/cloudflare";
import { sendSystemEmail } from "@/lib/email/system";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getClientIp } from "@/lib/http/ip";
import { readJsonBody } from "@/lib/http/request";
import {
	PASSWORD_RESET_TTL_MS,
	deferRecoveryWork,
	forgotPasswordSchema,
	normaliseEmail,
	recordRecoveryActivity,
} from "./utils";

/** The one answer this route ever gives once the request itself is well formed. */
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

	const parsed = forgotPasswordSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
	}
	const email = normaliseEmail(parsed.data.email);

	// Order matters: per-IP, then the bot check, then per-EMAIL. The per-email
	// budget is three an hour and is the only limiter an attacker can aim at
	// somebody else's account, so it must not be spendable by a request that
	// never passed Turnstile — that turned a cheap flood into a denial of
	// password resets for a chosen address.
	if (!(await allowAttempt(env, "recovery", rateLimitKeyForRequest(request)))) {
		return NextResponse.json(
			{ error: "Too many requests. Try again shortly." },
			{ status: 429, headers: { "Retry-After": "900" } },
		);
	}

	if (!(await verifyTurnstileToken(env, request, (body as Record<string, unknown>).turnstileToken))) {
		return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 400 });
	}

	if (!(await allowAttempt(env, "recoveryPerEmail", email))) {
		return NextResponse.json(
			{ error: "Too many requests. Try again shortly." },
			{ status: 429, headers: { "Retry-After": "3600" } },
		);
	}

	// Checked before the lookup: a 500 that only fired for real accounts would
	// itself leak which addresses exist.
	try {
		authLinkUrl(env, "/reset-password");
	} catch {
		return NextResponse.json(
			{ error: "This server is missing APP_URL, so reset links cannot be sent." },
			{ status: 500 },
		);
	}

	const db = getDb(env);
	const [user] = await db
		.select({
			id: users.id,
			disabled: users.disabled,
			resetEmail: users.resetEmail,
		})
		.from(users)
		.where(eq(users.email, email))
		.limit(1);

	const recoveryAddress = user?.resetEmail?.trim();
	if (!user || user.disabled || !recoveryAddress) return neutral();

	// Detached on purpose: issuing the token and calling the mail transport is
	// the only work a known address does that an unknown one does not, so
	// awaiting it here made the response time answer the question the body
	// refuses to. The audit row goes with it, for the same reason.
	const requestIp = getClientIp(request, env);
	const userId = user.id;
	deferRecoveryWork("Password reset email", async () => {
		const token = await issueAuthToken(env, {
			userId,
			purpose: "password_reset",
			ttlMs: PASSWORD_RESET_TTL_MS,
			requestIp,
		});
		const mail = passwordResetEmail({
			url: authLinkUrl(env, `/reset-password?token=${encodeURIComponent(token)}`),
			requestIp,
			expiresInMinutes: PASSWORD_RESET_TTL_MS / 60_000,
		});
		await sendSystemEmail(env, {
			to: recoveryAddress,
			subject: mail.subject,
			text: mail.text,
			html: mail.html,
		});
		await recordRecoveryActivity(env, {
			action: "auth.password_reset_requested",
			userId,
			request,
		});
	});
	return neutral();
}
