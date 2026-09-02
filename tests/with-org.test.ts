/**
 * T3.2 — `withOrg()` request scope.
 *
 * Two organisations, one user and one mailbox each. Every assertion is about a
 * caller in org A never being able to see or touch org B, whether it
 * authenticated with a cookie session or an API key.
 */
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeys, domains, folders, mailboxes, organizations, users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { generateApiKey, scopesToJson } from "@/lib/api-keys";
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

const ORG_A = "org_a";
const ORG_B = "org_b";
const ORG_SUSPENDED = "org_suspended";

const USER_A = "usr_org_a";
const USER_B = "usr_org_b";
const USER_SUSPENDED = "usr_org_suspended";

const MAILBOX_A = "mbx_org_a";
const MAILBOX_B = "mbx_org_b";

const FOLDER_A = "fld_org_a";
const FOLDER_B = "fld_org_b";

let apiKeyA = "";

async function seed(): Promise<void> {
	const db = createDb();

	await db.insert(organizations).values([
		{ id: ORG_A, name: "Org A", slug: "org-a", status: "active" },
		{ id: ORG_B, name: "Org B", slug: "org-b", status: "active" },
		{ id: ORG_SUSPENDED, name: "Suspended", slug: "org-suspended", status: "suspended" },
	]);

	await db.insert(users).values([
		{
			id: USER_A,
			organizationId: ORG_A,
			email: "a@org-a.test",
			passwordHash: "x",
			name: "A",
			role: "admin",
		},
		{
			id: USER_B,
			organizationId: ORG_B,
			email: "b@org-b.test",
			passwordHash: "x",
			name: "B",
			role: "admin",
		},
		{
			id: USER_SUSPENDED,
			organizationId: ORG_SUSPENDED,
			email: "s@org-suspended.test",
			passwordHash: "x",
			name: "S",
			role: "admin",
		},
	]);

	await db.insert(domains).values([
		{ id: "dom_a", organizationId: ORG_A, userId: USER_A, hostname: "org-a.test", zoneId: "z_a" },
		{ id: "dom_b", organizationId: ORG_B, userId: USER_B, hostname: "org-b.test", zoneId: "z_b" },
	]);

	await db.insert(mailboxes).values([
		{ id: MAILBOX_A, organizationId: ORG_A, userId: USER_A, domainId: "dom_a", localPart: "team" },
		{ id: MAILBOX_B, organizationId: ORG_B, userId: USER_B, domainId: "dom_b", localPart: "team" },
	]);

	await db.insert(folders).values([
		{
			id: FOLDER_A,
			organizationId: ORG_A,
			userId: USER_A,
			mailboxId: MAILBOX_A,
			name: "Org A folder",
		},
		{
			id: FOLDER_B,
			organizationId: ORG_B,
			userId: USER_B,
			mailboxId: MAILBOX_B,
			name: "Org B folder",
		},
	]);

	const key = generateApiKey();
	apiKeyA = key.fullKey;
	await db.insert(apiKeys).values({
		id: "key_org_a",
		organizationId: ORG_A,
		userId: USER_A,
		name: "Org A key",
		prefix: key.prefix,
		keyHash: key.hash,
		hashAlgo: key.hashAlgo,
		scopes: scopesToJson(["folders:read"]),
	});
}

async function signIn(userId: string): Promise<void> {
	const token = await createSession({ DB: createDb() } as unknown as CloudflareEnv, userId);
	cookieJar.clear();
	cookieJar.set(SESSION_COOKIE, token);
}

function get(url: string, headers?: Record<string, string>): Request {
	return new Request(`http://localhost${url}`, { headers });
}

