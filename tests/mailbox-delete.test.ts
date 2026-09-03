import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDatabase } from "@/db";
import { schema } from "@/db";
import { deleteMailbox, MailboxCloudflareCleanupError } from "@/lib/mailboxes/delete";
import { createDb, hasTestDatabase } from "./helpers/db";
import { DEFAULT_ORGANIZATION_ID } from "@/lib/organizations/constants";

const cloudflare = vi.hoisted(() => ({
	listEmailRoutingRules: vi.fn(),
	deleteEmailRoutingRule: vi.fn(),
}));

vi.mock("@/lib/cloudflare-api", () => cloudflare);

/** Minimal in-memory stand-in for the R2-like storage bucket. */
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
			return store.has(key) ? { key, size: store.get(key)!.length } : null;
		},
	};
}

type FakeBucket = ReturnType<typeof createFakeBucket>;

function createFakeEnv(db: AppDatabase, bucket: FakeBucket): CloudflareEnv {
	return {
		DB: db,
		BUCKET: bucket,
		EMAIL: { send: async () => ({ id: "noop" }) },
		CF_TOKEN: "test-token",
		CF_EMAIL_WORKER_NAME: "mailflare-edge",
	} as unknown as CloudflareEnv;
}

const AVATAR_KEY = "avatars/mailbox/mb-1.png";
const RAW_KEY_1 = "stub/mail/inbound/m-1.eml";
const RAW_KEY_2 = "stub/mail/inbound/m-2.eml";
const ATTACHMENT_KEY = "attachments/m-1/att-1/invoice.pdf";
const UNRELATED_KEY = "stub/mail/inbound/other.eml";

const ZONE_ONE_RULES = [
	{
		id: "rule-sales-one",
		matchers: [{ type: "literal", field: "to", value: "sales@one.test" }],
		actions: [{ type: "worker", value: ["mailflare-edge"] }],
	},
	{
		id: "rule-support-one",
		matchers: [{ type: "literal", field: "to", value: "support@one.test" }],
		actions: [{ type: "worker", value: ["mailflare-edge"] }],
	},
	{
		id: "rule-catch-all-one",
		matchers: [{ type: "all" }],
		actions: [{ type: "worker", value: ["mailflare-edge"] }],
	},
];

const ZONE_TWO_RULES = [
	{
		// Cloudflare echoes back whatever case the rule was created with.
		id: "rule-sales-two",
		matchers: [{ type: "literal", field: "to", value: "Sales@Two.test" }],
		actions: [{ type: "worker", value: ["mailflare-edge"] }],
	},
	{
		id: "rule-billing-two",
		matchers: [{ type: "literal", field: "to", value: "billing@two.test" }],
		actions: [{ type: "worker", value: ["mailflare-edge"] }],
	},
];

async function seed(db: AppDatabase, options?: { useAllDomains?: boolean }): Promise<void> {
	await db.insert(schema.users).values({
		id: "u-1",
		email: "owner@one.test",
		passwordHash: "not-a-real-hash",
		name: "Owner",
		canManageMailboxes: true,
	});
	await db.insert(schema.domains).values([
		{ id: "d-1", userId: "u-1", hostname: "one.test", zoneId: "zone-1", status: "active" },
		{ id: "d-2", userId: "u-1", hostname: "two.test", zoneId: "zone-2", status: "active" },
	]);
	await db.insert(schema.mailboxes).values({
		id: "mb-1",
		userId: "u-1",
		domainId: "d-1",
		localPart: "sales",
		useAllDomains: options?.useAllDomains ?? true,
		avatarKey: AVATAR_KEY,
	});
	await db.insert(schema.messages).values([
		{
			id: "m-1",
			organizationId: DEFAULT_ORGANIZATION_ID,
			userId: "u-1",
			mailboxId: "mb-1",
			direction: "inbound",
			fromAddr: "sender@example.test",
			toAddr: "sales@one.test",
			rawR2Key: RAW_KEY_1,
		},
		{
			id: "m-2",
			organizationId: DEFAULT_ORGANIZATION_ID,
			userId: "u-1",
			mailboxId: "mb-1",
			direction: "inbound",
			fromAddr: "sender@example.test",
			toAddr: "sales@two.test",
			rawR2Key: RAW_KEY_2,
		},
		{
			// Not on this mailbox: must survive.
			id: "m-3",
			organizationId: DEFAULT_ORGANIZATION_ID,
			userId: "u-1",
			mailboxId: null,
			direction: "outbound",
			fromAddr: "owner@one.test",
			toAddr: "someone@example.test",
			rawR2Key: UNRELATED_KEY,
		},
	]);
	await db.insert(schema.messageAttachments).values({
		id: "att-1",
		messageId: "m-1",
		filename: "invoice.pdf",
		contentType: "application/pdf",
		size: 12,
		r2Key: ATTACHMENT_KEY,
	});
}

function seedBucket(bucket: FakeBucket): void {
	for (const key of [AVATAR_KEY, RAW_KEY_1, RAW_KEY_2, ATTACHMENT_KEY, UNRELATED_KEY]) {
		bucket.store.set(key, "object-body");
	}
}

function mailboxInput(overrides?: { useAllDomains?: boolean }) {
	return {
		id: "mb-1",
		userId: "u-1",
		domainId: "d-1",
		localPart: "sales",
		useAllDomains: overrides?.useAllDomains ?? true,
		avatarKey: AVATAR_KEY,
	};
}

function rulesByZone(zoneId: string) {
	if (zoneId === "zone-1") return ZONE_ONE_RULES;
	if (zoneId === "zone-2") return ZONE_TWO_RULES;
	return [];
}

