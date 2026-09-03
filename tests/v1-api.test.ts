/**
 * T6.2 — the public v1 API surface.
 *
 * The route handlers are called exactly as Next calls them, authenticated with
 * real API keys, so scopes, mailbox access and the per-key rate limit are all
 * exercised for real. Only the mail transport is stubbed.
 *
 * NOTE: `messages.search_vector` is a generated column whose migration is
 * produced after this wave's concurrent schema edits land, so `tests/setup.ts`
 * applies the DDL itself (`tests/helpers/search-column.ts`) with
 * `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. The exact SQL the
 * real migration needs is quoted at the top of `src/lib/search/service.ts`.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiKeys,
	contacts,
	conversations,
	domains,
	mailboxes,
	messages,
	organizations,
	users,
} from "@/db/schema";
import { generateApiKey, scopesToJson } from "@/lib/api-keys";
import type { ScopeName } from "@/lib/api/scopes";
import { getEnv } from "@/lib/env";
import { ensureApiKeyColumns } from "./helpers/api-key-columns";
import { createDb, hasTestDatabase } from "./helpers/db";

// No cookies anywhere: every request in this file authenticates with a key.
vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => undefined }),
}));

const HOSTNAME = "v1-api.test";
const ORG_A = "org_v1_a";
const ORG_B = "org_v1_b";
const USER_A = "usr_v1_a";
const USER_B = "usr_v1_b";
const MAILBOX_A = "mbx_v1_a";
const MAILBOX_B = "mbx_v1_b";
const CONV_WIDGET = "cnv_v1_widget";
const CONV_INVOICE = "cnv_v1_invoice";
const MSG_WIDGET = "msg_v1_widget";
const MSG_INVOICE = "msg_v1_invoice";
const INBOUND_MESSAGE_ID = "<inbound-1@example.org>";

const ALL_SCOPES: ScopeName[] = [
	"messages:read",
	"messages:write",
	"conversations:read",
	"conversations:write",
	"contacts:read",
	"send",
];

/** Keys created by `seed()`. */
let agentKey = "";
let readOnlyKey = "";
let otherOrgKey = "";

/** Every message the stubbed transport was asked to send. */
const sent: Array<{ to: string; subject: string; headers?: Record<string, string> }> = [];

function request(url: string, init?: RequestInit): Request {
	return new Request(`http://localhost${url}`, init);
}

function get(url: string, key: string): Request {
	return request(url, { headers: { Authorization: `Bearer ${key}` } });
}