function post(url: string, body: unknown): Request {
	return new Request(`http://localhost${url}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Next always passes a route context, even for routes with no dynamic segment. */
function routeCtx() {
	return { params: Promise.resolve({}) };
}

/** A minimal API-key route built on `withOrg`, standing in for `/api/v1/**`. */
const listFolders = withOrg(
	async ({ db, scoped, orgId }) => {
		const rows = await db.select().from(folders).where(scoped(folders));
		return NextResponse.json({ orgId, folders: rows.map((row) => row.id) });
	},
	{ allowApiKey: true, requiredScope: "folders:read" },
);

const requiresOtherScope = withOrg(async () => NextResponse.json({ ok: true }), {
	allowApiKey: true,
	requiredScope: "messages:write",
});

describe.skipIf(!hasTestDatabase())("withOrg (T3.2)", () => {
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

	it("rejects an unauthenticated request with 401", async () => {
		const { GET } = await import("@/app/api/folders/route");
		const response = await GET(get(`/api/folders?mailboxId=${MAILBOX_A}`), routeCtx());
		expect(response.status).toBe(401);
	});

	it("lists only the caller's organisation folders", async () => {
		const { GET } = await import("@/app/api/folders/route");

		await signIn(USER_A);
		const a = await GET(get(`/api/folders?mailboxId=${MAILBOX_A}`), routeCtx());
		expect(a.status).toBe(200);
		expect(((await a.json()) as { folders: Array<{ id: string }> }).folders.map((f) => f.id)).toEqual(
			[FOLDER_A],
		);

		await signIn(USER_B);
		const b = await GET(get(`/api/folders?mailboxId=${MAILBOX_B}`), routeCtx());
		expect(((await b.json()) as { folders: Array<{ id: string }> }).folders.map((f) => f.id)).toEqual(
			[FOLDER_B],
		);
	});

	it("404s a mailbox that belongs to another organisation", async () => {
		const { GET } = await import("@/app/api/folders/route");

		await signIn(USER_A);
		const response = await GET(get(`/api/folders?mailboxId=${MAILBOX_B}`), routeCtx());
		expect(response.status).toBe(404);
	});

	it("stamps the organisation on created folders", async () => {
		const { POST } = await import("@/app/api/folders/route");

		await signIn(USER_A);
		const response = await POST(
			post("/api/folders", { mailboxId: MAILBOX_A, name: "Receipts" }),
			routeCtx(),
		);
		expect(response.status).toBe(200);
		const created = (await response.json()) as { id: string };

		const [row] = await createDb().select().from(folders).where(eq(folders.id, created.id));
		expect(row?.organizationId).toBe(ORG_A);
	});

	it("refuses to create a folder in another organisation's mailbox", async () => {
		const { POST } = await import("@/app/api/folders/route");

		await signIn(USER_A);
		const response = await POST(
			post("/api/folders", { mailboxId: MAILBOX_B, name: "Sneaky" }),
			routeCtx(),
		);
		expect(response.status).toBe(404);

		const rows = await createDb()
			.select()
			.from(folders)
			.where(eq(folders.organizationId, ORG_B));
		expect(rows.map((row) => row.id)).toEqual([FOLDER_B]);
	});

	it("403s every request from a suspended organisation", async () => {
		const { GET } = await import("@/app/api/folders/route");

		await signIn(USER_SUSPENDED);
		const response = await GET(get("/api/folders"), routeCtx());
		expect(response.status).toBe(403);
		expect((await response.json()) as { error: string }).toEqual({ error: "Organisation suspended" });
	});

	it("scopes an API key to the organisation that issued it", async () => {
		const response = await listFolders(
			get("/api/v1/folders", { authorization: `Bearer ${apiKeyA}` }),
			routeCtx(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ orgId: ORG_A, folders: [FOLDER_A] });
	});

	it("rejects an API key without the required scope", async () => {
		const response = await requiresOtherScope(
			get("/api/v1/folders", { authorization: `Bearer ${apiKeyA}` }),
			routeCtx(),
		);
		expect(response.status).toBe(403);
	});

	it("ignores API keys on routes that do not opt in", async () => {
		const { GET } = await import("@/app/api/folders/route");
		const response = await GET(
			get(`/api/folders?mailboxId=${MAILBOX_A}`, { authorization: `Bearer ${apiKeyA}` }),
			routeCtx(),
		);
		expect(response.status).toBe(401);
	});

	it("401s a disabled user", async () => {
		await createDb().update(users).set({ disabled: true }).where(eq(users.id, USER_A));

		const { GET } = await import("@/app/api/folders/route");
		await signIn(USER_A);
		const response = await GET(get(`/api/folders?mailboxId=${MAILBOX_A}`), routeCtx());
		expect(response.status).toBe(401);
	});
});
