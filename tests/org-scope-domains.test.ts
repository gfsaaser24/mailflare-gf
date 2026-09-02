/**
 * T3.2 — org scoping for `domains`, `routing-rules` and `contacts`.
 *
 * Two organisations, one user / domain / mailbox each. Every assertion is about
 * a caller in org A never seeing, changing or deleting an org B row — including
 * rows that are only reachable through another table (a routing rule through its
 * mailbox).
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	contacts,
	domains,
	mailboxAccess,
	mailboxes,
	organizations,
	routingRules,
	users,
} from "@/db/schema";
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

const USER_A = "usr_org_a";
const USER_B = "usr_org_b";

const DOMAIN_A = "dom_org_a";
const DOMAIN_B = "dom_org_b";

const MAILBOX_A = "mbx_org_a";
const MAILBOX_B = "mbx_org_b";
/**
 * An org B *shared* mailbox that org A's user holds a `mailbox_access` row for.
 * `mailbox_access` has no `organization_id`, so only the organisation filter
 * keeps this mailbox (and everything reached through it) out of org A's reach.
 */
const MAILBOX_B_SHARED = "mbx_org_b_shared";

const RULE_A = "rule_org_a";
const RULE_B = "rule_org_b";
/** An org B rule pointing at an org A mailbox: only `scoped()` keeps it hidden. */
const RULE_B_CROSS = "rule_org_b_cross";

const SHARED_EMAIL = "shared@example.test";
const CONTACT_B = "ct_org_b";

