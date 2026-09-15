/**
 * Cc and Bcc on drafts.
 *
 * A draft is a `messages` row with `status = 'draft'`, so it uses the same
 * `cc_addr` / `bcc_addr` columns a sent message does. The gap this covers is
 * the round trip: what the composer autosaves has to come back when the draft
 * is reopened, or the Cc is silently dropped on send.
 *
 * Both doors are exercised: the dashboard routes (`/api/drafts`, cookie
 * session) and the agent route (`POST /api/v1/drafts`, API key).
 */
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeys, domains, mailboxes, messages, organizations, users } from "@/db/schema";
import { generateApiKey, scopesToJson } from "@/lib/api-keys";
import { MAX_RECIPIENTS } from "@/lib/email/recipients";
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

const HOSTNAME = "drafts-cc.test";
const ORG = "org_draft_cc";
const USER = "usr_draft_cc";
const DOMAIN = "dom_draft_cc";
const MAILBOX = "mbx_draft_cc";
const MAILBOX_ADDRESS = `box@${HOSTNAME}`;

let apiKey = "";

type DraftBody = {
	draft?: { id: string; cc?: string | null; bcc?: string | null };
	error?: string;
};

type DraftReadBody = {
	draft?: { id: string; toAddr: string; ccAddr: string | null; bccAddr: string | null };
	error?: string;
};

async function seed(): Promise<void> {
	const db = createDb();

	await db
		.insert(organizations)
		.values({ id: ORG, name: "Draft Cc Org", slug: "draft-cc-org", status: "active" });

	await db.insert(users).values({
		id: USER,
		organizationId: ORG,
		email: `owner@${HOSTNAME}`,
		passwordHash: "x",
		name: "Owner",
		role: "admin",
	});

	await db.insert(domains).values({
		id: DOMAIN,
		organizationId: ORG,
		userId: USER,
		hostname: HOSTNAME,
		zoneId: "z_draft_cc",
	});

	await db.insert(mailboxes).values({
		id: MAILBOX,
		organizationId: ORG,
		userId: USER,
		domainId: DOMAIN,
		localPart: "box",
		displayName: "Box",
		useAllDomains: false,
	});

	const key = generateApiKey();
	await db.insert(apiKeys).values({
		id: "key_draft_cc",
		organizationId: ORG,
		userId: USER,
		name: "Draft Cc key",
		prefix: key.prefix,
		keyHash: key.hash,
		hashAlgo: key.hashAlgo,
		scopes: scopesToJson(["messages:write"]),
	});
	apiKey = key.fullKey;
}

async function signIn(): Promise<void> {
	const token = await createSession({ DB: createDb() } as unknown as CloudflareEnv, USER);
	cookieJar.clear();
	cookieJar.set(SESSION_COOKIE, token);
}

function get(url: string, headers?: Record<string, string>): Request {
	return new Request(`http://localhost${url}`, { headers });
}

