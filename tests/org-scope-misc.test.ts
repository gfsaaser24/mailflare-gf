/**
 * T3.2 — org scoping for the api-keys / webhooks / calendar / templates /
 * settings / profile / branding / backups / admin / export route folders.
 *
 * Every assertion is about a caller in org A never seeing or touching org B.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiKeys,
	calendarEvents,
	domains,
	emailTemplates,
	mailboxes,
	organizations,
	users,
	webhookDeliveries,
	webhooks,
} from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { getEnv } from "@/lib/cloudflare";
import { dispatchWebhooks } from "@/lib/email/webhooks";
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

const ORG_A = "org_misc_a";
const ORG_B = "org_misc_b";
const USER_A = "usr_misc_a";
const USER_B = "usr_misc_b";
const MAILBOX_A = "mbx_misc_a";
const MAILBOX_B = "mbx_misc_b";

const KEY_A = "key_misc_a";
const KEY_B = "key_misc_b";
const HOOK_A = "wh_misc_a";
const HOOK_B = "wh_misc_b";
const EVENT_A = "evt_misc_a";
const EVENT_B = "evt_misc_b";
const TEMPLATE_A = "tpl_misc_a";
const TEMPLATE_B = "tpl_misc_b";

const HOOK_A_URL = "https://org-a.test/hook";
const HOOK_B_URL = "https://org-b.test/hook";

async function seed(): Promise<void> {
	const db = createDb();

	await db.insert(organizations).values([
		{ id: ORG_A, name: "Org A", slug: "misc-org-a", status: "active" },
		{ id: ORG_B, name: "Org B", slug: "misc-org-b", status: "active" },
	]);

	await db.insert(users).values([
		{
			id: USER_A,
			organizationId: ORG_A,
			email: "a@misc-a.test",
			passwordHash: "x",
			name: "A",
			role: "admin",
		},
		{
			id: USER_B,
			organizationId: ORG_B,
			email: "b@misc-b.test",
			passwordHash: "x",
			name: "B",
			role: "admin",
		},
	]);

	await db.insert(domains).values([
		{ id: "dom_misc_a", organizationId: ORG_A, userId: USER_A, hostname: "misc-a.test", zoneId: "z_a" },
		{ id: "dom_misc_b", organizationId: ORG_B, userId: USER_B, hostname: "misc-b.test", zoneId: "z_b" },
	]);

	await db.insert(mailboxes).values([
		{
			id: MAILBOX_A,
			organizationId: ORG_A,
			userId: USER_A,
			domainId: "dom_misc_a",
			localPart: "team",
		},
		{
			id: MAILBOX_B,
			organizationId: ORG_B,
			userId: USER_B,
			domainId: "dom_misc_b",
			localPart: "team",
		},
	]);

	await db.insert(apiKeys).values([
		{
			id: KEY_A,
			organizationId: ORG_A,
			userId: USER_A,
			name: "Org A key",
			prefix: "ep_a",
			keyHash: "hash_a",
			scopes: '["read"]',
		},
		{
			id: KEY_B,
			organizationId: ORG_B,
			userId: USER_B,
			name: "Org B key",
			prefix: "ep_b",
			keyHash: "hash_b",
			scopes: '["read"]',
		},
	]);

	await db.insert(webhooks).values([
		{
			id: HOOK_A,
			organizationId: ORG_A,
			userId: USER_A,
			url: HOOK_A_URL,
			secret: "s_a",
			events: '["message.inbound"]',
			enabled: true,
		},
		{
			id: HOOK_B,
			organizationId: ORG_B,
			userId: USER_B,
			url: HOOK_B_URL,
			secret: "s_b",
			events: '["message.inbound"]',
			enabled: true,
		},
	]);

	const startsAt = new Date("2026-01-01T10:00:00.000Z");
	const endsAt = new Date("2026-01-01T11:00:00.000Z");
	await db.insert(calendarEvents).values([
		{
			id: EVENT_A,
			organizationId: ORG_A,
			userId: USER_A,
			mailboxId: MAILBOX_A,
			title: "Org A standup",
			startsAt,
			endsAt,
		},
		{
			id: EVENT_B,
			organizationId: ORG_B,
			userId: USER_B,
			mailboxId: MAILBOX_B,
			title: "Org B standup",
			startsAt,
			endsAt,
		},
	]);

	await db.insert(emailTemplates).values([
		{ id: TEMPLATE_A, organizationId: ORG_A, userId: USER_A, name: "Org A template" },
		{ id: TEMPLATE_B, organizationId: ORG_B, userId: USER_B, name: "Org B template" },
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

function json(url: string, method: string, body: unknown): Request {
	return new Request(`http://localhost${url}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Next always passes a route context, even for routes with no dynamic segment. */
