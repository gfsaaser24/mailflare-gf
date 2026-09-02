/**
 * T3.3 — platform operators and `/api/platform/*`.
 *
 * The platform plane is the one place that reads across organisations, so the
 * assertions here are mostly about who is refused: an ordinary org admin must
 * get 403 from every route, and an impersonation session must be time-boxed and
 * audited.
 */
import { and, eq } from "drizzle-orm";
import type { NextResponse } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	auditLogs,
	domains,
	folders,
	mailboxes,
	messageAttachments,
	messages,
	organizations,
	platformOperators,
	sessions,
	users,
} from "@/db/schema";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { IMPERSONATION_TTL_MS } from "@/lib/platform/service";
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

const ORG_OPS = "org_ops";
const ORG_ACME = "org_acme";

const OPERATOR = "usr_operator";
/** Org admin of ORG_ACME. Not an operator: every platform route must refuse them. */
const ACME_ADMIN = "usr_acme_admin";
const ACME_USER = "usr_acme_user";
const ACME_EXTRA = "usr_acme_extra";

const ACME_DOMAIN = "dom_acme";
const ACME_MAILBOX_A = "mbx_acme_a";
const ACME_MAILBOX_B = "mbx_acme_b";

const DAY_MS = 24 * 60 * 60 * 1000;