describe.skipIf(!hasTestDatabase())("deleteMailbox", () => {
	beforeEach(() => {
		cloudflare.listEmailRoutingRules.mockReset();
		cloudflare.deleteEmailRoutingRule.mockReset();
		cloudflare.listEmailRoutingRules.mockImplementation(
			async (_env: unknown, zoneId: string) => rulesByZone(zoneId),
		);
		cloudflare.deleteEmailRoutingRule.mockResolvedValue({});
	});

	it("deletes the routing rule on every domain the mailbox was routed on", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);
		await seed(db);
		seedBucket(bucket);

		const counts = await deleteMailbox(env, db, mailboxInput(), { actorUserId: "u-1" });

		const deletedRuleIds = cloudflare.deleteEmailRoutingRule.mock.calls.map((call) => call[2]);
		expect(deletedRuleIds.sort()).toEqual(["rule-sales-one", "rule-sales-two"]);
		expect(counts.rules).toBe(2);
	});

	it("removes raw, attachment and avatar objects but nothing else", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);
		await seed(db);
		seedBucket(bucket);

		const counts = await deleteMailbox(env, db, mailboxInput(), { actorUserId: "u-1" });

		expect([...bucket.store.keys()]).toEqual([UNRELATED_KEY]);
		expect(counts.objects).toBe(4);
		expect(counts.messages).toBe(2);
	});

	it("removes the mailbox, its messages and its attachment rows", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);
		await seed(db);
		seedBucket(bucket);

		await deleteMailbox(env, db, mailboxInput(), { actorUserId: "u-1" });

		expect(await db.select().from(schema.mailboxes)).toHaveLength(0);
		expect(await db.select().from(schema.messageAttachments)).toHaveLength(0);
		const remaining = await db.select({ id: schema.messages.id }).from(schema.messages);
		expect(remaining.map((row) => row.id)).toEqual(["m-3"]);
	});

	it("writes a mailbox.delete audit log with the cleanup counts", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);
		await seed(db);
		seedBucket(bucket);

		await deleteMailbox(env, db, mailboxInput(), { actorUserId: "u-1" });

		const [log] = await db
			.select()
			.from(schema.auditLogs)
			.where(eq(schema.auditLogs.action, "mailbox.delete"));
		expect(log).toBeDefined();
		expect(log!.actorUserId).toBe("u-1");
		expect(log!.mailboxId).toBeNull();
		expect(JSON.parse(log!.metadata!)).toMatchObject({
			mailboxId: "mb-1",
			rules: 2,
			objects: 4,
			messages: 2,
		});
	});

	it("only touches the primary domain when useAllDomains is false", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);
		await seed(db, { useAllDomains: false });
		seedBucket(bucket);

		const counts = await deleteMailbox(env, db, mailboxInput({ useAllDomains: false }));

		const listedZones = cloudflare.listEmailRoutingRules.mock.calls.map((call) => call[1]);
		expect(listedZones).toEqual(["zone-1"]);
		expect(cloudflare.deleteEmailRoutingRule.mock.calls.map((call) => call[2])).toEqual([
			"rule-sales-one",
		]);
		expect(counts.rules).toBe(1);
	});

	it("keeps a rule that belongs to another mailbox with the same local part", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);
		await seed(db);
		seedBucket(bucket);
		await db.insert(schema.mailboxes).values({
			id: "mb-2",
			userId: "u-1",
			domainId: "d-2",
			localPart: "sales",
			useAllDomains: false,
		});

		await deleteMailbox(env, db, mailboxInput());

		expect(cloudflare.deleteEmailRoutingRule.mock.calls.map((call) => call[2])).toEqual([
			"rule-sales-one",
		]);
	});

	it("aborts with a cleanup error and changes nothing when a rule delete fails", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);
		await seed(db);
		seedBucket(bucket);
		cloudflare.deleteEmailRoutingRule.mockRejectedValue(new Error("cf 500"));

		await expect(deleteMailbox(env, db, mailboxInput(), { actorUserId: "u-1" })).rejects.toBeInstanceOf(
			MailboxCloudflareCleanupError,
		);

		expect(await db.select().from(schema.mailboxes)).toHaveLength(1);
		expect(await db.select().from(schema.messages)).toHaveLength(3);
		expect(await db.select().from(schema.messageAttachments)).toHaveLength(1);
		expect(await db.select().from(schema.auditLogs)).toHaveLength(0);
		expect([...bucket.store.keys()].sort()).toEqual(
			[AVATAR_KEY, RAW_KEY_1, RAW_KEY_2, ATTACHMENT_KEY, UNRELATED_KEY].sort(),
		);
	});

	it("aborts with a cleanup error and changes nothing when listing rules fails", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);
		await seed(db);
		seedBucket(bucket);
		cloudflare.listEmailRoutingRules.mockRejectedValue(new Error("cf timeout"));

		await expect(deleteMailbox(env, db, mailboxInput())).rejects.toThrow(/could not list Email Routing rules/);

		expect(cloudflare.deleteEmailRoutingRule).not.toHaveBeenCalled();
		expect(await db.select().from(schema.mailboxes)).toHaveLength(1);
		expect(bucket.store.size).toBe(5);
	});

	it("survives a storage failure and still deletes the rows", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);
		await seed(db);
		seedBucket(bucket);
		const failing = vi.spyOn(bucket, "delete").mockRejectedValue(new Error("storage down"));
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});

		const counts = await deleteMailbox(env, db, mailboxInput());

		expect(counts.objects).toBe(0);
		expect(await db.select().from(schema.mailboxes)).toHaveLength(0);
		failing.mockRestore();
		logged.mockRestore();
	});
});
