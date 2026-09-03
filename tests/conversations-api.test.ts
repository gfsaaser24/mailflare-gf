/**
 * T2.2 — the internal conversation API.
 *
 * The routes are called directly (as Next calls them) with a mocked cookie jar,
 * so authentication and mailbox access levels are exercised for real.
 */
import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	conversationNotes,
	conversations,
	domains,
	mailboxAccess,
	mailboxes,
	messages,
	users,
} from "@/db/schema";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { createDb, hasTestDatabase } from "./helpers/db";
import { DEFAULT_ORGANIZATION_ID } from "@/lib/organizations/constants";

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

const HOSTNAME = "conversation-api.example";

const OWNER = "usr_owner";
const READER = "usr_reader";
const AGENT = "usr_agent";
const OUTSIDER = "usr_outsider";
const SHARED_MAILBOX = "mbx_shared";
const OUTSIDER_MAILBOX = "mbx_outsider";

/**
 * The organisations work (T3.1) gives every tenant row a default
 * `organization_id`, and `truncateAll()` empties that table too. Re-seed it when
 * it exists; ignore the failure when it does not.
 */
async function ensureDefaultOrganization(): Promise<void> {
	try {
		await createDb().execute(
			sql`INSERT INTO organizations (id, name, slug, status, created_at)
			    VALUES ('org_default', 'Default', 'default', 'active', now())
			    ON CONFLICT (id) DO NOTHING`,
		);
	} catch {
		// The organizations table is not part of the schema yet.
	}
}

async function seed(): Promise<void> {
	await ensureDefaultOrganization();
	const db = createDb();
	await db.insert(users).values([
		{ id: OWNER, email: `owner@${HOSTNAME}`, passwordHash: "x", name: "Owner", role: "admin" },
		{ id: READER, email: `reader@${HOSTNAME}`, passwordHash: "x", name: "Reader", role: "user" },
		{ id: AGENT, email: `agent@${HOSTNAME}`, passwordHash: "x", name: "Agent", role: "user" },
		{
			id: OUTSIDER,
			email: `outsider@${HOSTNAME}`,
			passwordHash: "x",
			name: "Outsider",
			role: "user",
		},
	]);
	await db.insert(domains).values({
		id: "dom_conv",
		userId: OWNER,
		hostname: HOSTNAME,
		zoneId: "zone_conv",
		status: "active",
	});
	await db.insert(mailboxes).values([
		{
			id: SHARED_MAILBOX,
			userId: OWNER,
			domainId: "dom_conv",
			localPart: "support",
			displayName: "Support",
			type: "shared",
		},
		{
			id: OUTSIDER_MAILBOX,
			userId: OUTSIDER,
			domainId: "dom_conv",
			localPart: "outsider",
			displayName: "Outsider",
		},
	]);
	await db.insert(mailboxAccess).values([
		{ id: "acc_reader", mailboxId: SHARED_MAILBOX, userId: READER, permission: "read_only" },
		{ id: "acc_agent", mailboxId: SHARED_MAILBOX, userId: AGENT, permission: "send_on_behalf" },
	]);
}

/** Creates a conversation with one inbound message, and returns its id. */
async function seedConversation(options: {
	id: string;
	mailboxId?: string;
	ownerUserId?: string;
	subject: string;
	lastMessageAt: Date;
	snippet?: string;
	read?: boolean;
}): Promise<string> {
	const db = createDb();
	const mailboxId = options.mailboxId ?? SHARED_MAILBOX;
	await db.insert(conversations).values({
		id: options.id,
		organizationId: DEFAULT_ORGANIZATION_ID,
		mailboxId,
		subject: options.subject,
		subjectNormalized: options.subject.toLowerCase(),
		lastMessageAt: options.lastMessageAt,
		messageCount: 1,
		createdAt: options.lastMessageAt,
	});
	await db.insert(messages).values({
		id: `msg_${options.id}`,
		organizationId: DEFAULT_ORGANIZATION_ID,
		userId: options.ownerUserId ?? OWNER,
		mailboxId,
		conversationId: options.id,
		direction: "inbound",
		fromAddr: "customer@example.org",
		toAddr: `support@${HOSTNAME}`,
		subject: options.subject,
		snippet: options.snippet ?? "Hello there",
		read: options.read ?? false,
		createdAt: options.lastMessageAt,
	});
	return options.id;
}

async function signIn(userId: string): Promise<void> {
	const token = await createSession({ DB: createDb() } as unknown as CloudflareEnv, userId);
	cookieJar.clear();
	cookieJar.set(SESSION_COOKIE, token);
}

