/**
 * T3.2 — organisation scope for `messages`, `drafts`, `conversations` and the
 * public `/api/v1` surface.
 *
 * Two organisations with one user, one mailbox, one message, one conversation
 * and one attachment each. Every assertion is about a caller in org A never
 * seeing or touching anything in org B, whether it authenticated with a cookie
 * session or with an org-A API key.
 */
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiKeys,
	conversationNotes,
	conversations,
	domains,
	mailboxes,
	messageAttachments,
	messages,
	organizations,
	users,
} from "@/db/schema";
import { generateApiKey, scopesToJson } from "@/lib/api-keys";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
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

const ORG_A = "org_msg_a";
const ORG_B = "org_msg_b";

const USER_A = "usr_msg_a";
const USER_B = "usr_msg_b";

const MAILBOX_A = "mbx_msg_a";
const MAILBOX_B = "mbx_msg_b";

const MESSAGE_A = "msg_org_a";
const MESSAGE_B = "msg_org_b";

const CONVERSATION_A = "cnv_org_a";
const CONVERSATION_B = "cnv_org_b";

const ATTACHMENT_B = "att_org_b";

const SENT_AT = new Date("2026-01-02T10:00:00Z");

let apiKeyA = "";

async function seed(): Promise<void> {
	const db = createDb();

	await db.insert(organizations).values([
		{ id: ORG_A, name: "Org A", slug: "msg-org-a", status: "active" },
		{ id: ORG_B, name: "Org B", slug: "msg-org-b", status: "active" },
	]);

	await db.insert(users).values([
		{
			id: USER_A,
			organizationId: ORG_A,
			email: "a@msg-org-a.test",
			passwordHash: "x",
			name: "A",
			role: "admin",
		},
		{
			id: USER_B,
			organizationId: ORG_B,
			email: "b@msg-org-b.test",
			passwordHash: "x",
			name: "B",
			role: "admin",
		},
	]);

	await db.insert(domains).values([
		{
			id: "dom_msg_a",
			organizationId: ORG_A,
			userId: USER_A,
			hostname: "msg-org-a.test",
			zoneId: "z_msg_a",
		},
		{
			id: "dom_msg_b",
			organizationId: ORG_B,
			userId: USER_B,
			hostname: "msg-org-b.test",
			zoneId: "z_msg_b",
		},
	]);

	await db.insert(mailboxes).values([
		{
			id: MAILBOX_A,
			organizationId: ORG_A,
			userId: USER_A,
			domainId: "dom_msg_a",
			localPart: "team",
		},
		{
			id: MAILBOX_B,
			organizationId: ORG_B,
			userId: USER_B,
			domainId: "dom_msg_b",
			localPart: "team",
		},
	]);

	await db.insert(conversations).values([
		{
			id: CONVERSATION_A,
			organizationId: ORG_A,
			mailboxId: MAILBOX_A,
			subject: "Org A thread",
			subjectNormalized: "org a thread",
			lastMessageAt: SENT_AT,
			messageCount: 1,
			createdAt: SENT_AT,
		},
		{
			id: CONVERSATION_B,
			organizationId: ORG_B,
			mailboxId: MAILBOX_B,
			subject: "Org B thread",
			subjectNormalized: "org b thread",
			lastMessageAt: SENT_AT,
			messageCount: 1,
			createdAt: SENT_AT,
		},
	]);

	await db.insert(messages).values([
		{
			id: MESSAGE_A,
			organizationId: ORG_A,
			userId: USER_A,
			mailboxId: MAILBOX_A,
			conversationId: CONVERSATION_A,
			direction: "inbound",
			fromAddr: "customer@example.org",
			toAddr: "team@msg-org-a.test",
			subject: "Org A message",
			snippet: "Org A body",
			status: "received",
			read: false,
			createdAt: SENT_AT,
		},
		{
			id: MESSAGE_B,
			organizationId: ORG_B,
			userId: USER_B,
			mailboxId: MAILBOX_B,
			conversationId: CONVERSATION_B,
			direction: "inbound",
			fromAddr: "customer@example.org",
			toAddr: "team@msg-org-b.test",
			subject: "Org B message",
			snippet: "Org B body",
			status: "received",
			read: false,
			createdAt: SENT_AT,
		},
	]);

	await db.insert(conversationNotes).values({
		id: "cnote_org_b",
		conversationId: CONVERSATION_B,
		userId: USER_B,
		body: "Org B note",
	});

	await db.insert(messageAttachments).values({
		id: ATTACHMENT_B,
		messageId: MESSAGE_B,
		filename: "secret.txt",
		contentType: "text/plain",
		size: 11,
		disposition: "attachment",
		r2Key: `attachments/${MESSAGE_B}/${ATTACHMENT_B}/secret.txt`,
	});

	const key = generateApiKey();
	apiKeyA = key.fullKey;
	await db.insert(apiKeys).values({
		id: "key_msg_org_a",
		organizationId: ORG_A,
		userId: USER_A,
		name: "Org A key",
		prefix: key.prefix,
		keyHash: key.hash,
		scopes: scopesToJson(["messages:read"]),
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

function post(url: string, body?: unknown): Request {
	return new Request(`http://localhost${url}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
}

/** Next always passes a route context, even for routes with no dynamic segment. */
function listCtx() {
	return { params: Promise.resolve({}) };
}

function messageCtx(messageId: string) {
	return { params: Promise.resolve({ messageId }) };
}

function conversationCtx(id: string) {
	return { params: Promise.resolve({ id }) };
}

describe.skipIf(!hasTestDatabase())("organisation scope: messages and conversations (T3.2)", () => {
	beforeAll(() => {
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

	it("lists only the caller's organisation messages", async () => {
		const { GET } = await import("@/app/api/messages/route");

		await signIn(USER_A);
		const response = await GET(get("/api/messages"), listCtx());
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			messages: Array<{ id: string }>;
			total: number;
		};
		expect(body.messages.map((message) => message.id)).toEqual([MESSAGE_A]);
		expect(body.total).toBe(1);
	});

	it("404s another organisation's mailbox on the message list and counts", async () => {
		const list = await import("@/app/api/messages/route");
		const counts = await import("@/app/api/messages/counts/route");

		await signIn(USER_A);
		const listed = await list.GET(get(`/api/messages?mailboxId=${MAILBOX_B}`), listCtx());
		expect(listed.status).toBe(404);

		const denied = await counts.GET(get(`/api/messages/counts?mailboxId=${MAILBOX_B}`), listCtx());
		expect(denied.status).toBe(404);

		const own = await counts.GET(get("/api/messages/counts"), listCtx());
		const body = (await own.json()) as {
			counts: { folders: { inbox: { total: number } }; mailboxes: Array<{ mailboxId: string }> };
		};
		expect(body.counts.folders.inbox.total).toBe(1);
		expect(body.counts.mailboxes.map((row) => row.mailboxId)).toEqual([MAILBOX_A]);
	});

	it("404s reading another organisation's message, body and metadata", async () => {
		const detail = await import("@/app/api/messages/[messageId]/route");
		const metadata = await import("@/app/api/messages/[messageId]/metadata/route");

		await signIn(USER_A);
		const hidden = await detail.GET(get(`/api/messages/${MESSAGE_B}`), messageCtx(MESSAGE_B));
		expect(hidden.status).toBe(404);

		const hiddenMetadata = await metadata.GET(
			get(`/api/messages/${MESSAGE_B}/metadata`),
			messageCtx(MESSAGE_B),
		);
		expect(hiddenMetadata.status).toBe(404);

		const own = await detail.GET(get(`/api/messages/${MESSAGE_A}`), messageCtx(MESSAGE_A));
		expect(own.status).toBe(200);
	});

	it("cannot star, read, snooze or set the status of another organisation's message", async () => {
		const star = await import("@/app/api/messages/[messageId]/star/route");
		const read = await import("@/app/api/messages/[messageId]/read/route");
		const snooze = await import("@/app/api/messages/[messageId]/snooze/route");
		const status = await import("@/app/api/messages/[messageId]/status/route");
		const db = createDb();

		await signIn(USER_A);

		expect(
			(await star.POST(post(`/api/messages/${MESSAGE_B}/star`), messageCtx(MESSAGE_B))).status,
		).toBe(404);
		expect(
			(await read.POST(post(`/api/messages/${MESSAGE_B}/read`), messageCtx(MESSAGE_B))).status,
		).toBe(404);
		expect(
			(
				await snooze.POST(
					post(`/api/messages/${MESSAGE_B}/snooze`, {
						snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
					}),
					messageCtx(MESSAGE_B),
				)
			).status,
		).toBe(404);
		expect(
			(
				await snooze.DELETE(
					post(`/api/messages/${MESSAGE_B}/snooze`),
					messageCtx(MESSAGE_B),
				)
			).status,
		).toBe(404);
		expect(
			(
				await status.POST(
					post(`/api/messages/${MESSAGE_B}/status`, { status: "trash" }),
					messageCtx(MESSAGE_B),
				)
			).status,
		).toBe(404);

		const [untouched] = await db.select().from(messages).where(eq(messages.id, MESSAGE_B));
		expect(untouched.starred).toBe(false);
		expect(untouched.read).toBe(false);
		expect(untouched.snoozedUntil).toBeNull();
		expect(untouched.status).toBe("received");

		// The same calls against its own message do work.
		const own = await star.POST(post(`/api/messages/${MESSAGE_A}/star`), messageCtx(MESSAGE_A));
		expect(own.status).toBe(200);
		expect((await own.json()) as { starred: boolean }).toEqual({ starred: true });
	});

	it("cannot bulk-update another organisation's messages", async () => {
		const { POST } = await import("@/app/api/messages/bulk/route");
		const db = createDb();

		await signIn(USER_A);
		const response = await POST(
			post("/api/messages/bulk", { messageIds: [MESSAGE_B], action: "trash" }),
			listCtx(),
		);
		expect(response.status).toBe(404);
		expect((await response.json()) as { error: string }).toEqual({ error: "No accessible messages" });

		const [untouched] = await db.select().from(messages).where(eq(messages.id, MESSAGE_B));
		expect(untouched.status).toBe("received");

		// A bulk update inside the organisation still works, and only touches org A.
		const own = await POST(
			post("/api/messages/bulk", { messageIds: [MESSAGE_A, MESSAGE_B], action: "trash" }),
			listCtx(),
		);
		expect(own.status).toBe(200);
		const [ownRow] = await db.select().from(messages).where(eq(messages.id, MESSAGE_A));
		expect(ownRow.status).toBe("trash");
		const [otherRow] = await db.select().from(messages).where(eq(messages.id, MESSAGE_B));
		expect(otherRow.status).toBe("received");
	});

	it("lists and reads only its own organisation's conversations and notes", async () => {
		const list = await import("@/app/api/conversations/route");
		const detail = await import("@/app/api/conversations/[id]/route");
		const notes = await import("@/app/api/conversations/[id]/notes/route");

		await signIn(USER_A);

		const listed = await list.GET(get("/api/conversations"), listCtx());
		expect(listed.status).toBe(200);
		expect(
			((await listed.json()) as { conversations: Array<{ id: string }> }).conversations.map(
				(row) => row.id,
			),
		).toEqual([CONVERSATION_A]);

		const hidden = await detail.GET(
			get(`/api/conversations/${CONVERSATION_B}`),
			conversationCtx(CONVERSATION_B),
		);
		expect(hidden.status).toBe(404);

		const hiddenNotes = await notes.GET(
			get(`/api/conversations/${CONVERSATION_B}/notes`),
			conversationCtx(CONVERSATION_B),
		);
		expect(hiddenNotes.status).toBe(404);

		const hiddenPatch = await detail.PATCH(
			new Request(`http://localhost/api/conversations/${CONVERSATION_B}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "closed" }),
			}),
			conversationCtx(CONVERSATION_B),
		);
		expect(hiddenPatch.status).toBe(404);

		const own = await detail.GET(
			get(`/api/conversations/${CONVERSATION_A}`),
			conversationCtx(CONVERSATION_A),
		);
		expect(own.status).toBe(200);
		const [row] = await createDb()
			.select()
			.from(conversations)
			.where(eq(conversations.id, CONVERSATION_B));
		expect(row.status).toBe("open");
	});

	it("404s an attachment on another organisation's message", async () => {
		const { GET } = await import(
			"@/app/api/messages/[messageId]/attachments/[attachmentId]/route"
		);

		await signIn(USER_A);
		const response = await GET(
			get(`/api/messages/${MESSAGE_B}/attachments/${ATTACHMENT_B}`),
			{ params: Promise.resolve({ messageId: MESSAGE_B, attachmentId: ATTACHMENT_B }) },
		);
		expect(response.status).toBe(404);
	});

	it("lists only its own organisation's drafts", async () => {
		const { GET } = await import("@/app/api/drafts/route");
		await createDb()
			.insert(messages)
			.values({
				id: "msg_draft_b",
				organizationId: ORG_B,
				userId: USER_B,
				mailboxId: MAILBOX_B,
				direction: "outbound",
				fromAddr: "team@msg-org-b.test",
				toAddr: "customer@example.org",
				subject: "Org B draft",
				status: "draft",
				read: true,
			});

		await signIn(USER_A);
		const response = await GET(get("/api/drafts"), listCtx());
		expect(response.status).toBe(200);
		expect(((await response.json()) as { drafts: Array<{ id: string }> }).drafts).toEqual([]);
	});

	it("gives an org-A API key nothing from org B on /api/v1/messages", async () => {
		const { GET } = await import("@/app/api/v1/messages/route");

		const response = await GET(
			get("/api/v1/messages", { authorization: `Bearer ${apiKeyA}` }),
			listCtx(),
		);
		expect(response.status).toBe(200);
		expect(
			((await response.json()) as { messages: Array<{ id: string }> }).messages.map(
				(message) => message.id,
			),
		).toEqual([MESSAGE_A]);

		// Naming org B's mailbox explicitly is a 404, not a leak.
		const denied = await GET(
			get(`/api/v1/messages?mailboxId=${MAILBOX_B}`, { authorization: `Bearer ${apiKeyA}` }),
			listCtx(),
		);
		expect(denied.status).toBe(404);

		// A key without the scope is refused.
		const send = await import("@/app/api/v1/send/route");
		const refused = await send.POST(
			new Request("http://localhost/api/v1/send", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					authorization: `Bearer ${apiKeyA}`,
				},
				body: JSON.stringify({ to: "customer@example.org", subject: "hi", text: "hi" }),
			}),
			listCtx(),
		);
		expect(refused.status).toBe(403);
	});
});
