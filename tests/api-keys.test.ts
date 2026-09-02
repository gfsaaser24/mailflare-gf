/**
 * T6.1 — the API-key model.
 *
 * Covers the hash migration (new keys are SHA-256, pre-existing bcrypt rows
 * keep working), revocation, expiry, scope enforcement on `/api/v1/**`, and
 * that one organisation can never revoke another's key.
 *
 * NOTE: the combined migration for this wave is generated after all the
 * concurrent schema edits land, so `ensureApiKeyColumns()` adds the new
 * `api_keys` columns to `mailflare_test` with raw `ALTER TABLE ... IF NOT
 * EXISTS` in `beforeAll`. Drop that helper once the migration exists.
 */
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeys, domains, mailboxes, organizations, users } from "@/db/schema";
import { authenticateApiKey, isApiAuthFailure } from "@/lib/api/auth";
import { generateApiKey, scopesToJson, verifyApiKey } from "@/lib/api-keys";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { ensureApiKeyColumns } from "./helpers/api-key-columns";
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

const ORG_A = "org_key_a";
const ORG_B = "org_key_b";
const USER_A = "usr_key_a";
const USER_B = "usr_key_b";
const MAILBOX_A = "mbx_key_a";

/** Keys seeded by `seed()`, in the order they are created. */
let legacyKey = "";
let scopedKey = "";
let revokedKey = "";
let expiredKey = "";

function env(): CloudflareEnv {
	return { DB: createDb() } as unknown as CloudflareEnv;
}

async function seed(): Promise<void> {
	const db = createDb();

	await db.insert(organizations).values([
		{ id: ORG_A, name: "Key Org A", slug: "key-org-a", status: "active" },
		{ id: ORG_B, name: "Key Org B", slug: "key-org-b", status: "active" },
	]);

	await db.insert(users).values([
		{
			id: USER_A,
			organizationId: ORG_A,
			email: "a@key-org-a.test",
			passwordHash: "x",
			name: "A",
			role: "admin",
		},
		{
			id: USER_B,
			organizationId: ORG_B,
			email: "b@key-org-b.test",
			passwordHash: "x",
			name: "B",
			role: "admin",
		},
	]);

	await db.insert(domains).values({
		id: "dom_key_a",
		organizationId: ORG_A,
		userId: USER_A,
		hostname: "key-org-a.test",
		zoneId: "z_key_a",
	});

	await db.insert(mailboxes).values({
		id: MAILBOX_A,
		organizationId: ORG_A,
		userId: USER_A,
		domainId: "dom_key_a",
		localPart: "team",
	});

	// A key issued before T6.1: bcrypt hash, no expiry columns set.
	const legacy = generateApiKey();
	legacyKey = legacy.fullKey;
	await db.insert(apiKeys).values({
		id: "key_legacy",
		organizationId: ORG_A,
		userId: USER_A,
		name: "Legacy bcrypt key",
		prefix: legacy.prefix,
		keyHash: bcrypt.hashSync(legacy.fullKey, 10),
		hashAlgo: "bcrypt",
		scopes: scopesToJson(["messages:read"]),
	});

	// A current key that holds `send` but not `messages:read`.
	const scoped = generateApiKey();
	scopedKey = scoped.fullKey;
	await db.insert(apiKeys).values({
		id: "key_scoped",
		organizationId: ORG_A,
		userId: USER_A,
		name: "Send-only key",
		prefix: scoped.prefix,
		keyHash: scoped.hash,
		hashAlgo: scoped.hashAlgo,
		scopes: scopesToJson(["send"]),
	});

	const revoked = generateApiKey();
	revokedKey = revoked.fullKey;
	await db.insert(apiKeys).values({
		id: "key_revoked",
		organizationId: ORG_A,
		userId: USER_A,
		name: "Revoked key",
		prefix: revoked.prefix,
		keyHash: revoked.hash,
		hashAlgo: revoked.hashAlgo,
		scopes: scopesToJson(["messages:read"]),
		revokedAt: new Date("2026-01-01T00:00:00Z"),
	});

	const expired = generateApiKey();
	expiredKey = expired.fullKey;
	await db.insert(apiKeys).values({
		id: "key_expired",
		organizationId: ORG_A,
		userId: USER_A,
		name: "Expired key",
		prefix: expired.prefix,
		keyHash: expired.hash,
		hashAlgo: expired.hashAlgo,
		scopes: scopesToJson(["messages:read"]),
		expiresAt: new Date("2026-01-01T00:00:00Z"),
	});
}

async function signIn(userId: string): Promise<void> {
	const token = await createSession(env(), userId);
	cookieJar.clear();
	cookieJar.set(SESSION_COOKIE, token);
}

function request(url: string, init?: RequestInit): Request {
	return new Request(`http://localhost${url}`, init);
}

function bearer(url: string, key: string): Request {
	return request(url, { headers: { Authorization: `Bearer ${key}`, "x-real-ip": "203.0.113.7" } });
}

function routeCtx<P extends Record<string, string>>(params: P) {
	return { params: Promise.resolve(params) };
}

/** Next always passes a route context, even without a dynamic segment. */
function emptyCtx() {
	return { params: Promise.resolve({}) };
}