function get(url: string): Request {
	return new Request(`http://localhost${url}`);
}

function post(url: string, body: unknown, method = "POST"): Request {
	return new Request(`http://localhost${url}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Next always passes a route context, even for routes with no dynamic segment. */
function listCtx() {
	return { params: Promise.resolve({}) };
}

function routeParams(id: string) {
	return { params: Promise.resolve({ id }) };
}

describe.skipIf(!hasTestDatabase())("conversation API (T2.2)", () => {
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

	it("lists only conversations in mailboxes the caller can read", async () => {
		await seedConversation({
			id: "cnv_shared",
			subject: "Shared thread",
			lastMessageAt: new Date("2026-01-02T10:00:00Z"),
		});
		await seedConversation({
			id: "cnv_outsider",
			mailboxId: OUTSIDER_MAILBOX,
			ownerUserId: OUTSIDER,
			subject: "Private thread",
			lastMessageAt: new Date("2026-01-03T10:00:00Z"),
		});

		const { GET } = await import("@/app/api/conversations/route");

		await signIn(READER);
		const readerResponse = await GET(get("/api/conversations"), listCtx());
		expect(readerResponse.status).toBe(200);
		const readerBody = (await readerResponse.json()) as {
			conversations: Array<{ id: string; messageCount: number; lastMessage: unknown }>;
		};
		expect(readerBody.conversations.map((row) => row.id)).toEqual(["cnv_shared"]);
		expect(readerBody.conversations[0].messageCount).toBe(1);
		expect(readerBody.conversations[0].lastMessage).toMatchObject({
			from: "customer@example.org",
			snippet: "Hello there",
			read: false,
		});

		await signIn(OUTSIDER);
		const outsiderResponse = await GET(get("/api/conversations"), listCtx());
		const outsiderBody = (await outsiderResponse.json()) as { conversations: Array<{ id: string }> };
		expect(outsiderBody.conversations.map((row) => row.id)).toEqual(["cnv_outsider"]);
	});

	it("filters by status, assignee and subject, and 404s an inaccessible mailboxId", async () => {
		await seedConversation({
			id: "cnv_open",
			subject: "Refund please",
			lastMessageAt: new Date("2026-01-02T10:00:00Z"),
		});
		await seedConversation({
			id: "cnv_closed",
			subject: "Invoice question",
			lastMessageAt: new Date("2026-01-01T10:00:00Z"),
		});
		const db = createDb();
		await db
			.update(conversations)
			.set({ status: "closed", assignedUserId: AGENT })
			.where(eq(conversations.id, "cnv_closed"));

		const { GET } = await import("@/app/api/conversations/route");
		await signIn(AGENT);

		const byStatus = await GET(get("/api/conversations?status=closed"), listCtx());
		expect(((await byStatus.json()) as { conversations: Array<{ id: string }> }).conversations
			.map((row) => row.id)).toEqual(["cnv_closed"]);

		const byAssignee = await GET(get(`/api/conversations?assignedUserId=${AGENT}`), listCtx());
		const assigneeBody = (await byAssignee.json()) as {
			conversations: Array<{ id: string; assignee: { id: string; name: string } | null }>;
		};
		expect(assigneeBody.conversations.map((row) => row.id)).toEqual(["cnv_closed"]);
		expect(assigneeBody.conversations[0].assignee).toEqual({ id: AGENT, name: "Agent" });

		const unassigned = await GET(get("/api/conversations?assignedUserId=none"), listCtx());
		expect(((await unassigned.json()) as { conversations: Array<{ id: string }> }).conversations
			.map((row) => row.id)).toEqual(["cnv_open"]);

		const byQuery = await GET(get("/api/conversations?q=refund"), listCtx());
		expect(((await byQuery.json()) as { conversations: Array<{ id: string }> }).conversations
			.map((row) => row.id)).toEqual(["cnv_open"]);

		const scoped = await GET(get(`/api/conversations?mailboxId=${SHARED_MAILBOX}`), listCtx());
		expect(scoped.status).toBe(200);

		const denied = await GET(get(`/api/conversations?mailboxId=${OUTSIDER_MAILBOX}`), listCtx());
		expect(denied.status).toBe(404);
	});

	it("pages with a cursor, newest activity first, without repeats", async () => {
		for (const [index, day] of [3, 2, 1].entries()) {
			await seedConversation({
				id: `cnv_page_${index}`,
				subject: `Thread ${index}`,
				lastMessageAt: new Date(`2026-01-0${day}T10:00:00Z`),
			});
		}

		const { GET } = await import("@/app/api/conversations/route");
		await signIn(OWNER);

		const first = await GET(get("/api/conversations?limit=2"), listCtx());
		const firstBody = (await first.json()) as {
			conversations: Array<{ id: string }>;
			nextCursor: string | null;
		};
		expect(firstBody.conversations.map((row) => row.id)).toEqual(["cnv_page_0", "cnv_page_1"]);
		expect(firstBody.nextCursor).toBeTruthy();

		const second = await GET(
			get(`/api/conversations?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`),
			listCtx(),
		);
		const secondBody = (await second.json()) as {
			conversations: Array<{ id: string }>;
			nextCursor: string | null;
		};
		expect(secondBody.conversations.map((row) => row.id)).toEqual(["cnv_page_2"]);
		expect(secondBody.nextCursor).toBeNull();
	});

	it("returns a conversation with its messages in order plus its notes", async () => {
		await seedConversation({
			id: "cnv_detail",
			subject: "Order status",
			lastMessageAt: new Date("2026-01-02T10:00:00Z"),
		});
		const db = createDb();
		await db.insert(messages).values({
			id: "msg_reply",
			organizationId: DEFAULT_ORGANIZATION_ID,
			userId: OWNER,
			mailboxId: SHARED_MAILBOX,
			conversationId: "cnv_detail",
			direction: "outbound",
			fromAddr: `support@${HOSTNAME}`,
			toAddr: "customer@example.org",
			subject: "Re: Order status",
			snippet: "On its way",
			read: true,
			createdAt: new Date("2026-01-02T11:00:00Z"),
		});
		await db.insert(conversationNotes).values({
			id: "cnote_seed",
			conversationId: "cnv_detail",
			userId: AGENT,
			body: "Customer called too",
		});

		const { GET } = await import("@/app/api/conversations/[id]/route");
		await signIn(READER);
		const response = await GET(get("/api/conversations/cnv_detail"), routeParams("cnv_detail"));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			conversation: {
				id: string;
				messageCount: number;
				messages: Array<{ id: string; direction: string }>;
				notes: Array<{ body: string; author: { id: string } | null }>;
			};
		};
		expect(body.conversation.id).toBe("cnv_detail");
		expect(body.conversation.messageCount).toBe(2);
		expect(body.conversation.messages.map((message) => message.id)).toEqual([
			"msg_cnv_detail",
			"msg_reply",
		]);
		expect(body.conversation.messages.map((message) => message.direction)).toEqual([
			"inbound",
			"outbound",
		]);
		expect(body.conversation.notes[0]).toMatchObject({
			body: "Customer called too",
			author: { id: AGENT, name: "Agent" },
		});
	});

	it("assigns and unassigns a conversation", async () => {
		await seedConversation({
			id: "cnv_assign",
			subject: "Assign me",
			lastMessageAt: new Date("2026-01-02T10:00:00Z"),
		});
		const { POST } = await import("@/app/api/conversations/[id]/assign/route");
		const db = createDb();
		await signIn(AGENT);

		const assigned = await POST(
			post("/api/conversations/cnv_assign/assign", { userId: READER }),
			routeParams("cnv_assign"),
		);
		expect(assigned.status).toBe(200);
		const [afterAssign] = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, "cnv_assign"));
		expect(afterAssign.assignedUserId).toBe(READER);

		const unassigned = await POST(
			post("/api/conversations/cnv_assign/assign", { userId: null }),
			routeParams("cnv_assign"),
		);
		expect(unassigned.status).toBe(200);
		const [afterUnassign] = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, "cnv_assign"));
		expect(afterUnassign.assignedUserId).toBeNull();

		// Someone without access to the mailbox cannot be made the assignee.
		const rejected = await POST(
			post("/api/conversations/cnv_assign/assign", { userId: OUTSIDER }),
			routeParams("cnv_assign"),
		);
		expect(rejected.status).toBe(400);
	});

	it("creates and lists notes", async () => {
		await seedConversation({
			id: "cnv_notes",
			subject: "Needs a note",
			lastMessageAt: new Date("2026-01-02T10:00:00Z"),
		});
		const { GET, POST } = await import("@/app/api/conversations/[id]/notes/route");
		await signIn(AGENT);

		const created = await POST(
			post("/api/conversations/cnv_notes/notes", { body: "  Called the customer  " }),
			routeParams("cnv_notes"),
		);
		expect(created.status).toBe(201);
		const createdBody = (await created.json()) as { note: { id: string; body: string } };
		expect(createdBody.note.body).toBe("Called the customer");

		const listed = await GET(get("/api/conversations/cnv_notes/notes"), routeParams("cnv_notes"));
		expect(listed.status).toBe(200);
		const listedBody = (await listed.json()) as {
			notes: Array<{ id: string; body: string; author: { id: string; name: string } | null }>;
		};
		expect(listedBody.notes).toHaveLength(1);
		expect(listedBody.notes[0]).toMatchObject({
			id: createdBody.note.id,
			body: "Called the customer",
			author: { id: AGENT, name: "Agent" },
		});

		// An empty note is rejected.
		const empty = await POST(
			post("/api/conversations/cnv_notes/notes", { body: "   " }),
			routeParams("cnv_notes"),
		);
		expect(empty.status).toBe(400);
	});

	it("patches status and snoozedUntil", async () => {
		await seedConversation({
			id: "cnv_status",
			subject: "Close me",
			lastMessageAt: new Date("2026-01-02T10:00:00Z"),
		});
		const { PATCH } = await import("@/app/api/conversations/[id]/route");
		const db = createDb();
		await signIn(AGENT);

		const closed = await PATCH(
			post("/api/conversations/cnv_status", { status: "closed" }, "PATCH"),
			routeParams("cnv_status"),
		);
		expect(closed.status).toBe(200);
		const [afterClose] = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, "cnv_status"));
		expect(afterClose.status).toBe("closed");

		const wakeAt = new Date("2026-02-01T09:00:00.000Z");
		const snoozed = await PATCH(
			post("/api/conversations/cnv_status", { snoozedUntil: wakeAt.toISOString() }, "PATCH"),
			routeParams("cnv_status"),
		);
		expect(snoozed.status).toBe(200);
		const [afterSnooze] = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, "cnv_status"));
		expect(afterSnooze.status).toBe("snoozed");
		expect(afterSnooze.snoozedUntil?.toISOString()).toBe(wakeAt.toISOString());

		// Reopening clears the wake-up time.
		await PATCH(
			post("/api/conversations/cnv_status", { status: "open" }, "PATCH"),
			routeParams("cnv_status"),
		);
		const [afterOpen] = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, "cnv_status"));
		expect(afterOpen.status).toBe("open");
		expect(afterOpen.snoozedUntil).toBeNull();

		// An empty patch is rejected.
		const empty = await PATCH(
			post("/api/conversations/cnv_status", {}, "PATCH"),
			routeParams("cnv_status"),
		);
		expect(empty.status).toBe(400);
	});

	it("hides conversations from users with no access and blocks writes from read-only users", async () => {
		await seedConversation({
			id: "cnv_guarded",
			subject: "Guarded",
			lastMessageAt: new Date("2026-01-02T10:00:00Z"),
		});
		const detail = await import("@/app/api/conversations/[id]/route");
		const assign = await import("@/app/api/conversations/[id]/assign/route");
		const notes = await import("@/app/api/conversations/[id]/notes/route");

		// No access at all: the conversation does not exist as far as they know.
		await signIn(OUTSIDER);
		const hidden = await detail.GET(
			get("/api/conversations/cnv_guarded"),
			routeParams("cnv_guarded"),
		);
		expect(hidden.status).toBe(404);
		const hiddenAssign = await assign.POST(
			post("/api/conversations/cnv_guarded/assign", { userId: OUTSIDER }),
			routeParams("cnv_guarded"),
		);
		expect(hiddenAssign.status).toBe(404);

		// read_only: can read, cannot assign, patch or add notes.
		await signIn(READER);
		const readable = await detail.GET(
			get("/api/conversations/cnv_guarded"),
			routeParams("cnv_guarded"),
		);
		expect(readable.status).toBe(200);
		const readerAssign = await assign.POST(
			post("/api/conversations/cnv_guarded/assign", { userId: READER }),
			routeParams("cnv_guarded"),
		);
		expect(readerAssign.status).toBe(403);
		const readerPatch = await detail.PATCH(
			post("/api/conversations/cnv_guarded", { status: "closed" }, "PATCH"),
			routeParams("cnv_guarded"),
		);
		expect(readerPatch.status).toBe(403);
		const readerNote = await notes.POST(
			post("/api/conversations/cnv_guarded/notes", { body: "nope" }),
			routeParams("cnv_guarded"),
		);
		expect(readerNote.status).toBe(403);

		// Signed out.
		cookieJar.clear();
		const anonymous = await detail.GET(
			get("/api/conversations/cnv_guarded"),
			routeParams("cnv_guarded"),
		);
		expect(anonymous.status).toBe(401);
	});
});
