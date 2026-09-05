/**
 * The organisation two-factor policy, as a shared gate.
 *
 * Two regressions are pinned here:
 *  - a route that authenticates with `requireUserForRoute` (rather than
 *    `withOrg`) is gated exactly the same way. `POST /api/send` used to take the
 *    other door and skip the requirement entirely.
 *  - the enrolment allowlist matches EXACT, normalised paths. It used to match
 *    the raw pathname with a prefix, so `/api/auth/two-factor/%2e%2e/%2e%2e/x`
 *    was "an enrolment route" for as long as the check looked at it.
 */
import { NextResponse } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { organizations, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import {
	isTwoFactorEnrolmentRoute,
	normaliseRequestPath,
} from "@/lib/auth/two-factor-policy";
import { createDb, hasTestDatabase } from "./helpers/db";

const cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) => {
			const value = cookieJar.get(name);
			return value === undefined ? undefined : { name, value };
		},
	}),
}));

function get(url: string, method = "GET"): Request {
	return new Request(`http://localhost${url}`, { method });
}

describe("enrolment allowlist", () => {
	it("normalises a path it can reduce, and refuses one it cannot", () => {
		expect(normaliseRequestPath("http://x/api/auth/me")).toBe("/api/auth/me");
		expect(normaliseRequestPath("http://x/api/auth/me/")).toBe("/api/auth/me");
		// `new URL()` already folds a plain (or `%2e`-encoded) dot segment away,
		// so the interesting case is the one it leaves alone: an ENCODED slash,
		// which keeps `..` inside a single segment until something decodes it.
		expect(normaliseRequestPath("http://x/api/auth/two-factor/%2e%2e%2fmessages")).toBeNull();
		expect(normaliseRequestPath("http://x/api/auth/two-factor/..%2fmessages")).toBeNull();
		expect(normaliseRequestPath("http://x/api/auth/two-factor/%2e%2fsetup")).toBeNull();
		// Doubled slashes and malformed encoding are never reduced either.
		expect(normaliseRequestPath("http://x/api/auth/two-factor//setup")).toBeNull();
		expect(normaliseRequestPath("http://x/api/auth/%zz")).toBeNull();
	});

	it("allows exactly the routes needed to enrol", () => {
		for (const path of [
			"/api/auth/two-factor",
			"/api/auth/two-factor/setup",
			"/api/auth/two-factor/enable",
			"/api/auth/two-factor/verify",
			"/api/auth/two-factor/disable",
			"/api/auth/two-factor/backup-codes",
			"/api/auth/me",
			"/api/auth/logout",
		]) {
			expect(isTwoFactorEnrolmentRoute(get(path)), path).toBe(true);
		}
		// GET only: the policy cannot be switched off from a blocked session.
		expect(isTwoFactorEnrolmentRoute(get("/api/settings/security"))).toBe(true);
		expect(isTwoFactorEnrolmentRoute(get("/api/settings/security", "PATCH"))).toBe(false);
	});

	it("does not allow an encoded, doubled or re-cased lookalike", () => {
		for (const path of [
			"/api/auth/two-factor/%2e%2e/%2e%2e/messages",
			"/api/auth/two-factor/../../messages",
			"/api/auth/two-factor/%2e%2e/%2e%2e/health",
			// The encoded slash the URL parser does NOT fold away: the old
			// prefix check saw "/api/auth/two-factor/..." and said yes.
			"/api/auth/two-factor/%2e%2e%2fmessages",
			"/api/auth/two-factor/..%2f..%2fmessages",
			"/API/AUTH/ME",
			"/api/auth/two-factor//setup",
			"/api/auth/two-factor/setup/../../../messages",
			"/api/auth/two-factorx",
			"/api/auth/two-factor/setup/extra",
			"/api/auth/me/../messages",
		]) {
			expect(isTwoFactorEnrolmentRoute(get(path)), path).toBe(false);
		}
	});
});

describe.skipIf(!hasTestDatabase())("requireUserForRoute", () => {
	const ORG = "org_policy_2fa";
	const USER = "usr_policy_2fa";

	beforeAll(() => {
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		if (!!process.env.EDGE_WORKER_URL !== !!process.env.EDGE_WORKER_SECRET) {
			delete process.env.EDGE_WORKER_URL;
			delete process.env.EDGE_WORKER_SECRET;
		}
	});

	beforeEach(() => {
		cookieJar.clear();
	});

	/** A route that resolves its own cookie session, the way `/api/send` does. */
	async function route(request: Request): Promise<Response> {
		const { requireUserForRoute } = await import("@/lib/auth/cookies");
		const env = { DB: createDb() } as unknown as CloudflareEnv;
		const auth = await requireUserForRoute(env, request);
		if (!auth.ok) return auth.response;
		return NextResponse.json({ ok: true, user: auth.user.id });
	}

	async function seed(enrolled: boolean): Promise<string> {
		const db = createDb();
		const env = { DB: db } as unknown as CloudflareEnv;
		await db.insert(organizations).values({
			id: ORG,
			name: "Policy org",
			slug: "policy-org",
			status: "active",
			requireTwoFactor: true,
		});
		await db.insert(users).values({
			id: USER,
			organizationId: ORG,
			email: "member@policy-org.test",
			passwordHash: hashPassword("correct-horse-battery"),
			name: "Member",
			role: "admin",
			...(enrolled ? { totpEnabledAt: new Date() } : {}),
		});
		return createSession(env, USER);
	}

	it("answers 401 for an anonymous caller instead of throwing", async () => {
		const response = await route(get("/api/send", "POST"));
		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
	});

	it("gates an unenrolled member of a requiring organisation", async () => {
		cookieJar.set(SESSION_COOKIE, await seed(false));
		const response = await route(get("/api/send", "POST"));
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({ error: "two_factor_required" });
	});

	it("lets an enrolled member through", async () => {
		cookieJar.set(SESSION_COOKIE, await seed(true));
		const response = await route(get("/api/send", "POST"));
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, user: USER });
	});
});
