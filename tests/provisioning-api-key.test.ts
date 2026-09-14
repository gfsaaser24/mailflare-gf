/**
 * The `domains:manage` / `mailboxes:manage` scopes open the dashboard
 * provisioning routes to an API key (see docs/api.md, "Scopes"). These tests
 * call the route handlers as Next does, with real keys, and stub only
 * Cloudflare.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeys, domains, organizations, users } from "@/db/schema";
import { generateApiKey, scopesToJson } from "@/lib/api-keys";
import type { ScopeName } from "@/lib/api/scopes";
import { ensureApiKeyColumns } from "./helpers/api-key-columns";
import { createDb, hasTestDatabase } from "./helpers/db";

vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@/lib/cloudflare-api", () => ({
	ensureEmailRoutingRuleToWorker: vi.fn(async () => ({ id: "rule" })),
	listEmailRoutingRules: vi.fn(async () => []),
	deleteEmailRoutingRule: vi.fn(async () => undefined),
}));

const ORG = "org_prov";
const ADMIN = "usr_prov_admin";
const HOSTNAME = "prov.test";
const DOMAIN = "dom_prov";

let manageKey = "";
let readKey = "";

function req(url: string, key: string | null, body?: unknown): Request {
	const headers: Record<string, string> = {};
	if (key) headers.Authorization = `Bearer ${key}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	return new Request(`http://localhost${url}`, {
		method: body === undefined ? "GET" : "POST",
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

const emptyCtx = () => ({ params: Promise.resolve({}) });

async function issueKey(id: string, scopes: ScopeName[]) {
	const key = generateApiKey();
	await createDb().insert(apiKeys).values({
		id,
		organizationId: ORG,
		userId: ADMIN,
		name: id,
		prefix: key.prefix,
		keyHash: key.hash,
		hashAlgo: key.hashAlgo,
		scopes: scopesToJson(scopes),
	});
	return key.fullKey;
}

async function seed() {
	const db = createDb();
	await db.insert(organizations).values({ id: ORG, name: "Prov", slug: "prov", status: "active" });
	await db.insert(users).values({
		id: ADMIN,
		organizationId: ORG,
		email: `admin@${HOSTNAME}`,
		passwordHash: "x",
		name: "Admin",
		role: "admin",
	});
	await db.insert(domains).values({
		id: DOMAIN,
		organizationId: ORG,
		userId: ADMIN,
		hostname: HOSTNAME,
		zoneId: "zone_prov",
	});
	manageKey = await issueKey("key_prov_manage", ["domains:manage", "mailboxes:manage"]);
	readKey = await issueKey("key_prov_read", ["messages:read"]);
}

describe.skipIf(!hasTestDatabase())("provisioning routes with an API key", () => {
	beforeAll(async () => {
		await ensureApiKeyColumns();
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
	});
	beforeEach(seed);

	it("refuses an anonymous caller and a key without the scope", async () => {
		const { GET: listDomains } = await import("@/app/api/domains/route");
		const { POST: createMailbox } = await import("@/app/api/mailboxes/route");
		expect((await listDomains(req("/api/domains", null), emptyCtx())).status).toBe(401);
		expect((await listDomains(req("/api/domains", readKey), emptyCtx())).status).toBe(403);
		const denied = await createMailbox(
			req("/api/mailboxes", readKey, { domainId: DOMAIN, localPart: "support" }),
			emptyCtx(),
		);
		expect(denied.status).toBe(403);
	});

	it("lists domains and accounts for a key with the manage scopes", async () => {
		const { GET: listDomains } = await import("@/app/api/domains/route");
		const { GET: listAccounts } = await import("@/app/api/accounts/route");
		const domainsRes = await listDomains(req("/api/domains", manageKey), emptyCtx());
		expect(domainsRes.status).toBe(200);
		const domainsBody = (await domainsRes.json()) as { domains: { hostname: string }[] };
		expect(domainsBody.domains.map((d) => d.hostname)).toEqual([HOSTNAME]);

		const accountsRes = await listAccounts(req("/api/accounts", manageKey), emptyCtx());
		expect(accountsRes.status).toBe(200);
	});

	it("creates a shared mailbox and lists it back", async () => {
		const { GET: listMailboxes, POST: createMailbox } = await import("@/app/api/mailboxes/route");
		const created = await createMailbox(
			req("/api/mailboxes", manageKey, {
				domainId: DOMAIN,
				localPart: "Support",
				displayName: "Support desk",
				type: "shared",
			}),
			emptyCtx(),
		);
		expect(created.status).toBe(200);
		const body = (await created.json()) as { address: string; type: string };
		expect(body).toMatchObject({ address: `support@${HOSTNAME}`, type: "shared" });

		const listed = await listMailboxes(req("/api/mailboxes", manageKey), emptyCtx());
		expect(listed.status).toBe(200);
		const listBody = (await listed.json()) as { mailboxes: { localPart: string }[] };
		expect(listBody.mailboxes.some((m) => m.localPart === "support")).toBe(true);
	});
});
