/**
 * Password recovery and magic-link sign-in.
 *
 * The properties under test are the ones a regression would quietly undo:
 * a link is spendable exactly once, a reset revokes every session, a disabled
 * account cannot ride a link that was mailed before it was disabled, and the
 * request endpoints answer identically for an address that exists and one that
 * does not (an unequal answer is an account-existence oracle).
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { authTokens, sessions, users } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { consumeAuthToken, issueAuthToken } from "@/lib/auth/tokens";
import { flushRecoveryWork } from "@/app/api/auth/forgot-password/utils";
import { newId } from "@/lib/ids";
import { createDb, hasTestDatabase } from "./helpers/db";

/** A distinct IP per test keeps the in-process rate limiters from interfering. */
function post(url: string, body: unknown, ip: string): Request {
	return new Request("http://localhost" + url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-real-ip": ip },
		body: JSON.stringify(body),
	});
}

function testEnv(): CloudflareEnv {
	return { DB: createDb() } as unknown as CloudflareEnv;
}

describe.skipIf(!hasTestDatabase())("password recovery and magic links", () => {
	beforeAll(() => {
		// The route handlers build their env from process.env, once.
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		process.env.APP_URL = "https://mail.test";
		// No transport and no Turnstile: system mail goes to the noop sender and
		// `verifyTurnstileToken` passes when no secret is configured.
		delete process.env.EDGE_WORKER_URL;
		delete process.env.EDGE_WORKER_SECRET;
		delete process.env.TURNSTILE_SECRET_KEY;
		process.env.SYSTEM_EMAIL_FROM = "no-reply@mail.test";
	});

	async function seedUser(input: {
		email: string;
		password?: string;
		resetEmail?: string | null;
		disabled?: boolean;
	}): Promise<string> {
		const id = newId("usr");
		await createDb()
			.insert(users)
			.values({
				id,
				email: input.email,
				passwordHash: hashPassword(input.password ?? "old-password-123"),
				name: "Recovery user",
				resetEmail: input.resetEmail === undefined ? "recovery@elsewhere.test" : input.resetEmail,
				disabled: input.disabled ?? false,
			});
		return id;
	}

	async function tokenCount(userId: string, purpose: "password_reset" | "magic_link") {
		const rows = await createDb()
			.select({ id: authTokens.id })
			.from(authTokens)
			.where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose)));
		return rows.length;
	}

	it("spends an auth token exactly once", async () => {
		const env = testEnv();
		const userId = await seedUser({ email: "once@recovery.test" });

		const token = await issueAuthToken(env, {
			userId,
			purpose: "password_reset",
			ttlMs: 30 * 60 * 1000,
		});

		await expect(consumeAuthToken(env, { token, purpose: "password_reset" })).resolves.toEqual({
			userId,
		});
		// Second redemption of the same link must find nothing left to spend.
		await expect(consumeAuthToken(env, { token, purpose: "password_reset" })).resolves.toBeNull();
		// And it is not spendable under a different purpose either.
		await expect(consumeAuthToken(env, { token, purpose: "magic_link" })).resolves.toBeNull();
	});

	it("issues a reset link for a known account without saying so", async () => {
		const userId = await seedUser({ email: "known@recovery.test" });
		const { POST } = await import("@/app/api/auth/forgot-password/route");

		const response = await POST(
			post("/api/auth/forgot-password", { email: "known@recovery.test" }, "10.0.0.11"),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toEqual({ ok: true });
		// No token, no address, nothing that distinguishes this from a miss.
		expect(JSON.stringify(body)).not.toContain("tok_");
		// Issuing and mailing the link is detached from the response, so that a
		// known address and an unknown one take the same time. Wait for it.
		await flushRecoveryWork();
		expect(await tokenCount(userId, "password_reset")).toBe(1);
	});

	it("answers an unknown address with the same 200 and issues nothing", async () => {
		const { POST } = await import("@/app/api/auth/forgot-password/route");

		const response = await POST(
			post("/api/auth/forgot-password", { email: "nobody@recovery.test" }, "10.0.0.12"),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		await flushRecoveryWork();
		const rows = await createDb().select({ id: authTokens.id }).from(authTokens);
		expect(rows).toHaveLength(0);
	});

	it("resets the password, revokes every session and refuses the spent link", async () => {
		const env = testEnv();
		const db = createDb();
		const userId = await seedUser({ email: "reset@recovery.test", password: "old-password-123" });
		await createSession(env, userId);
		await createSession(env, userId);

		const token = await issueAuthToken(env, {
			userId,
			purpose: "password_reset",
			ttlMs: 30 * 60 * 1000,
		});
		const { POST } = await import("@/app/api/auth/reset-password/route");

		const response = await POST(
			post("/api/auth/reset-password", { token, password: "brand-new-password" }, "10.0.0.13"),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, redirect: "/login" });
		// No session is handed out by a reset: the new password has to be typed.
		expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();

		const [row] = await db
			.select({ passwordHash: users.passwordHash, passwordChangedAt: users.passwordChangedAt })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		expect(verifyPassword("brand-new-password", row!.passwordHash)).toBe(true);
		expect(verifyPassword("old-password-123", row!.passwordHash)).toBe(false);
		expect(row!.passwordChangedAt).toBeInstanceOf(Date);

		const remaining = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.userId, userId));
		expect(remaining).toHaveLength(0);

		const replay = await POST(
			post("/api/auth/reset-password", { token, password: "another-password-1" }, "10.0.0.13"),
		);
		expect(replay.status).toBe(400);
		expect((await replay.json()) as Record<string, unknown>).toMatchObject({ invalidToken: true });
	});

	it("refuses a magic link for a disabled account", async () => {
		const env = testEnv();
		const userId = await seedUser({ email: "disabled@recovery.test", disabled: true });
		// Issued as if the account had been disabled after the link was mailed.
		const token = await issueAuthToken(env, {
			userId,
			purpose: "magic_link",
			ttlMs: 15 * 60 * 1000,
		});
		const { POST } = await import("@/app/api/auth/magic-link/consume/route");

		const response = await POST(post("/api/auth/magic-link/consume", { token }, "10.0.0.14"));

		expect(response.status).toBe(403);
		expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();

		const live = await createDb()
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.userId, userId));
		expect(live).toHaveLength(0);
	});

	it("signs in through a magic link and leaves the token spent", async () => {
		const env = testEnv();
		const userId = await seedUser({ email: "magic@recovery.test" });
		const token = await issueAuthToken(env, {
			userId,
			purpose: "magic_link",
			ttlMs: 15 * 60 * 1000,
		});
		const { POST } = await import("@/app/api/auth/magic-link/consume/route");

		const response = await POST(post("/api/auth/magic-link/consume", { token }, "10.0.0.15"));

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toEqual({ ok: true, redirect: "/inbox" });
		// The session token lives only in the httpOnly cookie.
		expect(JSON.stringify(body)).not.toContain("sess_");
		expect(response.cookies.get(SESSION_COOKIE)?.httpOnly).toBe(true);
		expect(userId).toBeTruthy();

		const replay = await POST(post("/api/auth/magic-link/consume", { token }, "10.0.0.15"));
		expect(replay.status).toBe(400);
	});

	it("does not issue a link for an account with no recovery address", async () => {
		const userId = await seedUser({ email: "noaddress@recovery.test", resetEmail: null });
		const { POST } = await import("@/app/api/auth/magic-link/route");

		const response = await POST(
			post("/api/auth/magic-link", { email: "noaddress@recovery.test" }, "10.0.0.16"),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		await flushRecoveryWork();
		expect(await tokenCount(userId, "magic_link")).toBe(0);
	});

	/**
	 * The per-email budget is three an hour and is the only limiter an attacker
	 * can point at somebody else's address, so a request that never passed the
	 * bot check must not be able to spend it.
	 */
	it("does not spend the per-email budget when Turnstile fails", async () => {
		const email = "turnstile@recovery.test";
		const userId = await seedUser({ email });
		const { POST } = await import("@/app/api/auth/forgot-password/route");

		// `getEnv()` is built once per process, so the secret is set on the live
		// env object rather than on process.env.
		const { getEnv } = await import("@/lib/env");
		const env = getEnv();
		env.TURNSTILE_SECRET_KEY = "test-secret";
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ success: false }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as typeof fetch;

		try {
			// Four refusals: one more than the per-email budget would allow.
			for (let i = 0; i < 4; i++) {
				const blocked = await POST(
					post("/api/auth/forgot-password", { email, turnstileToken: "x" }, "10.0.0.20"),
				);
				expect(blocked.status, `attempt ${i + 1}`).toBe(400);
			}
		} finally {
			globalThis.fetch = realFetch;
			env.TURNSTILE_SECRET_KEY = undefined;
		}

		// Budget untouched: a real request still gets its link.
		const response = await POST(
			post("/api/auth/forgot-password", { email }, "10.0.0.21"),
		);
		expect(response.status).toBe(200);
		await flushRecoveryWork();
		expect(await tokenCount(userId, "password_reset")).toBe(1);
	});
});