function post(url: string, key: string, body: unknown, method = "POST"): Request {
	return request(url, {
		method,
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function ctx<P extends Record<string, string>>(params: P) {
	return { params: Promise.resolve(params) };
}

function emptyCtx() {
	return { params: Promise.resolve({}) };
}

async function issueKey(id: string, orgId: string, userId: string, scopes: ScopeName[]) {
	const key = generateApiKey();
	await createDb()
		.insert(apiKeys)
		.values({
			id,
			organizationId: orgId,
			userId,
			name: id,
			prefix: key.prefix,
			keyHash: key.hash,
			hashAlgo: key.hashAlgo,
			scopes: scopesToJson(scopes),
		});
	return key.fullKey;
}

async function seed(): Promise<void> {
	const db = createDb();

	await db.insert(organizations).values([
		{ id: ORG_A, name: "V1 Org A", slug: "v1-org-a", status: "active" },
		{ id: ORG_B, name: "V1 Org B", slug: "v1-org-b", status: "active" },
	]);

	await db.insert(users).values([
		{
			id: USER_A,
			organizationId: ORG_A,
			email: `agent@${HOSTNAME}`,
			passwordHash: "x",
			name: "Agent A",
			role: "admin",
		},
		{
			id: USER_B,
			organizationId: ORG_B,
			email: "agent@other.test",
			passwordHash: "x",
			name: "Agent B",
			role: "admin",
		},
	]);

	await db.insert(domains).values([
		{ id: "dom_v1_a", organizationId: ORG_A, userId: USER_A, hostname: HOSTNAME, zoneId: "z_a" },
		{ id: "dom_v1_b", organizationId: ORG_B, userId: USER_B, hostname: "other.test", zoneId: "z_b" },
	]);

	await db.insert(mailboxes).values([
		{
			id: MAILBOX_A,
			organizationId: ORG_A,
			userId: USER_A,
			domainId: "dom_v1_a",
			localPart: "support",
			displayName: "Support",
		},
		{
			id: MAILBOX_B,
			organizationId: ORG_B,
			userId: USER_B,
			domainId: "dom_v1_b",
			localPart: "support",
			displayName: "Support B",
		},
	]);

	const at = new Date("2026-05-01T10:00:00Z");
	await db.insert(conversations).values([
		{
			id: CONV_WIDGET,
			organizationId: ORG_A,
			mailboxId: MAILBOX_A,
			subject: "Broken widget",
			subjectNormalized: "broken widget",
			lastMessageAt: at,
			messageCount: 1,
			createdAt: at,
		},
		{
			id: CONV_INVOICE,
			organizationId: ORG_A,
			mailboxId: MAILBOX_A,
			subject: "Invoice 42",
			subjectNormalized: "invoice 42",
			lastMessageAt: new Date(at.getTime() - 60_000),
			messageCount: 1,
			createdAt: new Date(at.getTime() - 60_000),
		},
	]);

	await db.insert(messages).values([
		{
			id: MSG_WIDGET,
			organizationId: ORG_A,
			userId: USER_A,
			mailboxId: MAILBOX_A,
			conversationId: CONV_WIDGET,
			direction: "inbound",
			providerMessageId: INBOUND_MESSAGE_ID,
			fromAddr: "customer@example.org",
			toAddr: `support@${HOSTNAME}`,
			subject: "Broken widget",
			snippet: "The gadget is smoking",
			textBody: "The gadget is smoking and will not start.",
			read: false,
			createdAt: at,
		},
		{
			id: MSG_INVOICE,
			organizationId: ORG_A,
			userId: USER_A,
			mailboxId: MAILBOX_A,
			conversationId: CONV_INVOICE,
			direction: "inbound",
			providerMessageId: "<inbound-2@example.org>",
			fromAddr: "billing@example.org",
			toAddr: `support@${HOSTNAME}`,
			subject: "Invoice 42",
			snippet: "Payment terms",
			textBody: "Payment terms are net thirty days.",
			read: true,
			createdAt: new Date(at.getTime() - 60_000),
		},
	]);

	await db.insert(contacts).values({
		id: "ctc_v1_a",
		organizationId: ORG_A,
		userId: USER_A,
		email: "customer@example.org",
		displayName: "Customer One",
		source: "inbound",
	});

	agentKey = await issueKey("key_v1_agent", ORG_A, USER_A, ALL_SCOPES);
	readOnlyKey = await issueKey("key_v1_read", ORG_A, USER_A, ["messages:read"]);
	otherOrgKey = await issueKey("key_v1_other", ORG_B, USER_B, ALL_SCOPES);
}

describe.skipIf(!hasTestDatabase())("v1 API (T6.2)", () => {
	beforeAll(async () => {
		await ensureApiKeyColumns();
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		// A half-configured transport makes `getEnv()` throw; the stub below
		// replaces it anyway.
		delete process.env.EDGE_WORKER_URL;
		delete process.env.EDGE_WORKER_SECRET;

		const env = getEnv();
		env.EMAIL = {
			async send(message) {
				sent.push({ to: message.to, subject: message.subject, headers: message.headers });
				return { messageId: `<sent-${sent.length}@${HOSTNAME}>` };
			},
		};
	});

	beforeEach(async () => {
		sent.length = 0;
		const { resetV1RateLimit } = await import("@/app/api/v1/route-helpers");
		resetV1RateLimit();
		await seed();
	});

	it("lists the mailboxes the key can reach", async () => {
		const { GET } = await import("@/app/api/v1/mailboxes/route");
		const response = await GET(get("/api/v1/mailboxes", agentKey), emptyCtx());
		expect(response.status).toBe(200);

		const body = (await response.json()) as { mailboxes: Array<{ id: string; address: string }> };
		expect(body.mailboxes).toHaveLength(1);
		expect(body.mailboxes[0]).toMatchObject({ id: MAILBOX_A, address: `support@${HOSTNAME}` });
	});

	it("lists and reads conversations", async () => {
		const list = await import("@/app/api/v1/conversations/route");
		const listed = await list.GET(get("/api/v1/conversations", agentKey), emptyCtx());
		expect(listed.status).toBe(200);
		const page = (await listed.json()) as {
			conversations: Array<{ id: string }>;
			nextCursor: string | null;
		};
		expect(page.conversations.map((row) => row.id)).toEqual([CONV_WIDGET, CONV_INVOICE]);
		expect(page.nextCursor).toBeNull();

		const detail = await import("@/app/api/v1/conversations/[id]/route");
		const one = await detail.GET(
			get(`/api/v1/conversations/${CONV_WIDGET}`, agentKey),
			ctx({ id: CONV_WIDGET }),
		);
		expect(one.status).toBe(200);
		const body = (await one.json()) as {
			conversation: { id: string; messages: Array<{ id: string }>; notes: unknown[] };
		};
		expect(body.conversation.id).toBe(CONV_WIDGET);
		expect(body.conversation.messages.map((m) => m.id)).toEqual([MSG_WIDGET]);
	});

	it("replies into the thread and threads the outbound row", async () => {
		const { POST } = await import("@/app/api/v1/conversations/[id]/reply/route");
		const response = await POST(
			post(`/api/v1/conversations/${CONV_WIDGET}/reply`, agentKey, {
				text: "A replacement is on its way.",
			}),
			ctx({ id: CONV_WIDGET }),
		);
		expect(response.status).toBe(201);
		const body = (await response.json()) as { message: { id: string } };

		// The transport saw the threading header and the derived recipient/subject.
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe("customer@example.org");
		expect(sent[0].subject).toBe("Re: Broken widget");
		expect(sent[0].headers?.["In-Reply-To"]).toBe(INBOUND_MESSAGE_ID);

		const [row] = await createDb()
			.select()
			.from(messages)
			.where(eq(messages.id, body.message.id));
		expect(row?.direction).toBe("outbound");
		expect(row?.inReplyTo).toBe(INBOUND_MESSAGE_ID);
		expect(row?.conversationId).toBe(CONV_WIDGET);
		expect(row?.status).toBe("sent");
	});

	it("assigns a conversation", async () => {
		const { POST } = await import("@/app/api/v1/conversations/[id]/assign/route");
		const response = await POST(
			post(`/api/v1/conversations/${CONV_WIDGET}/assign`, agentKey, { userId: USER_A }),
			ctx({ id: CONV_WIDGET }),
		);
		expect(response.status).toBe(200);

		const [row] = await createDb()
			.select()
			.from(conversations)
			.where(eq(conversations.id, CONV_WIDGET));
		expect(row?.assignedUserId).toBe(USER_A);
	});

	it("adds and lists an internal note", async () => {
		const notes = await import("@/app/api/v1/conversations/[id]/notes/route");
		const created = await notes.POST(
			post(`/api/v1/conversations/${CONV_WIDGET}/notes`, agentKey, {
				body: "Customer is on the annual plan.",
			}),
			ctx({ id: CONV_WIDGET }),
		);
		expect(created.status).toBe(201);

		const listed = await notes.GET(
			get(`/api/v1/conversations/${CONV_WIDGET}/notes`, agentKey),
			ctx({ id: CONV_WIDGET }),
		);
		const body = (await listed.json()) as { notes: Array<{ body: string }> };
		expect(body.notes.map((note) => note.body)).toEqual(["Customer is on the annual plan."]);
	});

	it("patches a message", async () => {
		const { PATCH } = await import("@/app/api/v1/messages/[id]/route");
		const response = await PATCH(
			post(`/api/v1/messages/${MSG_WIDGET}`, agentKey, { read: true, starred: true }, "PATCH"),
			ctx({ id: MSG_WIDGET }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			message: { id: MSG_WIDGET, read: true, starred: true },
		});

		const [row] = await createDb().select().from(messages).where(eq(messages.id, MSG_WIDGET));
		expect(row?.read).toBe(true);
		expect(row?.starred).toBe(true);
	});

	it("searches subjects and bodies, and misses everything else", async () => {
		const { GET } = await import("@/app/api/v1/search/route");

		const bySubject = await GET(get("/api/v1/search?q=widget", agentKey), emptyCtx());
		expect(bySubject.status).toBe(200);
		const subjectHits = (await bySubject.json()) as { hits: Array<{ id: string }> };
		expect(subjectHits.hits.map((hit) => hit.id)).toEqual([MSG_WIDGET]);

		const byBody = await GET(get("/api/v1/search?q=thirty", agentKey), emptyCtx());
		const bodyHits = (await byBody.json()) as { hits: Array<{ id: string }> };
		expect(bodyHits.hits.map((hit) => hit.id)).toEqual([MSG_INVOICE]);

		const miss = await GET(get("/api/v1/search?q=aubergine", agentKey), emptyCtx());
		const missHits = (await miss.json()) as { hits: unknown[] };
		expect(missHits.hits).toEqual([]);
	});

	it("reads contacts", async () => {
		const { GET } = await import("@/app/api/v1/contacts/route");
		const response = await GET(get("/api/v1/contacts", agentKey), emptyCtx());
		expect(response.status).toBe(200);
		const body = (await response.json()) as { contacts: Array<{ email: string }> };
		expect(body.contacts.map((contact) => contact.email)).toEqual(["customer@example.org"]);
	});

	it("creates a draft", async () => {
		const { POST } = await import("@/app/api/v1/drafts/route");
		const response = await POST(
			post("/api/v1/drafts", agentKey, {
				mailboxId: MAILBOX_A,
				to: "customer@example.org",
				subject: "Follow-up",
				text: "Checking in.",
			}),
			emptyCtx(),
		);
		expect(response.status).toBe(201);
		const body = (await response.json()) as { draft: { id: string } };

		const [row] = await createDb()
			.select()
			.from(messages)
			.where(and(eq(messages.id, body.draft.id), eq(messages.organizationId, ORG_A)));
		expect(row?.status).toBe("draft");
		expect(row?.direction).toBe("outbound");
		expect(row?.toAddr).toBe("customer@example.org");
	});

	it("403s a key without the route's scope", async () => {
		const { POST } = await import("@/app/api/v1/conversations/[id]/assign/route");
		const response = await POST(
			post(`/api/v1/conversations/${CONV_WIDGET}/assign`, readOnlyKey, { userId: USER_A }),
			ctx({ id: CONV_WIDGET }),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "Insufficient scope" });
	});

	it("shows another organisation's key nothing", async () => {
		const list = await import("@/app/api/v1/conversations/route");
		const listed = await list.GET(get("/api/v1/conversations", otherOrgKey), emptyCtx());
		expect(listed.status).toBe(200);
		expect((await listed.json()) as { conversations: unknown[] }).toMatchObject({
			conversations: [],
		});

		const detail = await import("@/app/api/v1/conversations/[id]/route");
		const one = await detail.GET(
			get(`/api/v1/conversations/${CONV_WIDGET}`, otherOrgKey),
			ctx({ id: CONV_WIDGET }),
		);
		expect(one.status).toBe(404);

		const search = await import("@/app/api/v1/search/route");
		const found = await search.GET(get("/api/v1/search?q=widget", otherOrgKey), emptyCtx());
		expect((await found.json()) as { hits: unknown[] }).toMatchObject({ hits: [] });

		const patch = await import("@/app/api/v1/messages/[id]/route");
		const patched = await patch.PATCH(
			post(`/api/v1/messages/${MSG_WIDGET}`, otherOrgKey, { read: true }, "PATCH"),
			ctx({ id: MSG_WIDGET }),
		);
		expect(patched.status).toBe(404);
	});

	it("429s the 601st request a key makes in a minute", async () => {
		const { GET } = await import("@/app/api/v1/search/route");
		const { V1_RATE_LIMIT } = await import("@/app/api/v1/route-helpers");
		expect(V1_RATE_LIMIT).toBe(600);

		// A missing `q` is rejected inside the handler, i.e. after the limiter has
		// counted the request — the cheapest call that still consumes quota.
		// Fired in batches: 600 round trips one at a time would take longer than
		// the window they are supposed to fill.
		const BATCH = 50;
		for (let done = 0; done < V1_RATE_LIMIT; done += BATCH) {
			const batch = await Promise.all(
				Array.from({ length: BATCH }, () => GET(get("/api/v1/search", agentKey), emptyCtx())),
			);
			expect(batch.map((response) => response.status)).toEqual(Array(BATCH).fill(400));
		}

		const limited = await GET(get("/api/v1/search", agentKey), emptyCtx());
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("60");
		expect(await limited.json()).toEqual({
			error: "Rate limit exceeded",
			code: "rate_limited",
		});

		// The limit is per key, not per organisation or per user.
		const other = await GET(get("/api/v1/search?q=widget", readOnlyKey), emptyCtx());
		expect(other.status).toBe(200);
	}, 180_000);

	it("429s the 601st send a key makes in a minute", async () => {
		const { POST } = await import("@/app/api/v1/send/route");
		const { V1_RATE_LIMIT } = await import("@/app/api/v1/route-helpers");
		expect(V1_RATE_LIMIT).toBe(600);

		// An empty body is rejected inside the handler, i.e. after the limiter has
		// counted the request — the cheapest call that still consumes quota.
		const BATCH = 50;
		for (let done = 0; done < V1_RATE_LIMIT; done += BATCH) {
			const batch = await Promise.all(
				Array.from({ length: BATCH }, () =>
					POST(post("/api/v1/send", agentKey, {}), emptyCtx()),
				),
			);
			expect(batch.map((response) => response.status)).toEqual(Array(BATCH).fill(400));
		}

		const limited = await POST(post("/api/v1/send", agentKey, {}), emptyCtx());
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("60");
		expect(await limited.json()).toEqual({
			error: "Rate limit exceeded",
			code: "rate_limited",
		});
		// Nothing reached the transport: every request failed before sending.
		expect(sent).toHaveLength(0);
	}, 180_000);
});
