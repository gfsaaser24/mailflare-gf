/**
 * TOTP two-factor authentication.
 *
 * Covers the four things that must never regress:
 *  - a pending session is not a login;
 *  - a correct code promotes it to a real one;
 *  - a backup code works exactly once;
 *  - the attempt budget is the USER's, not the pending session's, and five
 *    consecutive failures destroy the pending session;
 *  - an organisation that requires two-factor blocks a user who has not
 *    enrolled, except on the routes needed to enrol.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { generate } from "otplib";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { organizations, sessions, users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { encryptSecret } from "@/lib/auth/crypto";
import { hashPassword } from "@/lib/auth/password";
import {
	PENDING_TWO_FACTOR_MS,
	SESSION_COOKIE,
	createSession,
	getUserFromSession,
} from "@/lib/auth/session";
import {
	generateBackupCodes,
	generateTotpSecret,
	serializeBackupCodeHashes,
} from "@/lib/auth/totp";
import { createDb, hasTestDatabase } from "./helpers/db";

/** Cookie jar backing the mocked `next/headers`. */
const cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) => {
			const value = cookieJar.get(name);
			return value === undefined ? undefined : { name, value };
		},
	}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const routeCtx = () => ({ params: Promise.resolve({}) }) as any;

const ORG_2FA = "org_two_factor";
const PASSWORD = "correct-horse-battery";

/**
 * A distinct IP per test keeps the per-IP bucket (20 per 5 minutes, shared by
 * every test in this process) from deciding the outcome of a later test.
 */
function post(path: string, body: unknown, ip = "10.9.0.1"): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-real-ip": ip },
		body: JSON.stringify(body),
	});
}