async function seed(): Promise<void> {
	const db = createDb();

	await db.insert(organizations).values([
		{ id: ORG_A, name: "Org A", slug: "org-a", status: "active" },
		{ id: ORG_B, name: "Org B", slug: "org-b", status: "active" },
	]);

	await db.insert(users).values([
		{ id: USER_A, organizationId: ORG_A, email: "a@org-a.test", passwordHash: "x", name: "A", role: "admin" },
		{ id: USER_B, organizationId: ORG_B, email: "b@org-b.test", passwordHash: "x", name: "B", role: "admin" },
	]);

	await db.insert(domains).values([
		{ id: DOMAIN_A, organizationId: ORG_A, userId: USER_A, hostname: "org-a.test", zoneId: "z_a" },
		{ id: DOMAIN_B, organizationId: ORG_B, userId: USER_B, hostname: "org-b.test", zoneId: "z_b" },
	]);

	await db.insert(mailboxes).values([
		{ id: MAILBOX_A, organizationId: ORG_A, userId: USER_A, domainId: DOMAIN_A, localPart: "team" },
		{ id: MAILBOX_B, organizationId: ORG_B, userId: USER_B, domainId: DOMAIN_B, localPart: "team" },
		{
			id: MAILBOX_B_SHARED,
			organizationId: ORG_B,
			userId: USER_B,
			domainId: DOMAIN_B,
			localPart: "shared",
			type: "shared",
		},
	]);

	await db.insert(mailboxAccess).values([
		{
			id: "mba_cross_org",
			mailboxId: MAILBOX_B_SHARED,
			userId: USER_A,
			permission: "full_access",
		},
	]);

	await db.insert(routingRules).values([
		{
			id: RULE_A,
			organizationId: ORG_A,
			userId: USER_A,
			domainId: DOMAIN_A,
			mailboxId: MAILBOX_A,
			pattern: "a@example.test",
			matchField: "email",
			matchOperator: "exact",
			matchValue: "a@example.test",
			action: "trash",
		},
		{
			id: RULE_B,
			organizationId: ORG_B,
			userId: USER_B,
			domainId: DOMAIN_B,
			mailboxId: MAILBOX_B,
			pattern: "b@example.test",
			matchField: "email",
			matchOperator: "exact",
			matchValue: "b@example.test",
			action: "trash",
		},
		{
			id: RULE_B_CROSS,
			organizationId: ORG_B,
			userId: USER_B,
			domainId: DOMAIN_B,
			mailboxId: MAILBOX_A,
			pattern: "cross@example.test",
			matchField: "email",
			matchOperator: "exact",
			matchValue: "cross@example.test",
			action: "trash",
		},
	]);

	await db.insert(contacts).values([
		{
			id: CONTACT_B,
			organizationId: ORG_B,
			userId: USER_B,
			email: SHARED_EMAIL,
			displayName: "Org B only",
			source: "manual",
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

function send(url: string, method: string, body: unknown): Request {
	return new Request(`http://localhost${url}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Next always passes a route context, even for routes with no dynamic segment. */
function routeCtx<P extends Record<string, string> = Record<string, string>>(params = {} as P) {
	return { params: Promise.resolve(params) };
}

describe.skipIf(!hasTestDatabase())("org scope: domains, routing rules, contacts (T3.2)", () => {
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

	// -------------------------------------------------------------- domains

	it("lists only the caller's organisation domains", async () => {
		const { GET } = await import("@/app/api/domains/route");

		await signIn(USER_A);
		const response = await GET(get("/api/domains"), routeCtx());
		expect(response.status).toBe(200);
		const body = (await response.json()) as { domains: Array<{ id: string }> };
		expect(body.domains.map((row) => row.id)).toEqual([DOMAIN_A]);
	});

	it("404s a domain that belongs to another organisation", async () => {
		const { GET } = await import("@/app/api/domains/[id]/route");

		await signIn(USER_A);
		const response = await GET(get(`/api/domains/${DOMAIN_B}`), routeCtx({ id: DOMAIN_B }));
		expect(response.status).toBe(404);
	});

	it("refuses to delete another organisation's domain", async () => {
		const { DELETE } = await import("@/app/api/domains/[id]/route");

		await signIn(USER_A);
		const response = await DELETE(get(`/api/domains/${DOMAIN_B}`), routeCtx({ id: DOMAIN_B }));
		expect(response.status).toBe(400);

		const rows = await createDb().select().from(domains).where(eq(domains.id, DOMAIN_B));
		expect(rows).toHaveLength(1);
	});

	it("401s an unauthenticated domain list", async () => {
		const { GET } = await import("@/app/api/domains/route");
		const response = await GET(get("/api/domains"), routeCtx());
		expect(response.status).toBe(401);
	});

	// -------------------------------------------------------- routing rules

	it("lists only the caller's organisation routing rules", async () => {
		const { GET } = await import("@/app/api/routing-rules/route");

		await signIn(USER_A);
		const response = await GET(get(`/api/routing-rules?mailboxId=${MAILBOX_A}`), routeCtx());
		expect(response.status).toBe(200);
		const body = (await response.json()) as { rules: Array<{ id: string }> };
		// RULE_B_CROSS points at MAILBOX_A but belongs to org B, so it stays hidden.
		expect(body.rules.map((row) => row.id)).toEqual([RULE_A]);
	});

	it("404s the rule list for another organisation's mailbox", async () => {
		const { GET } = await import("@/app/api/routing-rules/route");

		await signIn(USER_A);
		for (const mailboxId of [MAILBOX_B, MAILBOX_B_SHARED]) {
			// The shared one is granted by a `mailbox_access` row: only the
			// organisation filter stops it.
			const response = await GET(get(`/api/routing-rules?mailboxId=${mailboxId}`), routeCtx());
			expect(response.status).toBe(404);
		}
	});

	it("refuses to create a rule that references another organisation's mailbox", async () => {
		const { POST } = await import("@/app/api/routing-rules/route");

		await signIn(USER_A);
		const response = await POST(
			send("/api/routing-rules", "POST", {
				mailboxId: MAILBOX_B,
				matchValue: "sneaky@example.test",
				destination: "trash",
			}),
			routeCtx(),
		);
		expect(response.status).toBe(404);

		const rows = await createDb()
			.select()
			.from(routingRules)
			.where(eq(routingRules.organizationId, ORG_B));
		expect(rows.map((row) => row.id).sort()).toEqual([RULE_B, RULE_B_CROSS].sort());
	});

	it("stamps the organisation on created rules", async () => {
		const { POST } = await import("@/app/api/routing-rules/route");

		await signIn(USER_A);
		const response = await POST(
			send("/api/routing-rules", "POST", {
				mailboxId: MAILBOX_A,
				matchValue: "new@example.test",
				destination: "spam",
			}),
			routeCtx(),
		);
		expect(response.status).toBe(200);
		const created = (await response.json()) as { id: string };

		const [row] = await createDb()
			.select()
			.from(routingRules)
			.where(eq(routingRules.id, created.id));
		expect(row?.organizationId).toBe(ORG_A);
	});

	it("404s a PATCH of another organisation's rule and leaves it alone", async () => {
		const { PATCH } = await import("@/app/api/routing-rules/[id]/route");

		await signIn(USER_A);
		const response = await PATCH(
			send(`/api/routing-rules/${RULE_B_CROSS}`, "PATCH", {
				mailboxId: MAILBOX_A,
				matchValue: "hijacked@example.test",
				destination: "spam",
			}),
			routeCtx({ id: RULE_B_CROSS }),
		);
		expect(response.status).toBe(404);

		const [row] = await createDb()
			.select()
			.from(routingRules)
			.where(eq(routingRules.id, RULE_B_CROSS));
		expect(row?.matchValue).toBe("cross@example.test");
	});

	it("404s a DELETE of another organisation's rule and leaves it alone", async () => {
		const { DELETE } = await import("@/app/api/routing-rules/[id]/route");

		await signIn(USER_A);
		for (const ruleId of [RULE_B, RULE_B_CROSS]) {
			const response = await DELETE(
				get(`/api/routing-rules/${ruleId}`),
				routeCtx({ id: ruleId }),
			);
			expect(response.status).toBe(404);
		}

		const rows = await createDb()
			.select()
			.from(routingRules)
			.where(eq(routingRules.organizationId, ORG_B));
		expect(rows).toHaveLength(2);
	});

	// ------------------------------------------------------------- contacts

	it("never returns another organisation's contact row", async () => {
		const { GET } = await import("@/app/api/contacts/route");

		await signIn(USER_A);
		const response = await GET(
			get(`/api/contacts?mailboxId=${MAILBOX_A}&address=${encodeURIComponent(SHARED_EMAIL)}`),
			routeCtx(),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { contact: { displayName: string | null } };
		// The org B row has the same user id and email; only the org filter hides it.
		expect(body.contact.displayName).toBeNull();
	});

	it("404s a contact read through another organisation's mailbox", async () => {
		const { GET } = await import("@/app/api/contacts/route");

		await signIn(USER_A);
		for (const mailboxId of [MAILBOX_B, MAILBOX_B_SHARED]) {
			const response = await GET(
				get(`/api/contacts?mailboxId=${mailboxId}&address=${encodeURIComponent(SHARED_EMAIL)}`),
				routeCtx(),
			);
			expect(response.status).toBe(404);
		}
	});

	it("stamps the organisation on a contact it creates and leaves org B's row alone", async () => {
		const { PATCH } = await import("@/app/api/contacts/route");

		await signIn(USER_A);
		const response = await PATCH(
			send("/api/contacts", "PATCH", {
				mailboxId: MAILBOX_A,
				address: SHARED_EMAIL,
				displayName: "Org A name",
			}),
			routeCtx(),
		);
		expect(response.status).toBe(200);

		const db = createDb();
		const [orgARow] = await db
			.select()
			.from(contacts)
			.where(and(eq(contacts.organizationId, ORG_A), eq(contacts.email, SHARED_EMAIL)));
		expect(orgARow?.displayName).toBe("Org A name");

		const [orgBRow] = await db
			.select()
			.from(contacts)
			.where(eq(contacts.id, CONTACT_B));
		expect(orgBRow?.displayName).toBe("Org B only");
	});

	it("refuses to write a contact through another organisation's mailbox", async () => {
		const { PATCH } = await import("@/app/api/contacts/route");

		await signIn(USER_A);
		const response = await PATCH(
			send("/api/contacts", "PATCH", {
				mailboxId: MAILBOX_B,
				address: SHARED_EMAIL,
				displayName: "Sneaky",
			}),
			routeCtx(),
		);
		expect(response.status).toBe(404);
	});

	it("refuses to block a contact through another organisation's mailbox", async () => {
		const { POST } = await import("@/app/api/contacts/block/route");

		await signIn(USER_A);
		const response = await POST(
			send("/api/contacts/block", "POST", { mailboxId: MAILBOX_B, address: SHARED_EMAIL }),
			routeCtx(),
		);
		expect(response.status).toBe(404);

		const rows = await createDb()
			.select()
			.from(routingRules)
			.where(eq(routingRules.organizationId, ORG_B));
		expect(rows).toHaveLength(2);
	});
});
