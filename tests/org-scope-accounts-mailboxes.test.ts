/**
 * T3.2 — `/api/accounts/**` and `/api/mailboxes/**` under `withOrg()`.
 *
 * Two organisations, each with an admin, a managed account, a personal mailbox and a
 * shared mailbox. Every assertion is that a caller in org A can neither read nor
 * change anything of org B, and that a `mailbox_access` row (a table with no
 * `organization_id`) cannot hand access across organisations.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { domains, mailboxAccess, mailboxes, organizations, users } from "@/db/schema";
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

const ORG_A = "org_a";
const ORG_B = "org_b";

const ADMIN_A = "usr_admin_a";
const ADMIN_B = "usr_admin_b";
const MEMBER_A = "usr_member_a";
const MEMBER_B = "usr_member_b";

const MAILBOX_A = "mbx_a";
const MAILBOX_B = "mbx_b";
const SHARED_A = "mbx_shared_a";
const SHARED_B = "mbx_shared_b";

async function seed(): Promise<void> {
	const db = createDb();

	await db.insert(organizations).values([
		{ id: ORG_A, name: "Org A", slug: "org-a", status: "active" },
		{ id: ORG_B, name: "Org B", slug: "org-b", status: "active" },
	]);

	await db.insert(users).values([
		{ id: ADMIN_A, organizationId: ORG_A, email: "a@org-a.test", passwordHash: "x", name: "A", role: "admin" },
		{ id: ADMIN_B, organizationId: ORG_B, email: "b@org-b.test", passwordHash: "x", name: "B", role: "admin" },
		{
			id: MEMBER_A,
			organizationId: ORG_A,
			email: "member@org-a.test",
			passwordHash: "x",
			name: "Member A",
			role: "user",
			createdByUserId: ADMIN_A,
		},
		{
			id: MEMBER_B,
			organizationId: ORG_B,
			email: "member@org-b.test",
			passwordHash: "x",
			name: "Member B",
			role: "user",
			createdByUserId: ADMIN_B,
		},
	]);

	await db.insert(domains).values([
		{ id: "dom_a", organizationId: ORG_A, userId: ADMIN_A, hostname: "org-a.test", zoneId: "z_a" },
		{ id: "dom_b", organizationId: ORG_B, userId: ADMIN_B, hostname: "org-b.test", zoneId: "z_b" },
	]);

	// Each admin already owns a personal mailbox, so the list route never tries to
	// provision one (that would call Cloudflare).
	await db.insert(mailboxes).values([
		{ id: MAILBOX_A, organizationId: ORG_A, userId: ADMIN_A, domainId: "dom_a", localPart: "a", type: "personal" },
		{ id: MAILBOX_B, organizationId: ORG_B, userId: ADMIN_B, domainId: "dom_b", localPart: "b", type: "personal" },
		{ id: SHARED_A, organizationId: ORG_A, userId: ADMIN_A, domainId: "dom_a", localPart: "team", type: "shared" },
		{ id: SHARED_B, organizationId: ORG_B, userId: ADMIN_B, domainId: "dom_b", localPart: "team", type: "shared" },
	]);

	// A grant that crosses organisations. `mailbox_access` has no organization_id, so
	// nothing but the route scoping stops it: org B's admin must still see nothing.
	await db.insert(mailboxAccess).values({
		id: "mac_cross_org",
		mailboxId: SHARED_A,
		userId: ADMIN_B,
		permission: "full_access",
		createdByUserId: ADMIN_A,
	});
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
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

/** Next always passes a route context; dynamic routes get their params here. */
function routeCtx<P extends Record<string, string>>(params: P = {} as P) {
	return { params: Promise.resolve(params) };
}

