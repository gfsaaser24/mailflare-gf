/**
 * T5.1 — quota tables and enforcement points.
 *
 * NOTE ON SCHEMA: `org_quotas` and `org_usage` are new in this change and their
 * migration is generated separately (one combined migration for the whole wave),
 * so the migrator in `tests/helpers/db.ts` does not create them yet. `beforeAll`
 * creates both tables with raw SQL that matches `src/db/schema/index.ts`, which
 * keeps this file self-contained. `truncateAll()` (tests/setup.ts) empties them
 * between tests like every other public table.
 */
import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "@/db";
import { domains, mailboxes, messageAttachments, messages, organizations, orgUsage, users } from "@/db/schema";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { deleteMailbox } from "@/lib/mailboxes/delete";
import { QuotaExceededError } from "@/lib/quotas/errors";
import {
	applyQuotaTemplate,
	getOrganizationUsage,
	releaseQuota,
	reserveQuota,
	setOrganizationQuota,
	utcDayKey,
} from "@/lib/quotas/service";
import { QUOTA_TEMPLATE_LIMITS } from "@/lib/quotas/templates";
import { createDb, hasTestDatabase, migrateTestDatabase } from "./helpers/db";

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

// Mailbox creation would otherwise call Cloudflare Email Routing.
vi.mock("@/lib/mailboxes/domain-addresses", () => ({
	ensureMailboxDomainRouting: vi.fn(async () => undefined),
	getMailboxDomainAddresses: vi.fn(async () => []),
}));

vi.mock("@/lib/cloudflare-api", () => ({
	listEmailRoutingRules: vi.fn(async () => []),
	deleteEmailRoutingRule: vi.fn(async () => undefined),
	ensureEmailRoutingRuleToWorker: vi.fn(async () => undefined),
}));

const ORG = "org_quota";
const ADMIN = "usr_quota_admin";
const DOMAIN = "dom_quota";

/** DDL that mirrors `orgQuotas` / `orgUsage` in `src/db/schema/index.ts`. */
const CREATE_QUOTA_TABLES = `
	CREATE TABLE IF NOT EXISTS "org_quotas" (
		"organization_id" text PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
		"max_mailboxes" integer,
		"max_shared_mailboxes" integer,
		"max_accounts" integer,
		"max_domains" integer,
		"max_storage_bytes" bigint,
		"max_daily_sends" integer,
		"max_attachment_bytes" bigint
	);
	CREATE TABLE IF NOT EXISTS "org_usage" (
		"organization_id" text PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
		"mailboxes" integer NOT NULL DEFAULT 0,
		"accounts" integer NOT NULL DEFAULT 0,
		"domains" integer NOT NULL DEFAULT 0,
		"storage_bytes" bigint NOT NULL DEFAULT 0,
		"sends_today" integer NOT NULL DEFAULT 0,
		"day_key" text NOT NULL DEFAULT '1970-01-01',
		"updated_at" timestamp with time zone NOT NULL DEFAULT now()
	);
`;

function createFakeBucket() {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string) {
			const value = store.get(key);
			return value === undefined ? null : { key, size: value.length, body: null };
		},
		async put(key: string, value: unknown) {
			store.set(key, typeof value === "string" ? value : "binary");
		},
		async delete(key: string) {
			store.delete(key);
		},
		async head(key: string) {
			const value = store.get(key);
			return value === undefined ? null : { key, size: value.length };
		},
	};
}

function createFakeEnv(db: AppDatabase, bucket: ReturnType<typeof createFakeBucket>): CloudflareEnv {
	return {
		DB: db,
		BUCKET: bucket,
		EMAIL: { send: async () => ({ messageId: "noop" }) },
		CF_TOKEN: "test-token",
		CF_EMAIL_WORKER_NAME: "mailflare-edge",
	} as unknown as CloudflareEnv;
}

async function seed(): Promise<void> {
	const db = createDb();
	await db.insert(organizations).values({ id: ORG, name: "Quota Org", slug: "quota-org", status: "active" });
	await db.insert(users).values({
		id: ADMIN,
		organizationId: ORG,
		email: "admin@quota.test",
		passwordHash: "x",
		name: "Admin",
		role: "admin",
		canManageMailboxes: true,
	});
	await db.insert(domains).values({
		id: DOMAIN,
		organizationId: ORG,
		userId: ADMIN,
		hostname: "quota.test",
		zoneId: "zone-quota",
		status: "active",
	});
}

async function signIn(userId: string): Promise<void> {
	const token = await createSession({ DB: createDb() } as unknown as CloudflareEnv, userId);
	cookieJar.clear();
	cookieJar.set(SESSION_COOKIE, token);
}

