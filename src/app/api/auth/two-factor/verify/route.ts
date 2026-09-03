/**
 * `POST /api/auth/two-factor/verify` — the second login step.
 *
 * This is the only route that runs on a *pending* session: the password step
 * has passed, `getUserFromSession()` still refuses the cookie, and nothing in
 * the app is reachable until this promotes it.
 *
 * Body: `{ code }` — a six-digit authenticator code or an `xxxx-xxxx` backup
 * code, which is burnt on use. Rate limited per session (5 per 5 minutes), so
 * the ten thousand six-digit codes cannot be walked. Every failure returns the
 * same generic message.
 */
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { recordAuthActivity } from "@/lib/auth/activity";
import { decryptSecret } from "@/lib/auth/crypto";
import { setSessionCookie } from "@/lib/auth/login-flow";
import { allowAttempt } from "@/lib/auth/rate-limit";
import {
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
	getPendingTwoFactorSession,
	promotePendingSession,
} from "@/lib/auth/session";
import {
	consumeBackupCode,
	isBackupCodeFormat,
	serializeBackupCodeHashes,
	verifyTotpCode,
} from "@/lib/auth/totp";
import { getEnv } from "@/lib/cloudflare";
import { asString, readTwoFactorBody } from "../shared";

/** One message for every rejection: never say which half was wrong. */
const INVALID = "That code is not right. Try again.";

export async function POST(request: Request) {
	const env = getEnv();
	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;

	const pending = await getPendingTwoFactorSession(env, token);
	// No pending session: expired, already promoted, or never existed.
	if (!pending || !token) {
		return NextResponse.json({ error: "Your sign-in expired. Start again." }, { status: 401 });
	}

	// Keyed by the session, not the IP: one browser's attempts are its own.
	if (!(await allowAttempt(env, "twoFactor", pending.session.id))) {
		return NextResponse.json(
			{ error: "Too many attempts. Try again shortly." },
			{ status: 429, headers: { "Retry-After": "60" } },
		);
	}

	const body = await readTwoFactorBody(request);
	const code = asString(body.code);
	if (!code) return NextResponse.json({ error: INVALID }, { status: 400 });

	const db = getDb(env);
	const user = pending.user;
	let method: "totp" | "backup_code" | null = null;

	if (isBackupCodeFormat(code)) {
		const result = consumeBackupCode(user.totpBackupCodes, code);
		if (result.matched) {
			// Burn it before the session is promoted: a code must work once even
			// if the promotion below fails.
			await db
				.update(users)
				.set({ totpBackupCodes: serializeBackupCodeHashes(result.remainingHashes) })
				.where(and(eq(users.id, user.id), eq(users.organizationId, user.organizationId)));
			method = "backup_code";
		}
	} else if (user.totpSecretEncrypted) {
		try {
			if (await verifyTotpCode(decryptSecret(env, user.totpSecretEncrypted), code)) {
				method = "totp";
			}
		} catch {
			// Unreadable secret: treated as a failed code, never a 500.
			method = null;
		}
	}

	if (!method) return NextResponse.json({ error: INVALID }, { status: 400 });

	if (!(await promotePendingSession(env, token))) {
		return NextResponse.json({ error: "Your sign-in expired. Start again." }, { status: 401 });
	}

	await recordAuthActivity(env, {
		action: "auth.login",
		userId: user.id,
		request,
		details: { method },
	});

	const response = NextResponse.json({ ok: true, redirect: "/inbox" });
	response.headers.set("Cache-Control", "no-store");
	// The pending cookie had a 10-minute max-age; the promoted session is 30 days.
	return setSessionCookie(response, token, SESSION_MAX_AGE_SECONDS);
}