describe.skipIf(!hasTestDatabase())("org scope: accounts + mailboxes (T3.2)", () => {
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

	it("lists only the caller's organisation accounts", async () => {
		const { GET } = await import("@/app/api/accounts/route");

		await signIn(ADMIN_A);
		const a = await GET(get("/api/accounts"), routeCtx());
		expect(a.status).toBe(200);
		const seenByA = (await a.json()) as { accounts: Array<{ id: string }> };
		expect(new Set(seenByA.accounts.map((row) => row.id))).toEqual(new Set([ADMIN_A, MEMBER_A]));

		await signIn(ADMIN_B);
		const b = await GET(get("/api/accounts"), routeCtx());
		const seenByB = (await b.json()) as { accounts: Array<{ id: string }> };
		expect(new Set(seenByB.accounts.map((row) => row.id))).toEqual(new Set([ADMIN_B, MEMBER_B]));
	});

	it("404s an account of another organisation, and still serves its own", async () => {
		const { GET } = await import("@/app/api/accounts/[id]/route");

		await signIn(ADMIN_A);
		expect((await GET(get(`/api/accounts/${MEMBER_B}`), routeCtx({ id: MEMBER_B }))).status).toBe(404);
		expect((await GET(get(`/api/accounts/${ADMIN_B}`), routeCtx({ id: ADMIN_B }))).status).toBe(404);
		expect((await GET(get(`/api/accounts/${MEMBER_A}`), routeCtx({ id: MEMBER_A }))).status).toBe(200);
	});

	it("refuses to patch an account of another organisation", async () => {
		const { PATCH } = await import("@/app/api/accounts/[id]/route");

		await signIn(ADMIN_A);
		const response = await PATCH(
			send(`/api/accounts/${MEMBER_B}`, "PATCH", {
				name: "Taken over",
				role: "admin",
				disabled: true,
				canManageMailboxes: true,
			}),
			routeCtx({ id: MEMBER_B }),
		);
		expect(response.status).toBe(404);

		const [row] = await createDb().select().from(users).where(eq(users.id, MEMBER_B));
		expect(row?.name).toBe("Member B");
		expect(row?.role).toBe("user");
		expect(row?.disabled).toBe(false);
	});

	it("404s the mailboxes of an account in another organisation", async () => {
		const { GET } = await import("@/app/api/accounts/[id]/mailboxes/route");

		await signIn(ADMIN_A);
		expect((await GET(get(`/api/accounts/${MEMBER_B}/mailboxes`), routeCtx({ id: MEMBER_B }))).status).toBe(404);
		expect((await GET(get(`/api/accounts/${MEMBER_A}/mailboxes`), routeCtx({ id: MEMBER_A }))).status).toBe(200);
	});

	it("only offers shared inboxes of the caller's organisation for delegation", async () => {
		const { GET, POST } = await import("@/app/api/accounts/[id]/mailbox-access/route");

		await signIn(ADMIN_A);
		const listed = await GET(
			get(`/api/accounts/${MEMBER_A}/mailbox-access`),
			routeCtx({ id: MEMBER_A }),
		);
		expect(listed.status).toBe(200);
		const body = (await listed.json()) as { mailboxes: Array<{ mailboxId: string }> };
		expect(body.mailboxes.map((row) => row.mailboxId)).toEqual([SHARED_A]);

		// Granting one of org B's shared inboxes is a 404, and writes nothing.
		const granted = await POST(
			send(`/api/accounts/${MEMBER_A}/mailbox-access`, "POST", {
				mailboxId: SHARED_B,
				permission: "full_access",
			}),
			routeCtx({ id: MEMBER_A }),
		);
		expect(granted.status).toBe(404);
		const rows = await createDb()
			.select()
			.from(mailboxAccess)
			.where(eq(mailboxAccess.userId, MEMBER_A));
		expect(rows).toEqual([]);
	});

	it("lists only the caller's organisation mailboxes", async () => {
		const { GET } = await import("@/app/api/mailboxes/route");

		await signIn(ADMIN_A);
		const a = await GET(get("/api/mailboxes"), routeCtx());
		expect(a.status).toBe(200);
		const seenByA = (await a.json()) as { mailboxes: Array<{ id: string }> };
		expect(new Set(seenByA.mailboxes.map((row) => row.id))).toEqual(new Set([MAILBOX_A, SHARED_A]));

		// Org B's admin holds a cross-org mailbox_access row on SHARED_A: it must not show up.
		await signIn(ADMIN_B);
		const b = await GET(get("/api/mailboxes"), routeCtx());
		const seenByB = (await b.json()) as { mailboxes: Array<{ id: string }> };
		expect(new Set(seenByB.mailboxes.map((row) => row.id))).toEqual(new Set([MAILBOX_B, SHARED_B]));
	});

	it("404s a mailbox of another organisation", async () => {
		const { GET } = await import("@/app/api/mailboxes/[id]/route");

		await signIn(ADMIN_A);
		expect((await GET(get(`/api/mailboxes/${MAILBOX_B}`), routeCtx({ id: MAILBOX_B }))).status).toBe(404);
		expect((await GET(get(`/api/mailboxes/${MAILBOX_A}`), routeCtx({ id: MAILBOX_A }))).status).toBe(200);
	});

	it("does not honour a mailbox_access grant that crosses organisations", async () => {
		const { GET } = await import("@/app/api/mailboxes/[id]/route");
		const access = await import("@/app/api/mailboxes/[id]/access/route");

		await signIn(ADMIN_B);
		expect((await GET(get(`/api/mailboxes/${SHARED_A}`), routeCtx({ id: SHARED_A }))).status).toBe(404);
		expect(
			(await access.GET(get(`/api/mailboxes/${SHARED_A}/access`), routeCtx({ id: SHARED_A }))).status,
		).toBe(404);
	});

	it("refuses to patch or delete a mailbox of another organisation", async () => {
		const { DELETE, PATCH } = await import("@/app/api/mailboxes/[id]/route");
		const db = createDb();

		await signIn(ADMIN_A);
		const patched = await PATCH(
			send(`/api/mailboxes/${MAILBOX_B}`, "PATCH", { displayName: "Taken over" }),
			routeCtx({ id: MAILBOX_B }),
		);
		expect(patched.status).toBe(404);

		const deleted = await DELETE(
			send(`/api/mailboxes/${MAILBOX_B}`, "DELETE"),
			routeCtx({ id: MAILBOX_B }),
		);
		expect(deleted.status).toBe(404);

		const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, MAILBOX_B));
		expect(row?.displayName ?? null).toBe(null);
		expect(row?.organizationId).toBe(ORG_B);
	});

	it("404s the avatar of a mailbox in another organisation", async () => {
		const { GET } = await import("@/app/api/mailboxes/[id]/avatar/route");

		await signIn(ADMIN_A);
		const response = await GET(
			get(`/api/mailboxes/${MAILBOX_B}/avatar`),
			routeCtx({ id: MAILBOX_B }),
		);
		expect(response.status).toBe(404);
	});

	it("keeps mailbox access members inside the organisation", async () => {
		const { GET, POST } = await import("@/app/api/mailboxes/[id]/access/route");
		const db = createDb();

		await signIn(ADMIN_A);
		const listed = await GET(get(`/api/mailboxes/${SHARED_A}/access`), routeCtx({ id: SHARED_A }));
		expect(listed.status).toBe(200);
		const body = (await listed.json()) as {
			members: Array<{ userId: string }>;
			availableUsers: Array<{ id: string }>;
		};
		// The cross-org grant to org B's admin is filtered out by the scoped join.
		expect(body.members.map((row) => row.userId)).toEqual([]);
		expect(body.availableUsers.map((row) => row.id)).toEqual([MEMBER_A]);

		// Granting access to a user of org B is a 404 and writes nothing.
		const granted = await POST(
			send(`/api/mailboxes/${SHARED_A}/access`, "POST", {
				userId: MEMBER_B,
				permission: "full_access",
			}),
			routeCtx({ id: SHARED_A }),
		);
		expect(granted.status).toBe(404);
		const rows = await db
			.select()
			.from(mailboxAccess)
			.where(and(eq(mailboxAccess.mailboxId, SHARED_A), eq(mailboxAccess.userId, MEMBER_B)));
		expect(rows).toEqual([]);
	});
});
