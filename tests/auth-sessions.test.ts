/**
 * Session hardening: revocation, password-change fallout and the global purge.
 *
 * The invariant under test everywhere here is "the caller keeps the session it
 * presented, and loses every other one". That is matched by token hash rather
 * than by row id, so a request can never revoke itself.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { authTokens, sessions, users } from "@/db/schema";
import { createSession, hashSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { runGlobalRetention } from "@/lib/retention/service";
import { newId } from "@/lib/ids";
import { createDb, hasTestDatabase } from "./helpers/db";

/** Cookie jar backing the mocked `next/headers`, same shape as auth-session.test.ts. */
const cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) => {
			const value = cookieJar.get(name);
			return value === undefined ? undefined : { name, value };
		},
	}),
}));

const routeCtx = (params: Record<string, string> = {}) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	({ params: Promise.resolve(params) }) as any;

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDatabase())("session revocation and purge", () => {
	beforeAll(() => {
		// The route handlers build their env from process.env.
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		// `getEnv()` refuses a half-configured mail transport; these tests send no mail.
		if (!!process.env.EDGE_WORKER_URL !== !!process.env.EDGE_WORKER_SECRET) {
			delete process.env.EDGE_WORKER_URL;
			delete process.env.EDGE_WORKER_SECRET;
		}
	});

	async function seedUser(email: string, password: string): Promise<string> {
		const db = createDb();
		const id = newId("usr");
		await db.insert(users).values({
			id,
			email,
			passwordHash: hashPassword(password),
			name: "sessions test user",
			role: "admin",
		});
		return id;
	}

	/** Three live sessions; the first one is the "current device". */
	async function seedSessions(userId: string): Promise<[string, string, string]> {
		const db = createDb();
		const env = { DB: db } as unknown as CloudflareEnv;
		return [
			await createSession(env, userId, { userAgent: "current", ipAddress: "203.0.113.1" }),
			await createSession(env, userId, { userAgent: "phone", ipAddress: "203.0.113.2" }),
			await createSession(env, userId, { userAgent: "laptop", ipAddress: "203.0.113.3" }),
		];
	}

	it("revoke-others keeps the calling session and drops the rest", async () => {
		const db = createDb();
		const userId = await seedUser("revoke-others@example.test", "correct-horse-battery");
		const [current] = await seedSessions(userId);

		cookieJar.clear();
		cookieJar.set(SESSION_COOKIE, current);
		const { POST } = await import("@/app/api/auth/sessions/revoke-others/route");
		const response = await POST(
			new Request("http://localhost/api/auth/sessions/revoke-others", { method: "POST" }),
			routeCtx(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, revoked: 2 });

		const remaining = await db
			.select({ tokenHash: sessions.tokenHash })
			.from(sessions)
			.where(eq(sessions.userId, userId));
		expect(remaining.map((row) => row.tokenHash)).toEqual([await hashSessionToken(current)]);
		cookieJar.clear();
	});

	it("lists the caller's sessions, flags the current one and never leaks the hash", async () => {
		const userId = await seedUser("list-sessions@example.test", "correct-horse-battery");
		const [current] = await seedSessions(userId);

		cookieJar.clear();
		cookieJar.set(SESSION_COOKIE, current);
		const { GET } = await import("@/app/api/auth/sessions/route");
		const response = await GET(new Request("http://localhost/api/auth/sessions"), routeCtx());

		expect(response.status).toBe(200);
		const body = (await response.json()) as { sessions: Array<Record<string, unknown>> };
		expect(body.sessions).toHaveLength(3);
		expect(body.sessions.filter((row) => row.current)).toHaveLength(1);
		const raw = JSON.stringify(body);
		expect(raw).not.toContain(await hashSessionToken(current));
		expect(raw).not.toContain("sess_");
		cookieJar.clear();
	});

	it("a password change stamps password_changed_at and kills the other sessions", async () => {
		const db = createDb();
		const userId = await seedUser("change-password@example.test", "correct-horse-battery");
		const [current] = await seedSessions(userId);

		cookieJar.clear();
		cookieJar.set(SESSION_COOKIE, current);
		const { PATCH } = await import("@/app/api/settings/password/route");
		const response = await PATCH(
			new Request("http://localhost/api/settings/password", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					currentPassword: "correct-horse-battery",
					newPassword: "another-correct-horse",
				}),
			}),
			routeCtx(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, revokedSessions: 2 });

		const remaining = await db
			.select({ tokenHash: sessions.tokenHash })
			.from(sessions)
			.where(eq(sessions.userId, userId));
		expect(remaining.map((row) => row.tokenHash)).toEqual([await hashSessionToken(current)]);

		const [row] = await db
			.select({ passwordChangedAt: users.passwordChangedAt })
			.from(users)
			.where(eq(users.id, userId));
		expect(row?.passwordChangedAt).toBeInstanceOf(Date);
		cookieJar.clear();
	});

	it("the global purge removes expired sessions, stale pending logins and spent tokens", async () => {
		const db = createDb();
		const env = { DB: db } as unknown as CloudflareEnv;
		const userId = await seedUser("purge@example.test", "correct-horse-battery");
		const now = new Date();

		await db.insert(sessions).values([
			{ id: "ses_live", userId, tokenHash: "hash-live", expiresAt: new Date(now.getTime() + DAY) },
			{ id: "ses_expired", userId, tokenHash: "hash-expired", expiresAt: new Date(now.getTime() - DAY) },
			{
				// Unexpired on paper, but stuck on the TOTP step for far longer than the
				// 10-minute pending window allows.
				id: "ses_pending_stale",
				userId,
				tokenHash: "hash-pending",
				pendingTwoFactor: true,
				createdAt: new Date(now.getTime() - DAY),
				expiresAt: new Date(now.getTime() + DAY),
			},
		]);
		await db.insert(authTokens).values([
			{
				id: "tok_old",
				userId,
				purpose: "password_reset",
				tokenHash: "tok-hash-old",
				expiresAt: new Date(now.getTime() - 2 * DAY),
			},
			{
				id: "tok_fresh",
				userId,
				purpose: "magic_link",
				tokenHash: "tok-hash-fresh",
				expiresAt: new Date(now.getTime() + DAY),
			},
		]);

		const counts = await runGlobalRetention(env, { now });
		expect(counts.expiredSessions).toBe(1);
		expect(counts.stalePendingSessions).toBe(1);
		expect(counts.authTokens).toBe(1);

		const remainingSessions = await db.select({ id: sessions.id }).from(sessions);
		expect(remainingSessions.map((row) => row.id)).toEqual(["ses_live"]);
		const remainingTokens = await db.select({ id: authTokens.id }).from(authTokens);
		expect(remainingTokens.map((row) => row.id)).toEqual(["tok_fresh"]);
	});
});