async function seed(): Promise<void> {
	const db = createDb();

	await db.insert(organizations).values([
		{ id: ORG_OPS, name: "Ops", slug: "ops", status: "active" },
		{ id: ORG_ACME, name: "Acme", slug: "acme", status: "active" },
	]);

	await db.insert(users).values([
		{
			id: OPERATOR,
			organizationId: ORG_OPS,
			email: "operator@ops.test",
			passwordHash: "x",
			name: "Operator",
			role: "admin",
		},
		{
			id: ACME_ADMIN,
			organizationId: ORG_ACME,
			email: "admin@acme.test",
			passwordHash: "x",
			name: "Acme Admin",
			role: "admin",
			createdAt: new Date(Date.now() - 2 * DAY_MS),
		},
		{
			id: ACME_USER,
			organizationId: ORG_ACME,
			email: "user@acme.test",
			passwordHash: "x",
			name: "Acme User",
			role: "user",
		},
		{
			id: ACME_EXTRA,
			organizationId: ORG_ACME,
			email: "extra@acme.test",
			passwordHash: "x",
			name: "Acme Extra",
			role: "user",
		},
	]);

	await db.insert(platformOperators).values({ userId: OPERATOR });

	await db.insert(domains).values({
		id: ACME_DOMAIN,
		organizationId: ORG_ACME,
		userId: ACME_ADMIN,
		hostname: "acme.test",
		zoneId: "zone_acme",
	});

	await db.insert(mailboxes).values([
		{
			id: ACME_MAILBOX_A,
			organizationId: ORG_ACME,
			userId: ACME_ADMIN,
			domainId: ACME_DOMAIN,
			localPart: "support",
		},
		{
			id: ACME_MAILBOX_B,
			organizationId: ORG_ACME,
			userId: ACME_ADMIN,
			domainId: ACME_DOMAIN,
			localPart: "billing",
		},
	]);

	await db.insert(folders).values({
		id: "fld_acme",
		organizationId: ORG_ACME,
		userId: ACME_ADMIN,
		mailboxId: ACME_MAILBOX_A,
		name: "Receipts",
	});

	const yesterday = new Date(Date.now() - DAY_MS - 60_000);
	await db.insert(messages).values([
		{
			id: "msg_out_1",
			organizationId: ORG_ACME,
			userId: ACME_ADMIN,
			mailboxId: ACME_MAILBOX_A,
			direction: "outbound",
			fromAddr: "support@acme.test",
			toAddr: "someone@example.test",
		},
		{
			id: "msg_out_2",
			organizationId: ORG_ACME,
			userId: ACME_ADMIN,
			mailboxId: ACME_MAILBOX_A,
			direction: "outbound",
			fromAddr: "support@acme.test",
			toAddr: "other@example.test",
		},
		{
			// Yesterday: must not count towards "sends today".
			id: "msg_out_old",
			organizationId: ORG_ACME,
			userId: ACME_ADMIN,
			mailboxId: ACME_MAILBOX_A,
			direction: "outbound",
			fromAddr: "support@acme.test",
			toAddr: "old@example.test",
			createdAt: yesterday,
		},
		{
			// Inbound: never a "send".
			id: "msg_in_1",
			organizationId: ORG_ACME,
			userId: ACME_ADMIN,
			mailboxId: ACME_MAILBOX_A,
			direction: "inbound",
			fromAddr: "someone@example.test",
			toAddr: "support@acme.test",
		},
	]);

	await db.insert(messageAttachments).values([
		{
			id: "att_1",
			messageId: "msg_in_1",
			filename: "a.pdf",
			contentType: "application/pdf",
			size: 100,
			r2Key: "attachments/a.pdf",
		},
		{
			id: "att_2",
			messageId: "msg_out_1",
			filename: "b.pdf",
			contentType: "application/pdf",
			size: 250,
			r2Key: "attachments/b.pdf",
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

function send(url: string, method: string, body?: unknown): Request {
	return new Request(`http://localhost${url}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/**
 * Routes return `Response` in the guard-rejection branch, so the union loses
 * `NextResponse.cookies`. Narrow it where a test needs the cookie jar.
 */
function asNextResponse(response: Response): NextResponse {
	return response as NextResponse;
}

function params(id: string) {
	return { params: Promise.resolve({ id }) };
}

/** Every operator-guarded route, as `(request) => Response`. */
async function platformRoutes(): Promise<Array<{ name: string; call: () => Promise<Response> }>> {
	const orgs = await import("@/app/api/platform/orgs/route");
	const org = await import("@/app/api/platform/orgs/[id]/route");
	const impersonate = await import("@/app/api/platform/orgs/[id]/impersonate/route");
	const search = await import("@/app/api/platform/search/route");

	return [
		{ name: "GET /orgs", call: () => orgs.GET(get("/api/platform/orgs")) },
		{
			name: "POST /orgs",
			call: () =>
				orgs.POST(
					send("/api/platform/orgs", "POST", {
						name: "Nope",
						slug: "nope",
						adminEmail: "nope@nope.test",
						adminName: "Nope",
					}),
				),
		},
		{
			name: "GET /orgs/[id]",
			call: () => org.GET(get(`/api/platform/orgs/${ORG_ACME}`), params(ORG_ACME)),
		},
		{
			name: "PATCH /orgs/[id]",
			call: () =>
				org.PATCH(
					send(`/api/platform/orgs/${ORG_ACME}`, "PATCH", { status: "suspended" }),
					params(ORG_ACME),
				),
		},
		{
			name: "POST /orgs/[id]/impersonate",
			call: () =>
				impersonate.POST(
					send(`/api/platform/orgs/${ORG_ACME}/impersonate`, "POST"),
					params(ORG_ACME),
				),
		},
		{ name: "GET /search", call: () => search.GET(get("/api/platform/search?q=acme")) },
	];
}

describe.skipIf(!hasTestDatabase())("platform plane (T3.3)", () => {
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

	it("401s every platform route when unauthenticated", async () => {
		for (const route of await platformRoutes()) {
			const response = await route.call();
			expect(response.status, route.name).toBe(401);
		}
	});

	it("403s every platform route for an org admin who is not an operator", async () => {
		await signIn(ACME_ADMIN);
		for (const route of await platformRoutes()) {
			const response = await route.call();
			expect(response.status, route.name).toBe(403);
			expect(await response.json(), route.name).toEqual({ error: "Forbidden" });
		}

		// Nothing leaked through: the PATCH above must not have suspended Acme.
		const [org] = await createDb()
			.select()
			.from(organizations)
			.where(eq(organizations.id, ORG_ACME));
		expect(org?.status).toBe("active");
	});

	it("lists organisations with their counts", async () => {
		await signIn(OPERATOR);
		const { GET } = await import("@/app/api/platform/orgs/route");
		const response = await GET(get("/api/platform/orgs"));
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			organizations: Array<{ id: string; counts: Record<string, number> }>;
		};
		const acme = body.organizations.find((org) => org.id === ORG_ACME);
		expect(acme?.counts).toEqual({
			mailboxes: 2,
			accounts: 3,
			domains: 1,
			storageBytes: 350,
			sendsToday: 2,
		});

		const ops = body.organizations.find((org) => org.id === ORG_OPS);
		expect(ops?.counts).toEqual({
			mailboxes: 0,
			accounts: 1,
			domains: 0,
			storageBytes: 0,
			sendsToday: 0,
		});
	});

	it("finds mailboxes and domains across organisations", async () => {
		await signIn(OPERATOR);
		const { GET } = await import("@/app/api/platform/search/route");
		const response = await GET(get("/api/platform/search?q=acme"));
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			results: Array<{ organizationId: string; type: string; id: string; label: string }>;
		};
		expect(body.results).toContainEqual({
			organizationId: ORG_ACME,
			type: "mailbox",
			id: ACME_MAILBOX_A,
			label: "support@acme.test",
		});
		expect(body.results).toContainEqual({
			organizationId: ORG_ACME,
			type: "domain",
			id: ACME_DOMAIN,
			label: "acme.test",
		});
	});

	it("creates an organisation with its first admin, then suspends it", async () => {
		await signIn(OPERATOR);
		const orgs = await import("@/app/api/platform/orgs/route");

		const created = await orgs.POST(
			send("/api/platform/orgs", "POST", {
				name: "Globex",
				slug: "globex",
				quotaTemplate: "standard",
				adminEmail: "Boss@Globex.test",
				adminName: "Boss",
			}),
		);
		expect(created.status).toBe(200);
		const body = (await created.json()) as {
			organization: { id: string; slug: string };
			admin: { id: string; email: string };
			temporaryPassword: string;
			quotaTemplate: string | null;
		};
		expect(body.organization.slug).toBe("globex");
		expect(body.quotaTemplate).toBe("standard");
		// No reset/invite mechanism exists yet, so the password is returned once.
		expect(body.temporaryPassword.length).toBeGreaterThan(16);

		const db = createDb();
		const [admin] = await db.select().from(users).where(eq(users.id, body.admin.id));
		expect(admin?.organizationId).toBe(body.organization.id);
		expect(admin?.email).toBe("boss@globex.test");
		expect(admin?.role).toBe("admin");

		// A duplicate slug is a 409, not a second organisation.
		const duplicate = await orgs.POST(
			send("/api/platform/orgs", "POST", {
				name: "Globex Two",
				slug: "globex",
				adminEmail: "other@globex.test",
				adminName: "Other",
			}),
		);
		expect(duplicate.status).toBe(409);

		// Suspend it.
		const org = await import("@/app/api/platform/orgs/[id]/route");
		const suspended = await org.PATCH(
			send(`/api/platform/orgs/${body.organization.id}`, "PATCH", { status: "suspended" }),
			params(body.organization.id),
		);
		expect(suspended.status).toBe(200);
		expect(
			((await suspended.json()) as { organization: { status: string } }).organization.status,
		).toBe("suspended");

		// A tenant route now refuses that organisation's own admin.
		await signIn(body.admin.id);
		const folderRoute = await import("@/app/api/folders/route");
		const folderResponse = await folderRoute.GET(get("/api/folders"), {
			params: Promise.resolve({}),
		});
		expect(folderResponse.status).toBe(403);
		expect(await folderResponse.json()).toEqual({ error: "Organisation suspended" });

		// Restore, and the same call works again.
		await signIn(OPERATOR);
		const restored = await org.PATCH(
			send(`/api/platform/orgs/${body.organization.id}`, "PATCH", { status: "active" }),
			params(body.organization.id),
		);
		expect(restored.status).toBe(200);

		await signIn(body.admin.id);
		const afterRestore = await folderRoute.GET(get("/api/folders"), {
			params: Promise.resolve({}),
		});
		expect(afterRestore.status).toBe(200);
	});

	it("impersonates an organisation's first admin for one hour and audits it", async () => {
		await signIn(OPERATOR);
		const { POST } = await import("@/app/api/platform/orgs/[id]/impersonate/route");

		const before = Date.now();
		const response = await POST(
			send(`/api/platform/orgs/${ORG_ACME}/impersonate`, "POST"),
			params(ORG_ACME),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { targetUserId: string; organizationId: string };
		expect(body.targetUserId).toBe(ACME_ADMIN);
		expect(body.organizationId).toBe(ORG_ACME);

		// The cookie is set on the response, not read back from the jar.
		const cookie = asNextResponse(response).cookies.get(SESSION_COOKIE);
		expect(cookie?.value).toBeTruthy();
		expect(cookie?.httpOnly).toBe(true);
		expect(cookie?.maxAge).toBe(IMPERSONATION_TTL_MS / 1000);

		const db = createDb();
		const [session] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.impersonatedByUserId, OPERATOR));
		expect(session?.userId).toBe(ACME_ADMIN);
		expect(session?.impersonatedOrganizationId).toBe(ORG_ACME);

		// Expires in ~1h (allow a generous window for a slow round trip).
		const ttl = (session as { expiresAt: Date }).expiresAt.getTime() - before;
		expect(ttl).toBeGreaterThan(IMPERSONATION_TTL_MS - 60_000);
		expect(ttl).toBeLessThanOrEqual(IMPERSONATION_TTL_MS + 60_000);

		const [audit] = await db
			.select()
			.from(auditLogs)
			.where(and(eq(auditLogs.action, "platform.impersonate"), eq(auditLogs.actorUserId, OPERATOR)));
		expect(audit?.organizationId).toBe(ORG_ACME);
		expect(audit?.targetUserId).toBe(ACME_ADMIN);
		expect(JSON.parse(audit?.metadata ?? "{}")).toEqual({
			organizationId: ORG_ACME,
			targetUserId: ACME_ADMIN,
		});

		// The impersonation session may not re-enter the platform plane.
		cookieJar.clear();
		cookieJar.set(SESSION_COOKIE, cookie?.value ?? "");
		const orgs = await import("@/app/api/platform/orgs/route");
		expect((await orgs.GET(get("/api/platform/orgs"))).status).toBe(403);

		// Stopping it deletes the session and clears the cookie.
		const stop = await import("@/app/api/platform/impersonate/stop/route");
		const stopped = await stop.POST();
		expect(stopped.status).toBe(200);
		expect(stopped.cookies.get(SESSION_COOKIE)?.value).toBe("");

		const remaining = await db
			.select()
			.from(sessions)
			.where(eq(sessions.impersonatedByUserId, OPERATOR));
		expect(remaining).toHaveLength(0);
	});

	it("refuses to stop an impersonation that is not one", async () => {
		await signIn(ACME_ADMIN);
		const { POST } = await import("@/app/api/platform/impersonate/stop/route");
		const response = await POST();
		expect(response.status).toBe(400);
	});
});