function post(url: string, body: unknown): Request {
	return new Request(`http://localhost${url}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function routeCtx() {
	return { params: Promise.resolve({}) };
}

describe.skipIf(!hasTestDatabase())("quotas (T5.1)", () => {
	beforeAll(async () => {
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		if (!!process.env.EDGE_WORKER_URL !== !!process.env.EDGE_WORKER_SECRET) {
			delete process.env.EDGE_WORKER_URL;
			delete process.env.EDGE_WORKER_SECRET;
		}
		await migrateTestDatabase();
		await createDb().execute(sql.raw(CREATE_QUOTA_TABLES));
	});

	beforeEach(async () => {
		cookieJar.clear();
		await seed();
	});

	it("answers 429 with the quota body when a mailbox is over the limit", async () => {
		const db = createDb();
		await setOrganizationQuota(db, ORG, { maxMailboxes: 1 });
		const { POST } = await import("@/app/api/mailboxes/route");
		await signIn(ADMIN);

		const first = await POST(post("/api/mailboxes", { domainId: DOMAIN, localPart: "one" }), routeCtx());
		expect(first.status).toBe(200);

		const second = await POST(post("/api/mailboxes", { domainId: DOMAIN, localPart: "two" }), routeCtx());
		expect(second.status).toBe(429);
		expect(await second.json()).toEqual({
			error: "Quota exceeded",
			kind: "mailboxes",
			limit: 1,
			current: 1,
		});

		const rows = await db.select().from(mailboxes).where(eq(mailboxes.organizationId, ORG));
		expect(rows).toHaveLength(1);
	});

	it("lets exactly 10 of 20 concurrent creates through a limit of 10", async () => {
		const db = createDb();
		await setOrganizationQuota(db, ORG, { maxMailboxes: 10 });
		const { POST } = await import("@/app/api/mailboxes/route");
		await signIn(ADMIN);

		const responses = await Promise.all(
			Array.from({ length: 20 }, (_unused, index) =>
				POST(post("/api/mailboxes", { domainId: DOMAIN, localPart: `box${index}` }), routeCtx()),
			),
		);

		const created = responses.filter((response) => response.status === 200).length;
		const rejected = responses.filter((response) => response.status === 429).length;
		expect(created).toBe(10);
		expect(rejected).toBe(10);

		const rows = await db.select().from(mailboxes).where(eq(mailboxes.organizationId, ORG));
		expect(rows).toHaveLength(10);
		expect((await getOrganizationUsage(db, ORG)).mailboxes).toBe(10);
	});

	it("rolls sends_today over when day_key is not today", async () => {
		const db = createDb();
		await setOrganizationQuota(db, ORG, { maxDailySends: 2 });
		await db.insert(orgUsage).values({
			organizationId: ORG,
			sendsToday: 999,
			dayKey: "2000-01-01",
			updatedAt: new Date(),
		});

		// Yesterday's 999 sends do not count against today's limit of 2.
		await reserveQuota(db, ORG, { sendsToday: 1 });
		const rolled = await getOrganizationUsage(db, ORG);
		expect(rolled.sendsToday).toBe(1);
		expect(rolled.dayKey).toBe(utcDayKey());

		await reserveQuota(db, ORG, { sendsToday: 1 });
		await expect(reserveQuota(db, ORG, { sendsToday: 1 })).rejects.toMatchObject({
			name: "QuotaExceededError",
			kind: "daily_sends",
			limit: 2,
			current: 2,
		});
		expect((await getOrganizationUsage(db, ORG)).sendsToday).toBe(2);
	});

	it("decrements storage bytes when a mailbox is deleted", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);
		const raw = "r".repeat(500);
		await bucket.put("inbound/quota-1.eml", raw);

		await db.insert(mailboxes).values({
			id: "mbx_del",
			organizationId: ORG,
			userId: ADMIN,
			domainId: DOMAIN,
			localPart: "deleteme",
			useAllDomains: false,
		});
		await db.insert(messages).values({
			id: "msg_del",
			organizationId: ORG,
			userId: ADMIN,
			mailboxId: "mbx_del",
			direction: "inbound",
			fromAddr: "sender@example.test",
			toAddr: "deleteme@quota.test",
			rawR2Key: "inbound/quota-1.eml",
		});
		await db.insert(messageAttachments).values({
			id: "att_del",
			messageId: "msg_del",
			filename: "invoice.pdf",
			contentType: "application/pdf",
			size: 300,
			disposition: "attachment",
			r2Key: "attachments/msg_del/att_del/invoice.pdf",
		});
		await bucket.put("attachments/msg_del/att_del/invoice.pdf", "a".repeat(300));

		// What inbound would have booked: raw bytes + attachment bytes, one mailbox.
		await reserveQuota(db, ORG, { storageBytes: 800, mailboxes: 1 });

		await deleteMailbox(
			env,
			db,
			{
				id: "mbx_del",
				userId: ADMIN,
				domainId: DOMAIN,
				localPart: "deleteme",
				useAllDomains: false,
				avatarKey: null,
			},
			{ actorUserId: ADMIN, orgId: ORG },
		);

		const usage = await getOrganizationUsage(db, ORG);
		expect(usage.storageBytes).toBe(0);
		expect(usage.mailboxes).toBe(0);
	});

	it("never blocks an organisation on the unlimited template", async () => {
		const db = createDb();
		expect(QUOTA_TEMPLATE_LIMITS.unlimited.maxMailboxes).toBeNull();
		await applyQuotaTemplate(db, ORG, "unlimited");

		for (let index = 0; index < 5; index += 1) {
			await reserveQuota(db, ORG, {
				mailboxes: 100,
				sharedMailboxes: 100,
				accounts: 100,
				domains: 100,
				storageBytes: 50 * 1024 * 1024 * 1024,
				sendsToday: 10_000,
			});
		}

		const usage = await getOrganizationUsage(db, ORG);
		expect(usage.mailboxes).toBe(500);
		expect(usage.sendsToday).toBe(50_000);
		expect(usage.storageBytes).toBe(5 * 50 * 1024 * 1024 * 1024);
	});

	it("checks the small template limits and gives usage back on release", async () => {
		const db = createDb();
		await applyQuotaTemplate(db, ORG, "small");

		await reserveQuota(db, ORG, { accounts: 3 });
		await expect(reserveQuota(db, ORG, { accounts: 1 })).rejects.toBeInstanceOf(QuotaExceededError);

		await releaseQuota(db, ORG, { accounts: 1 });
		await reserveQuota(db, ORG, { accounts: 1 });
		expect((await getOrganizationUsage(db, ORG)).accounts).toBe(3);
	});
});
