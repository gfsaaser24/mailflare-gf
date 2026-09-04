/**
 * `/api/mailboxes` admin organisation scope.
 *
 * The default listing is deliberately narrow — "inboxes I may open" — while the
 * uniqueness rule on create is org-wide, so a mailbox owned by somebody else can
 * block an address the admin cannot see anywhere. `?scope=organization` is the
 * admin-only window onto those rows; it must never widen the default scope.
 */
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { domains, mailboxes, organizations, users } from "@/db/schema";
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

const ORG_A = "org_scope_a";
const ORG_B = "org_scope_b";

const ADMIN_A = "usr_scope_admin_a";
const USER_B = "usr_scope_user_b";
const ADMIN_OTHER = "usr_scope_admin_other";

const ADMIN_A_EMAIL = "admin@org-a.test";
const USER_B_EMAIL = "ricky@org-a.test";

const MBX_ADMIN_A = "mbx_scope_admin_a";
const MBX_USER_B = "mbx_scope_user_b";
const MBX_OTHER_ORG = "mbx_scope_other_org";

type MailboxRow = {
	id: string;
	ownerUserId?: string;
	ownerEmail?: string;
	ownerName?: string;
	isOwn?: boolean;
	type?: string;
	hostname?: string;
	localPart?: string;
};

async function seed(): Promise<void> {
	const db = createDb();

	await db.insert(organizations).values([
		{ id: ORG_A, name: "Org A", slug: "scope-org-a", status: "active" },
		{ id: ORG_B, name: "Org B", slug: "scope-org-b", status: "active" },
	]);

	await db.insert(users).values([
		{
			id: ADMIN_A,
			organizationId: ORG_A,
			email: ADMIN_A_EMAIL,
			passwordHash: "x",
			name: "Admin A",
			role: "admin",
		},
		{
			id: USER_B,
			organizationId: ORG_A,
			email: USER_B_EMAIL,
			passwordHash: "x",
			name: "Ricky",
			role: "user",
			createdByUserId: ADMIN_A,
		},
		{
			id: ADMIN_OTHER,
			organizationId: ORG_B,
			email: "admin@org-b.test",
			passwordHash: "x",
			name: "Admin B",
			role: "admin",
		},
	]);

	await db.insert(domains).values([
		{ id: "dom_scope_a", organizationId: ORG_A, userId: ADMIN_A, hostname: "org-a.test", zoneId: "z_a" },
		{ id: "dom_scope_b", organizationId: ORG_B, userId: ADMIN_OTHER, hostname: "org-b.test", zoneId: "z_b" },
	]);

	// The admin already owns a personal mailbox so the default listing never tries
	// to provision one (that would call Cloudflare).
	await db.insert(mailboxes).values([
		{
			id: MBX_ADMIN_A,
			organizationId: ORG_A,
			userId: ADMIN_A,
			domainId: "dom_scope_a",
			localPart: "admin",
			type: "personal",
		},
		{
			id: MBX_USER_B,
			organizationId: ORG_A,
			userId: USER_B,
			domainId: "dom_scope_a",
			localPart: "ricky",
			type: "personal",
		},
		{
			id: MBX_OTHER_ORG,
			organizationId: ORG_B,
			userId: ADMIN_OTHER,
			domainId: "dom_scope_b",
			localPart: "ricky",
			type: "personal",
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
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

/** Next always passes a route context; this listing route has no params. */
function routeCtx() {
	return { params: Promise.resolve({}) };
}

describe.skipIf(!hasTestDatabase())("mailboxes: admin organisation scope", () => {
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

	it("hides another account's personal mailbox from the default scope", async () => {
		const { GET } = await import("@/app/api/mailboxes/route");

		await signIn(ADMIN_A);
		const response = await GET(get("/api/mailboxes"), routeCtx());
		expect(response.status).toBe(200);
		const body = (await response.json()) as { mailboxes: MailboxRow[]; canCreateShared: boolean };
		expect(body.mailboxes.map((row) => row.id)).toEqual([MBX_ADMIN_A]);
		expect(body.canCreateShared).toBe(true);

		// Same for the explicit default.
		const explicit = await GET(get("/api/mailboxes?scope=accessible"), routeCtx());
		const explicitBody = (await explicit.json()) as { mailboxes: MailboxRow[] };
		expect(explicitBody.mailboxes.map((row) => row.id)).toEqual([MBX_ADMIN_A]);
	});

	it("shows every mailbox of the organisation on ?scope=organization", async () => {
		const { GET } = await import("@/app/api/mailboxes/route");

		await signIn(ADMIN_A);
		const response = await GET(get("/api/mailboxes?scope=organization"), routeCtx());
		expect(response.status).toBe(200);
		const body = (await response.json()) as { mailboxes: MailboxRow[] };

		const byId = new Map(body.mailboxes.map((row) => [row.id, row]));
		expect(new Set(byId.keys())).toEqual(new Set([MBX_ADMIN_A, MBX_USER_B]));

		const theirs = byId.get(MBX_USER_B);
		expect(theirs?.ownerUserId).toBe(USER_B);
		expect(theirs?.ownerEmail).toBe(USER_B_EMAIL);
		expect(theirs?.ownerName).toBe("Ricky");
		expect(theirs?.isOwn).toBe(false);
		expect(theirs?.hostname).toBe("org-a.test");
		expect(theirs?.localPart).toBe("ricky");

		expect(byId.get(MBX_ADMIN_A)?.isOwn).toBe(true);
		expect(byId.get(MBX_ADMIN_A)?.ownerEmail).toBe(ADMIN_A_EMAIL);
	});

	it("never leaks a mailbox of another organisation", async () => {
		const { GET } = await import("@/app/api/mailboxes/route");

		await signIn(ADMIN_A);
		const response = await GET(get("/api/mailboxes?scope=organization"), routeCtx());
		const body = (await response.json()) as { mailboxes: MailboxRow[] };
		expect(body.mailboxes.some((row) => row.id === MBX_OTHER_ORG)).toBe(false);
	});

	it("refuses the organisation scope to a non-admin", async () => {
		const { GET } = await import("@/app/api/mailboxes/route");

		await signIn(USER_B);
		const response = await GET(get("/api/mailboxes?scope=organization"), routeCtx());
		expect(response.status).toBe(403);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("Forbidden");
	});

	it("names the owner in the 409 when an admin hits a mailbox they cannot see", async () => {
		const { POST } = await import("@/app/api/mailboxes/route");

		await signIn(ADMIN_A);
		const response = await POST(
			send("/api/mailboxes", "POST", {
				domainId: "dom_scope_a",
				localPart: "ricky",
				displayName: "Ricky",
				type: "personal",
			}),
			routeCtx(),
		);
		expect(response.status).toBe(409);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain(USER_B_EMAIL);

		// Nothing was created.
		const rows = await createDb().select().from(mailboxes).where(eq(mailboxes.localPart, "ricky"));
		expect(rows.map((row) => row.id).sort()).toEqual([MBX_OTHER_ORG, MBX_USER_B].sort());
	});
});