describe.skipIf(!hasTestDatabase())("two-factor authentication", () => {
	beforeAll(() => {
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		// A deterministic 32-byte key: the routes refuse to encrypt without one.
		process.env.AUTH_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
		// `getEnv()` refuses a half-configured mail transport; nothing here sends.
		if (!!process.env.EDGE_WORKER_URL !== !!process.env.EDGE_WORKER_SECRET) {
			delete process.env.EDGE_WORKER_URL;
			delete process.env.EDGE_WORKER_SECRET;
		}
	});

	beforeEach(() => {
		cookieJar.clear();
	});

	/** A user with TOTP already on, plus the plaintext secret and backup codes. */
	async function seedEnrolledUser(email: string): Promise<{
		userId: string;
		secret: string;
		backupCodes: string[];
	}> {
		const db = createDb();
		const env = { DB: db } as unknown as CloudflareEnv;
		const userId = `usr_${email.replace(/[^a-z0-9]/g, "")}`;
		const secret = generateTotpSecret();
		const { codes, hashes } = generateBackupCodes(2);

		await db.insert(users).values({
			id: userId,
			email,
			passwordHash: hashPassword(PASSWORD),
			name: "Two factor user",
			role: "admin",
			totpSecretEncrypted: encryptSecret(env, secret),
			totpEnabledAt: new Date(),
			totpBackupCodes: serializeBackupCodeHashes(hashes),
		});

		return { userId, secret, backupCodes: codes };
	}

	async function pendingSessionFor(userId: string): Promise<string> {
		const db = createDb();
		return createSession({ DB: db } as unknown as CloudflareEnv, userId, {
			expiresInMs: PENDING_TWO_FACTOR_MS,
			pendingTwoFactor: true,
		});
	}

	it("does not treat a pending session as a login", async () => {
		const { userId } = await seedEnrolledUser("pending@example.test");
		const db = createDb();
		const env = { DB: db } as unknown as CloudflareEnv;
		const token = await pendingSessionFor(userId);

		await expect(getUserFromSession(env, token)).resolves.toBeNull();

		cookieJar.set(SESSION_COOKIE, token);
		const { GET } = await import("@/app/api/auth/me/route");
		const response = await GET(new Request("http://localhost/api/auth/me"), routeCtx());
		expect(response.status).toBe(401);
	});

	it("promotes the pending session when the authenticator code is right", async () => {
		const { userId, secret } = await seedEnrolledUser("verify@example.test");
		const db = createDb();
		const env = { DB: db } as unknown as CloudflareEnv;
		const token = await pendingSessionFor(userId);
		cookieJar.set(SESSION_COOKIE, token);

		const { POST } = await import("@/app/api/auth/two-factor/verify/route");
		const response = await POST(
			post("/api/auth/two-factor/verify", { code: await generate({ secret }) }),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, redirect: "/inbox" });

		// The same cookie is now a full session.
		const user = await getUserFromSession(env, token);
		expect(user?.id).toBe(userId);
		const [row] = await db.select().from(sessions).where(eq(sessions.userId, userId)).limit(1);
		expect(row?.pendingTwoFactor).toBe(false);
	});

	it("rejects a wrong code and leaves the session pending", async () => {
		const { userId } = await seedEnrolledUser("wrong@example.test");
		const db = createDb();
		const env = { DB: db } as unknown as CloudflareEnv;
		const token = await pendingSessionFor(userId);
		cookieJar.set(SESSION_COOKIE, token);

		const { POST } = await import("@/app/api/auth/two-factor/verify/route");
		const response = await POST(post("/api/auth/two-factor/verify", { code: "000000" }));

		expect(response.status).toBe(400);
		await expect(getUserFromSession(env, token)).resolves.toBeNull();
	});

	it("burns a backup code so it works exactly once", async () => {
		const { userId, backupCodes } = await seedEnrolledUser("backup@example.test");
		const db = createDb();
		const { POST } = await import("@/app/api/auth/two-factor/verify/route");

		cookieJar.set(SESSION_COOKIE, await pendingSessionFor(userId));
		const first = await POST(post("/api/auth/two-factor/verify", { code: backupCodes[0] }));
		expect(first.status).toBe(200);

		const [after] = await db
			.select({ codes: users.totpBackupCodes })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		expect(JSON.parse(after!.codes!)).toHaveLength(1);

		// A second pending session, same code: it is gone.
		cookieJar.set(SESSION_COOKIE, await pendingSessionFor(userId));
		const second = await POST(post("/api/auth/two-factor/verify", { code: backupCodes[0] }));
		expect(second.status).toBe(400);
	});

	it("counts attempts against the user, not the pending session", async () => {
		// A fresh pending session is one `/api/auth/login` away, so keying the
		// budget on the session handed the attacker a reset button.
		const { userId, secret } = await seedEnrolledUser("budget@example.test");
		const { POST } = await import("@/app/api/auth/two-factor/verify/route");
		const ip = "10.9.0.20";

		// Four wrong codes on one session: under the five-failure threshold, so
		// the session survives and only the budget is spent.
		cookieJar.set(SESSION_COOKIE, await pendingSessionFor(userId));
		for (let i = 0; i < 4; i++) {
			const response = await POST(post("/api/auth/two-factor/verify", { code: "000000" }, ip));
			expect(response.status, `attempt ${i + 1}`).toBe(400);
		}

		// Fifth attempt, brand new pending session, correct code: still allowed,
		// and it spends the last of the user's budget.
		cookieJar.set(SESSION_COOKIE, await pendingSessionFor(userId));
		const fifth = await POST(
			post("/api/auth/two-factor/verify", { code: await generate({ secret }) }, ip),
		);
		expect(fifth.status).toBe(200);

		// Sixth, on yet another new session and with a correct code: refused.
		cookieJar.set(SESSION_COOKIE, await pendingSessionFor(userId));
		const sixth = await POST(
			post("/api/auth/two-factor/verify", { code: await generate({ secret }) }, ip),
		);
		expect(sixth.status).toBe(429);
	});

	it("destroys the pending session after five consecutive failures", async () => {
		const { userId } = await seedEnrolledUser("lockout@example.test");
		const db = createDb();
		const { POST } = await import("@/app/api/auth/two-factor/verify/route");
		const ip = "10.9.0.21";

		cookieJar.set(SESSION_COOKIE, await pendingSessionFor(userId));
		for (let i = 0; i < 4; i++) {
			const response = await POST(post("/api/auth/two-factor/verify", { code: "000000" }, ip));
			expect(response.status, `attempt ${i + 1}`).toBe(400);
		}

		// The fifth failure spends the half-authenticated session itself.
		const last = await POST(post("/api/auth/two-factor/verify", { code: "000000" }, ip));
		expect(last.status).toBe(401);

		const rows = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(and(eq(sessions.userId, userId), eq(sessions.pendingTwoFactor, true)));
		expect(rows).toHaveLength(0);
	});

	it("refuses a code without a pending session", async () => {
		const { backupCodes } = await seedEnrolledUser("nosession@example.test");
		const { POST } = await import("@/app/api/auth/two-factor/verify/route");
		const response = await POST(post("/api/auth/two-factor/verify", { code: backupCodes[0] }));
		expect(response.status).toBe(401);
	});

	describe("organisation requirement", () => {
		const handler = withOrg(async () => NextResponse.json({ ok: true }));

		async function seedOrgUser(enrolled: boolean): Promise<string> {
			const db = createDb();
			const env = { DB: db } as unknown as CloudflareEnv;
			await db.insert(organizations).values({
				id: ORG_2FA,
				name: "Two factor org",
				slug: "two-factor-org",
				status: "active",
				requireTwoFactor: true,
			});
			await db.insert(users).values({
				id: "usr_org_2fa",
				organizationId: ORG_2FA,
				email: "member@two-factor-org.test",
				passwordHash: hashPassword(PASSWORD),
				name: "Member",
				role: "admin",
				...(enrolled ? { totpEnabledAt: new Date() } : {}),
			});
			return createSession(env, "usr_org_2fa");
		}

		it("blocks a member who has not enrolled", async () => {
			cookieJar.set(SESSION_COOKIE, await seedOrgUser(false));
			const response = await handler(new Request("http://localhost/api/mailboxes"), routeCtx());
			expect(response.status).toBe(403);
			await expect(response.json()).resolves.toEqual({ error: "two_factor_required" });
		});

		it("still allows the routes needed to enrol", async () => {
			cookieJar.set(SESSION_COOKIE, await seedOrgUser(false));
			for (const url of [
				"http://localhost/api/auth/two-factor",
				"http://localhost/api/auth/two-factor/setup",
				"http://localhost/api/auth/me",
				"http://localhost/api/auth/logout",
			]) {
				const response = await handler(new Request(url), routeCtx());
				expect(response.status, url).toBe(200);
			}
			// GET only: the policy itself cannot be changed from a blocked session.
			const read = await handler(
				new Request("http://localhost/api/settings/security"),
				routeCtx(),
			);
			expect(read.status).toBe(200);
			const write = await handler(
				new Request("http://localhost/api/settings/security", { method: "PATCH" }),
				routeCtx(),
			);
			expect(write.status).toBe(403);
		});

		it("lets an enrolled member through", async () => {
			cookieJar.set(SESSION_COOKIE, await seedOrgUser(true));
			const response = await handler(new Request("http://localhost/api/mailboxes"), routeCtx());
			expect(response.status).toBe(200);
		});
	});
});