function routeCtx() {
	return { params: Promise.resolve({}) };
}

function eventCtx(eventId: string) {
	return { params: Promise.resolve({ eventId }) };
}

/**
 * Email templates have no route folder yet (`email_templates` is only reached
 * through the schema). This stand-in proves the table is scoped the same way a
 * converted route would scope it.
 */
const listTemplates = withOrg(async ({ db, scoped }) => {
	const rows = await db.select().from(emailTemplates).where(scoped(emailTemplates));
	return NextResponse.json({ templates: rows.map((row) => row.id) });
});

describe.skipIf(!hasTestDatabase())("org scope: api-keys/webhooks/calendar/templates (T3.2)", () => {
	beforeAll(() => {
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		if (!!process.env.EDGE_WORKER_URL !== !!process.env.EDGE_WORKER_SECRET) {
			delete process.env.EDGE_WORKER_URL;
			delete process.env.EDGE_WORKER_SECRET;
		}
	});

	beforeEach(async () => {
		cookieJar.clear();
		vi.unstubAllGlobals();
		await seed();
	});

	// ---------------------------------------------------------------- api keys

	it("lists only the caller's organisation api keys", async () => {
		const { GET } = await import("@/app/api/api-keys/route");

		await signIn(USER_A);
		const a = await GET(get("/api/api-keys"), routeCtx());
		expect(a.status).toBe(200);
		expect(((await a.json()) as { apiKeys: Array<{ id: string }> }).apiKeys.map((k) => k.id)).toEqual(
			[KEY_A],
		);

		await signIn(USER_B);
		const b = await GET(get("/api/api-keys"), routeCtx());
		expect(((await b.json()) as { apiKeys: Array<{ id: string }> }).apiKeys.map((k) => k.id)).toEqual(
			[KEY_B],
		);
	});

	it("never exposes another organisation's api key row", async () => {
		const { GET } = await import("@/app/api/api-keys/route");

		await signIn(USER_A);
		const response = await GET(get("/api/api-keys"), routeCtx());
		const body = (await response.json()) as { apiKeys: Array<{ id: string; name: string }> };
		expect(body.apiKeys.some((k) => k.id === KEY_B)).toBe(false);
		expect(body.apiKeys.some((k) => k.name === "Org B key")).toBe(false);
	});

	/**
	 * There is no revoke/delete endpoint for api keys or webhooks yet, so the
	 * only way org A could reach an org B key is through this module. Guard the
	 * assumption: if a mutating handler is added it must be org-scoped too.
	 */
	it("exposes no unscoped api-key or webhook mutation handlers", async () => {
		const keys = await import("@/app/api/api-keys/route");
		const hooks = await import("@/app/api/webhooks/route");
		expect(Object.keys(keys).sort()).toEqual(["GET", "POST"]);
		expect(Object.keys(hooks).sort()).toEqual(["GET", "POST"]);
	});

	it("stamps the organisation on created api keys", async () => {
		const { POST } = await import("@/app/api/api-keys/route");

		await signIn(USER_A);
		const response = await POST(
			json("/api/api-keys", "POST", { name: "New", scopes: ["read"] }),
			routeCtx(),
		);
		expect(response.status).toBe(200);
		const created = (await response.json()) as { id: string };

		const [row] = await createDb().select().from(apiKeys).where(eq(apiKeys.id, created.id));
		expect(row?.organizationId).toBe(ORG_A);
	});

	// ---------------------------------------------------------------- webhooks

	it("lists only the caller's organisation webhooks", async () => {
		const { GET } = await import("@/app/api/webhooks/route");

		await signIn(USER_A);
		const a = await GET(get("/api/webhooks"), routeCtx());
		expect(a.status).toBe(200);
		expect(
			((await a.json()) as { webhooks: Array<{ id: string }> }).webhooks.map((w) => w.id),
		).toEqual([HOOK_A]);

		await signIn(USER_B);
		const b = await GET(get("/api/webhooks"), routeCtx());
		expect(
			((await b.json()) as { webhooks: Array<{ id: string }> }).webhooks.map((w) => w.id),
		).toEqual([HOOK_B]);
	});

	it("stamps the organisation on created webhooks", async () => {
		const { POST } = await import("@/app/api/webhooks/route");

		await signIn(USER_A);
		const response = await POST(
			json("/api/webhooks", "POST", {
				url: "https://misc-a.test/new",
				events: ["message.inbound"],
			}),
			routeCtx(),
		);
		expect(response.status).toBe(200);
		const created = (await response.json()) as { id: string };

		const [row] = await createDb().select().from(webhooks).where(eq(webhooks.id, created.id));
		expect(row?.organizationId).toBe(ORG_A);
	});

	// ---------------------------------------------------------------- calendar

	it("reads only the caller's organisation calendar events", async () => {
		const { GET } = await import("@/app/api/calendar/events/route");
		const range = "?start=2026-01-01T00:00:00.000Z&end=2026-01-02T00:00:00.000Z";

		await signIn(USER_A);
		const a = await GET(get(`/api/calendar/events${range}`), routeCtx());
		expect(a.status).toBe(200);
		expect(((await a.json()) as { events: Array<{ id: string }> }).events.map((e) => e.id)).toEqual([
			EVENT_A,
		]);

		await signIn(USER_B);
		const b = await GET(get(`/api/calendar/events${range}`), routeCtx());
		expect(((await b.json()) as { events: Array<{ id: string }> }).events.map((e) => e.id)).toEqual([
			EVENT_B,
		]);
	});

	it("404s an update of another organisation's calendar event", async () => {
		const { PATCH } = await import("@/app/api/calendar/events/[eventId]/route");

		await signIn(USER_A);
		const response = await PATCH(
			json(`/api/calendar/events/${EVENT_B}`, "PATCH", {
				title: "Hijacked",
				startsAt: "2026-01-01T10:00:00.000Z",
				endsAt: "2026-01-01T11:00:00.000Z",
			}),
			eventCtx(EVENT_B),
		);
		expect(response.status).toBe(404);

		const [row] = await createDb()
			.select()
			.from(calendarEvents)
			.where(eq(calendarEvents.id, EVENT_B));
		expect(row?.title).toBe("Org B standup");
	});

	it("leaves another organisation's calendar event alone on delete", async () => {
		const { DELETE } = await import("@/app/api/calendar/events/[eventId]/route");

		await signIn(USER_A);
		const response = await DELETE(get(`/api/calendar/events/${EVENT_B}`), eventCtx(EVENT_B));
		expect(response.status).toBe(200);

		const rows = await createDb()
			.select()
			.from(calendarEvents)
			.where(eq(calendarEvents.organizationId, ORG_B));
		expect(rows.map((row) => row.id)).toEqual([EVENT_B]);
	});

	it("refuses to attach a calendar event to another organisation's mailbox", async () => {
		const { POST } = await import("@/app/api/calendar/events/route");

		await signIn(USER_A);
		const response = await POST(
			json("/api/calendar/events", "POST", {
				title: "Sneaky",
				startsAt: "2026-02-01T10:00:00.000Z",
				endsAt: "2026-02-01T11:00:00.000Z",
				mailboxId: MAILBOX_B,
			}),
			routeCtx(),
		);
		expect(response.status).toBe(404);

		const rows = await createDb()
			.select()
			.from(calendarEvents)
			.where(eq(calendarEvents.organizationId, ORG_B));
		expect(rows.map((row) => row.id)).toEqual([EVENT_B]);
	});

	// --------------------------------------------------------------- templates

	it("reads only the caller's organisation email templates", async () => {
		await signIn(USER_A);
		const a = await listTemplates(get("/api/templates"), routeCtx());
		expect(await a.json()).toEqual({ templates: [TEMPLATE_A] });

		await signIn(USER_B);
		const b = await listTemplates(get("/api/templates"), routeCtx());
		expect(await b.json()).toEqual({ templates: [TEMPLATE_B] });
	});

	// -------------------------------------------------------- webhook dispatch

	it("never dispatches an org B message to an org A webhook", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				calls.push(String(url));
				return new Response("ok", { status: 200 });
			}),
		);

		const env = getEnv();
		await dispatchWebhooks(
			env,
			USER_B,
			"message.inbound",
			{ messageId: "msg_org_b" },
			ORG_B,
		);

		expect(calls).toEqual([HOOK_B_URL]);
		expect(calls).not.toContain(HOOK_A_URL);

		const deliveries = await createDb().select().from(webhookDeliveries);
		expect(deliveries.map((d) => d.webhookId)).toEqual([HOOK_B]);
	});

	it("drops a dispatch whose organisation does not own the user's webhooks", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				calls.push(String(url));
				return new Response("ok", { status: 200 });
			}),
		);

		const env = getEnv();
		// Org A's user, but the message belongs to org B: nothing may fire.
		await dispatchWebhooks(env, USER_A, "message.inbound", { messageId: "msg_org_b" }, ORG_B);

		expect(calls).toEqual([]);
		expect(await createDb().select().from(webhookDeliveries)).toEqual([]);
	});

	it("falls back to the user's own organisation when none is passed", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				calls.push(String(url));
				return new Response("ok", { status: 200 });
			}),
		);

		const env = getEnv();
		await dispatchWebhooks(env, USER_B, "message.inbound", { messageId: "msg_org_b" });

		expect(calls).toEqual([HOOK_B_URL]);
	});

	// ---------------------------------------------------- settings and profile

	it("keeps a settings update inside the caller's organisation", async () => {
		const { PATCH } = await import("@/app/api/settings/profile/route");

		await signIn(USER_A);
		const response = await PATCH(
			json("/api/settings/profile", "PATCH", { name: "Renamed", resetEmail: "" }),
			routeCtx(),
		);
		expect(response.status).toBe(200);

		const rows = await createDb()
			.select({ id: users.id, name: users.name })
			.from(users)
			.where(and(eq(users.organizationId, ORG_B), eq(users.id, USER_B)));
		expect(rows[0]?.name).toBe("B");
	});

	it("returns the caller's own user from /api/auth/me", async () => {
		const { GET } = await import("@/app/api/auth/me/route");

		await signIn(USER_A);
		const response = await GET(get("/api/auth/me"), routeCtx());
		expect(response.status).toBe(200);
		const body = (await response.json()) as { user: { id: string; email: string } };
		expect(body.user.id).toBe(USER_A);
		expect(body.user.email).toBe("a@misc-a.test");
	});

	// ------------------------------------------------------------------ export

	it("404s an export of another organisation's mailbox", async () => {
		const { GET } = await import("@/app/api/export/messages/route");

		await signIn(USER_A);
		const response = await GET(get(`/api/export/messages?mailboxId=${MAILBOX_B}`), routeCtx());
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Mailbox not found" });
	});
});
