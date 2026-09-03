/**
 * `POST /api/auth/reset-password` — spends a reset link and sets the password.
 *
 * Rules that must not be lost:
 * - the token is spent by `consumeAuthToken` before anything is written, so a
 *   replay of the same link cannot set the password twice;
 * - every session of that user is deleted, because a reset is what someone who
 *   has lost control of the account does: leaving old sessions alive would keep
 *   the intruder signed in;
 * - no session is minted here. The user is sent back to `/login` and has to type
 *   the new password, so possession of the mailbox alone is never a login.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { allowAttempt, rateLimitKeyForRequest } from "@/lib/auth/rate-limit";
import { consumeAuthToken } from "@/lib/auth/tokens";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { recordRecoveryActivity } from "../forgot-password/utils";
import { resetPasswordSchema } from "./utils";

const INVALID_TOKEN = {
	error: "This link is no longer valid. Ask for a new one.",
	invalidToken: true,
};

export async function POST(request: Request) {
	const env = getEnv();

	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid request" }, { status });
	}

	const parsed = resetPasswordSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Choose a password of at least 8 characters." },
			{ status: 400 },
		);
	}

	// Guessing a token is hopeless, but an unthrottled endpoint that reports
	// "valid" vs "invalid" is still a free oracle; cap it per IP.
	if (!(await allowAttempt(env, "recovery", rateLimitKeyForRequest(request)))) {
		return NextResponse.json(
			{ error: "Too many attempts. Try again shortly." },
			{ status: 429, headers: { "Retry-After": "900" } },
		);
	}

	const consumed = await consumeAuthToken(env, {
		token: parsed.data.token,
		purpose: "password_reset",
	});
	if (!consumed) return NextResponse.json(INVALID_TOKEN, { status: 400 });

	const db = getDb(env);
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, consumed.userId))
		.limit(1);
	if (!user) return NextResponse.json(INVALID_TOKEN, { status: 400 });

	const passwordHash = hashPassword(parsed.data.password);
	await db.transaction(async (tx) => {
		await tx
			.update(users)
			.set({ passwordHash, passwordChangedAt: new Date() })
			.where(eq(users.id, user.id));
		await tx.delete(sessions).where(eq(sessions.userId, user.id));
	});

	await recordRecoveryActivity(env, {
		action: "auth.password_reset",
		userId: user.id,
		request,
	});

	const response = NextResponse.json({ ok: true, redirect: "/login" });
	response.headers.set("Cache-Control", "no-store");
	return response;
}
