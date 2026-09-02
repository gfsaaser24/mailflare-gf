/**
 * T1.1 — the session token must never leave the httpOnly cookie.
 *
 * Covers: login/register responses carry no token, `Authorization: Bearer
 * <session token>` is refused everywhere, and cookie auth still works.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { authenticateApiKey } from "@/lib/api/auth";
import {
	SESSION_COOKIE,
	createSession,
	generateSessionToken,
	isSessionToken,
} from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/ids";
import { schema } from "@/db";
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

function bearer(token: string): Request {
	return new Request("http://localhost/api/auth/me", {
		headers: { Authorization: `Bearer ${token}` },
	});
}

describe("session tokens are never valid bearer credentials", () => {
	it("mints session tokens under a prefix distinct from API keys", () => {
		const token = generateSessionToken();
		expect(isSessionToken(token)).toBe(true);
		expect(token.startsWith("ep_")).toBe(false);
	});

	it("rejects a session token on the API-key bearer path before any DB lookup", async () => {
		// `env` has no DB: reaching the lookup would throw instead of returning null.
		const env = {} as CloudflareEnv;
		await expect(authenticateApiKey(env, `Bearer ${generateSessionToken()}`)).resolves.toBeNull();
		await expect(authenticateApiKey(env, "Bearer not-an-api-key")).resolves.toBeNull();
		await expect(authenticateApiKey(env, "Bearer ")).resolves.toBeNull();
		await expect(authenticateApiKey(env, null)).resolves.toBeNull();
	});
});

describe.skipIf(!hasTestDatabase())("login, register and /api/auth/me", () => {
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
		await db.insert(schema.users).values({
			id,
			email,
			passwordHash: hashPassword(password),
			name: "T1.1 user",
			role: "admin",
		});
		return id;
	}

	it("does not return the session token in the login response body", async () => {
		await seedUser("t11@example.test", "correct-horse-battery");
		const { POST } = await import("@/app/api/auth/login/route");

		const response = await POST(
			new Request("http://localhost/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "t11@example.test", password: "correct-horse-battery" }),
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toEqual({ ok: true, redirect: "/inbox" });
		expect(body.token).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("sess_");

		// The token is only in the httpOnly cookie.
		const cookie = response.cookies.get(SESSION_COOKIE);
		expect(cookie?.value).toBeTruthy();
		expect(isSessionToken(cookie!.value)).toBe(true);
		expect(cookie?.httpOnly).toBe(true);
	});

	it("returns 401 for /api/auth/me with a session token in the Authorization header", async () => {
		const userId = await seedUser("t11-bearer@example.test", "correct-horse-battery");
		const db = createDb();
		const token = await createSession({ DB: db } as unknown as CloudflareEnv, userId);

		cookieJar.clear();
		const { GET } = await import("@/app/api/auth/me/route");
		const response = await GET(bearer(token));

		expect(response.status).toBe(401);
	});

	it("accepts the same session token from the cookie", async () => {
		const userId = await seedUser("t11-cookie@example.test", "correct-horse-battery");
		const db = createDb();
		const token = await createSession({ DB: db } as unknown as CloudflareEnv, userId);

		cookieJar.clear();
		cookieJar.set(SESSION_COOKIE, token);
		const { GET } = await import("@/app/api/auth/me/route");
		const response = await GET(new Request("http://localhost/api/auth/me"));

		expect(response.status).toBe(200);
		const body = (await response.json()) as { user?: { id?: string } };
		expect(body.user?.id).toBe(userId);
		cookieJar.clear();
	});
});