function send(url: string, body: unknown, method = "POST", headers?: Record<string, string>): Request {
	return new Request(`http://localhost${url}`, {
		method,
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

/** Next always passes a route context, even for a route with no dynamic segment. */
function listCtx() {
	return { params: Promise.resolve({}) };
}

function draftCtx(id: string) {
	return { params: Promise.resolve({ id }) };
}

/** Short on purpose: `v1DraftSchema` caps the whole `to` string at 500 characters. */
function addresses(count: number, prefix: string): string[] {
	return Array.from({ length: count }, (_, index) => `${prefix}${index}@e.org`);
}

describe.skipIf(!hasTestDatabase())("drafts keep cc and bcc", () => {
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

	it("round-trips cc and bcc through create and read", async () => {
		const create = await import("@/app/api/drafts/route");
		const detail = await import("@/app/api/drafts/[id]/route");

		await signIn();
		const created = await create.POST(
			send("/api/drafts", {
				mailboxId: MAILBOX,
				from: MAILBOX_ADDRESS,
				to: "first@example.org",
				cc: "copied@example.org, second@example.org",
				bcc: ["hidden@example.org"],
				subject: "Half written",
				text: "Body.",
			}),
			listCtx(),
		);
		expect(created.status).toBe(200);
		const { draft } = (await created.json()) as DraftBody;
		expect(draft?.id).toBeTruthy();
		const draftId = draft!.id;

		const [row] = await createDb().select().from(messages).where(eq(messages.id, draftId));
		expect(row.status).toBe("draft");
		expect(row.ccAddr).toBe("copied@example.org, second@example.org");
		expect(row.bccAddr).toBe("hidden@example.org");

		const read = await detail.GET(get(`/api/drafts/${draftId}`), draftCtx(draftId));
		expect(read.status).toBe(200);
		const reopened = ((await read.json()) as DraftReadBody).draft;
		expect(reopened?.toAddr).toBe("first@example.org");
		expect(reopened?.ccAddr).toBe("copied@example.org, second@example.org");
		expect(reopened?.bccAddr).toBe("hidden@example.org");
	});

	it("updates and clears cc and bcc on PATCH", async () => {
		const create = await import("@/app/api/drafts/route");
		const detail = await import("@/app/api/drafts/[id]/route");

		await signIn();
		const created = await create.POST(
			send("/api/drafts", {
				mailboxId: MAILBOX,
				from: MAILBOX_ADDRESS,
				to: "first@example.org",
				cc: "copied@example.org",
				bcc: "hidden@example.org",
				subject: "Half written",
			}),
			listCtx(),
		);
		const draftId = ((await created.json()) as DraftBody).draft!.id;

		const patched = await detail.PATCH(
			send(
				`/api/drafts/${draftId}`,
				{
					mailboxId: MAILBOX,
					from: MAILBOX_ADDRESS,
					to: "first@example.org",
					cc: "someone-else@example.org",
					subject: "Half written",
				},
				"PATCH",
			),
			draftCtx(draftId),
		);
		expect(patched.status).toBe(200);

		const read = await detail.GET(get(`/api/drafts/${draftId}`), draftCtx(draftId));
		const reopened = ((await read.json()) as DraftReadBody).draft;
		expect(reopened?.ccAddr).toBe("someone-else@example.org");
		// Left out of the payload means "no Bcc", the same as the composer clearing it.
		expect(reopened?.bccAddr).toBeNull();
	});

	it("leaves cc and bcc null when the draft has none", async () => {
		const create = await import("@/app/api/drafts/route");

		await signIn();
		const created = await create.POST(
			send("/api/drafts", {
				mailboxId: MAILBOX,
				from: MAILBOX_ADDRESS,
				to: "first@example.org",
				subject: "Plain",
			}),
			listCtx(),
		);
		const draftId = ((await created.json()) as DraftBody).draft!.id;

		const [row] = await createDb().select().from(messages).where(eq(messages.id, draftId));
		expect(row.ccAddr).toBeNull();
		expect(row.bccAddr).toBeNull();
	});

	it("refuses more than 50 recipients across to, cc and bcc", async () => {
		const create = await import("@/app/api/drafts/route");

		await signIn();
		const refused = await create.POST(
			send("/api/drafts", {
				mailboxId: MAILBOX,
				from: MAILBOX_ADDRESS,
				to: addresses(30, "to").join(", "),
				cc: addresses(20, "cc").join(", "),
				bcc: "one-too-many@example.org",
				subject: "Too many",
			}),
			listCtx(),
		);
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as DraftBody).error).toContain(String(MAX_RECIPIENTS));
		expect(await createDb().select().from(messages)).toHaveLength(0);

		// Exactly 50 is allowed.
		const accepted = await create.POST(
			send("/api/drafts", {
				mailboxId: MAILBOX,
				from: MAILBOX_ADDRESS,
				to: addresses(30, "to").join(", "),
				cc: addresses(19, "cc"),
				bcc: "just-fits@example.org",
				subject: "At the limit",
			}),
			listCtx(),
		);
		expect(accepted.status).toBe(200);
	});

	it("stores and returns cc and bcc on POST /api/v1/drafts", async () => {
		const { POST } = await import("@/app/api/v1/drafts/route");

		const response = await POST(
			send(
				"/api/v1/drafts",
				{
					mailboxId: MAILBOX,
					to: "first@example.org",
					cc: ["copied@example.org", "second@example.org"],
					bcc: "hidden@example.org",
					subject: "From an agent",
					text: "Body.",
				},
				"POST",
				{ Authorization: `Bearer ${apiKey}` },
			),
			listCtx(),
		);
		expect(response.status).toBe(201);
		const { draft } = (await response.json()) as DraftBody;
		expect(draft?.cc).toBe("copied@example.org, second@example.org");
		expect(draft?.bcc).toBe("hidden@example.org");

		const [row] = await createDb().select().from(messages).where(eq(messages.id, draft!.id));
		expect(row.ccAddr).toBe("copied@example.org, second@example.org");
		expect(row.bccAddr).toBe("hidden@example.org");
	});

	it("refuses more than 50 recipients on POST /api/v1/drafts", async () => {
		const { POST } = await import("@/app/api/v1/drafts/route");

		const response = await POST(
			send(
				"/api/v1/drafts",
				{
					mailboxId: MAILBOX,
					to: addresses(30, "to").join(", "),
					cc: addresses(20, "cc"),
					bcc: "one-too-many@example.org",
					subject: "Too many",
				},
				"POST",
				{ Authorization: `Bearer ${apiKey}` },
			),
			listCtx(),
		);
		expect(response.status).toBe(400);
		expect(await createDb().select().from(messages)).toHaveLength(0);
	});
});
