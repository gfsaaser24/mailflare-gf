/**
 * `POST /api/auth/two-factor/verify` — the second login step.
 *
 * This is the only route that runs on a *pending* session: the password step
 * has passed, `getUserFromSession()` still refuses the cookie, and nothing in
 * the app is reachable until this promotes it.
 *
 * Body: `{ code }` — a six-digit authenticator code or an `xxxx-xxxx` backup
 * code, which is burnt on use. Every failure returns the same generic message.
 *
 * Rate limiting is keyed on the USER (5 per 5 minutes) and, separately, on the
 * caller's IP (20 per 5 minutes); either bucket being empty refuses the
 * attempt. It used to be keyed on the pending session, which was no budget at
 * all: `/api/auth/login` mints a fresh pending session on every call, so an
 * attacker walking the ten thousand six-digit codes only had to sign in again
 * every five tries. Five consecutive failures also destroy the pending session,
 * forcing the password step to be repeated.
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
import { getClientIp } from "@/lib/http/ip";
import {
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
	deleteSession,
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
/** The one answer for "there is nothing here to verify against". */
const EXPIRED = "Your sign-in expired. Start again.";

/**
 * Consecutive failures per user, in process.
 *
 * The limiters bound how FAST codes can be tried; this bounds how many wrong
 * codes one half-authenticated session survives at all. Reaching the threshold
 * deletes the pending session, so the attacker is sent back to the password
 * step. Cleared on success, and forgotten once the window lapses.
 *
 * In memory on purpose: the app runs as a single container, and the alternative
 * is a schema change on the login path.
 */
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 5;
const failures = new Map<string, { count: number; at: number }>();

/** Records one failure for this user and returns the new consecutive count. */
function recordFailure(userId: string): number {
	const now = Date.now();
	const previous = failures.get(userId);
	const count = previous && now - previous.at < FAILURE_WINDOW_MS ? previous.count + 1 : 1;
	failures.set(userId, { count, at: now });
	return count;
}

function tooManyRequests(): NextResponse {
	return NextResponse.json(
		{ error: "Too many attempts. Try again shortly." },
		{ status: 429, headers: { "Retry-After": "60" } },
	);
}

export async function POST(request: Request) {
	const env = getEnv();
	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;

	// Checked before anything is read from the database, so an unauthenticated
	// flood costs one map lookup.
	if (!(await allowAttempt(env, "twoFactorPerIp", `ip:${getClientIp(request, env)}`))) {
		return tooManyRequests();
	}

	const pending = await getPendingTwoFactorSession(env, token);
	// No pending session: expired, already promoted, destroyed by too many
	// failures, or never existed.
	if (!pending || !token) {
		return NextResponse.json({ error: EXPIRED }, { status: 401 });
	}

	// Keyed by the user: a fresh pending session is one `/api/auth/login` away,
	// so a session key is a budget the attacker resets at will.
	if (!(await allowAttempt(env, "twoFactor", `user:${pending.user.id}`))) {
		return tooManyRequests();
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

	if (!method) {
		if (recordFailure(user.id) >= MAX_CONSECUTIVE_FAILURES) {
			// The half-authenticated session is spent: prove the password again.
			failures.delete(user.id);
			await deleteSession(env, token);
			return NextResponse.json({ error: EXPIRED }, { status: 401 });
		}
		return NextResponse.json({ error: INVALID }, { status: 400 });
	}
	failures.delete(user.id);

	if (!(await promotePendingSession(env, token))) {
		return NextResponse.json({ error: EXPIRED }, { status: 401 });
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
