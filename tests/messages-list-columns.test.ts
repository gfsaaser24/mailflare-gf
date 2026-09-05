/**
 * `GET /api/messages` is the folder list. It must stay cheap: list columns only
 * (no `text_body`/`html_body`/`raw_r2_key`), the stored `snippet`, a correct
 * total, and full-text search through `messages_search_idx`.
 */
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { domains, mailboxes, messages, users } from "@/db/schema";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { DEFAULT_ORGANIZATION_ID } from "@/lib/organizations/constants";
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

const HOSTNAME = "messages-list.example";
const OWNER = "usr_list_owner";
const MAILBOX = "mbx_list";

type ListRow = {
	id: string;
	snippet: string | null;
	subject: string | null;
	createdAt: string;
	textBody?: unknown;
	htmlBody?: unknown;
	rawR2Key?: unknown;
};

type ListBody = { messages: ListRow[]; total: number; limit: number; offset: number };

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
	await db.insert(users).values({
		id: OWNER,
		email: `owner@${HOSTNAME}`,
		passwordHash: "x",
		name: "Owner",
		role: "admin",
	});
	await db.insert(domains).values({
		id: "dom_list",
		userId: OWNER,
		hostname: HOSTNAME,
		zoneId: "zone_list",
		status: "active",
	});
	await db.insert(mailboxes).values({
		id: MAILBOX,
		userId: OWNER,
		domainId: "dom_list",
		localPart: "team",
		displayName: "Team",
	});
	await db.insert(messages).values([
		{
			id: "msg_list_invoice",
			organizationId: DEFAULT_ORGANIZATION_ID,
			userId: OWNER,
			mailboxId: MAILBOX,
			direction: "inbound",
			status: "received",
			fromAddr: "billing@example.org",
			toAddr: `team@${HOSTNAME}`,
			subject: "Quarterly invoice attached",
			snippet: "Please find the invoice",
			textBody: "x".repeat(5_000),
			htmlBody: `<p>${"x".repeat(5_000)}</p>`,
			rawR2Key: "mail/inbound/msg_list_invoice",
			createdAt: new Date("2026-01-02T10:00:00Z"),
		},
		{
			id: "msg_list_standup",
			organizationId: DEFAULT_ORGANIZATION_ID,
			userId: OWNER,
			mailboxId: MAILBOX,
			direction: "inbound",
			status: "received",
			fromAddr: "team@example.org",
			toAddr: `team@${HOSTNAME}`,
			subject: "Standup notes",
			snippet: "Yesterday we shipped",
			textBody: "Nothing about billing here",
			createdAt: new Date("2026-01-01T10:00:00Z"),
		},
	]);
}

async function signIn(userId: string): Promise<void> {
	const token = await createSession({ DB: createDb() } as unknown as CloudflareEnv, userId);
	cookieJar.clear();
	cookieJar.set(SESSION_COOKIE, token);
}

function get(url: string): Request {
	return new Request(`http://localhost${url}`);
}

/** Next always passes a route context, even for routes with no dynamic segment. */
function listCtx() {
	return { params: Promise.resolve({}) };
}

describe.skipIf(!hasTestDatabase())("messages list columns", () => {
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

	it("returns the stored snippet and never the message bodies", async () => {
		const { GET } = await import("@/app/api/messages/route");
		await signIn(OWNER);

		const response = await GET(get(`/api/messages?mailboxId=${MAILBOX}&status=received`), listCtx());
		expect(response.status).toBe(200);
		const body = (await response.json()) as ListBody;

		expect(body.messages.map((row) => row.id)).toEqual(["msg_list_invoice", "msg_list_standup"]);
		expect(body.messages[0].snippet).toBe("Please find the invoice");
		for (const row of body.messages) {
			expect(row).not.toHaveProperty("textBody");
			expect(row).not.toHaveProperty("htmlBody");
			expect(row).not.toHaveProperty("rawR2Key");
		}
		// The count is unaffected by the narrower column list.
		expect(body.total).toBe(2);
	});

	it("finds a message by a word in its subject through full-text search", async () => {
		const { GET } = await import("@/app/api/messages/route");
		await signIn(OWNER);

		const response = await GET(
			get(`/api/messages?mailboxId=${MAILBOX}&status=received&q=invoice`),
			listCtx(),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as ListBody;
		expect(body.messages.map((row) => row.id)).toEqual(["msg_list_invoice"]);
		expect(body.total).toBe(1);
	});

	it("still falls back to LIKE for very short queries", async () => {
		const { GET } = await import("@/app/api/messages/route");
		await signIn(OWNER);

		const response = await GET(
			get(`/api/messages?mailboxId=${MAILBOX}&status=received&q=up`),
			listCtx(),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as ListBody;
		// "up" matches "Standup notes" as a substring, which tsquery would not.
		expect(body.messages.map((row) => row.id)).toEqual(["msg_list_standup"]);
	});
});