describe.skipIf(!hasTestDatabase())("API keys (T6.1)", () => {
	beforeAll(async () => {
		await ensureApiKeyColumns();
		// The route handlers build their env from process.env.
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		// `getEnv()` refuses a half-configured mail transport; these tests send no mail.
		if (!!process.env.EDGE_WORKER_URL !== !!process.env.EDGE_WORKER_SECRET) {
			delete process.env.EDGE_WORKER_URL;
			delete process.env.EDGE_WORKER_SECRET;
		}
	});

	beforeEach(async () => {
		cookieJar.clear();
		await seed();
	});

	it("issues SHA-256 keys that authenticate", async () => {
		const { POST } = await import("@/app/api/api-keys/route");

		await signIn(USER_A);
		const response = await POST(
			request("/api/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Agent", scopes: ["messages:read"], expiresInDays: 30 }),
			}),
			emptyCtx(),
		);
		expect(response.status).toBe(200);
		const created = (await response.json()) as { id: string; key: string; expiresAt: string };

		const [row] = await createDb().select().from(apiKeys).where(eq(apiKeys.id, created.id));
		expect(row?.hashAlgo).toBe("sha256");
		// The stored value is the plain hex digest, not a bcrypt string.
		expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.expiresAt).toBeInstanceOf(Date);
		expect(verifyApiKey(created.key, row!.keyHash, row!.hashAlgo)).toBe(true);

		const auth = await authenticateApiKey(env(), `Bearer ${created.key}`);
		expect(isApiAuthFailure(auth)).toBe(false);
		expect(auth && !isApiAuthFailure(auth) ? auth.organizationId : null).toBe(ORG_A);
	});

	it("rejects scopes that are not in the catalogue", async () => {
		const { POST } = await import("@/app/api/api-keys/route");

		await signIn(USER_A);
		const response = await POST(
			request("/api/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Agent", scopes: ["everything"] }),
			}),
			emptyCtx(),
		);
		expect(response.status).toBe(400);
	});

	it("still verifies a pre-existing bcrypt key", async () => {
		const auth = await authenticateApiKey(env(), `Bearer ${legacyKey}`);
		expect(auth && !isApiAuthFailure(auth) ? auth.userId : null).toBe(USER_A);

		const { GET } = await import("@/app/api/v1/messages/route");
		const response = await GET(bearer("/api/v1/messages", legacyKey), emptyCtx());
		expect(response.status).toBe(200);
	});

	it("401s a revoked key", async () => {
		const auth = await authenticateApiKey(env(), `Bearer ${revokedKey}`);
		expect(isApiAuthFailure(auth)).toBe(true);

		const { GET } = await import("@/app/api/v1/messages/route");
		const response = await GET(bearer("/api/v1/messages", revokedKey), emptyCtx());
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "API key revoked" });
	});

	it("401s an expired key", async () => {
		const auth = await authenticateApiKey(env(), `Bearer ${expiredKey}`);
		expect(isApiAuthFailure(auth)).toBe(true);

		const { GET } = await import("@/app/api/v1/messages/route");
		const response = await GET(bearer("/api/v1/messages", expiredKey), emptyCtx());
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "API key expired" });
	});

	it("403s a key without the route's scope", async () => {
		const { GET } = await import("@/app/api/v1/messages/route");
		const response = await GET(bearer("/api/v1/messages", scopedKey), emptyCtx());
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "Insufficient scope" });
	});

	it("revokes a key through DELETE and refuses it afterwards", async () => {
		const { DELETE } = await import("@/app/api/api-keys/[id]/route");

		await signIn(USER_A);
		const response = await DELETE(
			request("/api/api-keys/key_legacy", { method: "DELETE" }),
			routeCtx({ id: "key_legacy" }),
		);
		expect(response.status).toBe(200);

		const [row] = await createDb().select().from(apiKeys).where(eq(apiKeys.id, "key_legacy"));
		expect(row?.revokedAt).toBeInstanceOf(Date);

		const auth = await authenticateApiKey(env(), `Bearer ${legacyKey}`);
		expect(isApiAuthFailure(auth)).toBe(true);
	});

	it("404s a DELETE for a key in another organisation", async () => {
		const { DELETE } = await import("@/app/api/api-keys/[id]/route");

		await signIn(USER_B);
		const response = await DELETE(
			request("/api/api-keys/key_legacy", { method: "DELETE" }),
			routeCtx({ id: "key_legacy" }),
		);
		expect(response.status).toBe(404);

		const [row] = await createDb().select().from(apiKeys).where(eq(apiKeys.id, "key_legacy"));
		expect(row?.revokedAt).toBeNull();
	});

	it("records the client IP the key was last used from", async () => {
		const { GET } = await import("@/app/api/v1/messages/route");
		const response = await GET(bearer("/api/v1/messages", legacyKey), emptyCtx());
		expect(response.status).toBe(200);

		// The usage update is fire-and-forget; give it a turn to land.
		await vi.waitFor(async () => {
			const [row] = await createDb().select().from(apiKeys).where(eq(apiKeys.id, "key_legacy"));
			expect(row?.lastUsedIp).toBe("203.0.113.7");
		});
	});
});
