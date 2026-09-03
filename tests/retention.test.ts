/**
 * T5.2 — retention windows and the one permanent-delete path.
 *
 * NOTE ON SCHEMA: `org_retention` is new in this change and its migration is
 * generated separately (one combined migration for the whole wave), so the
 * migrator in `tests/helpers/db.ts` does not create it yet. `beforeAll` creates
 * it — plus `org_quotas` / `org_usage`, which the storage refund needs — with
 * raw `CREATE TABLE IF NOT EXISTS` SQL that matches `src/db/schema/index.ts`,
 * which keeps this file self-contained. `truncateAll()` (tests/setup.ts) empties
 * them between tests like every other public table.
 */
import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "@/db";
import {
	auditLogs,
	autoReplyDeliveries,
	domains,
	mailboxes,
	messageAttachments,
	messages,
	organizations,
	orgUsage,
	outboundJobs,
	sessions,
	users,
} from "@/db/schema";
import { getRetention, setRetention } from "@/lib/retention/settings";
import { deleteMessagesPermanently, runRetention } from "@/lib/retention/service";
import { createDb, hasTestDatabase, migrateTestDatabase } from "./helpers/db";

/** DDL that mirrors `orgQuotas` / `orgUsage` / `orgRetention` in `src/db/schema/index.ts`. */
const CREATE_TABLES = `
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
	CREATE TABLE IF NOT EXISTS "org_retention" (
		"organization_id" text PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
		"trash_days" integer NOT NULL DEFAULT 30,
		"sessions_days" integer NOT NULL DEFAULT 7,
		"webhook_deliveries_days" integer NOT NULL DEFAULT 30,
		"audit_logs_days" integer NOT NULL DEFAULT 365,
		"auto_reply_days" integer NOT NULL DEFAULT 30,
		"outbound_jobs_days" integer NOT NULL DEFAULT 30,
		"updated_at" timestamp with time zone NOT NULL DEFAULT now()
	);
`;

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
			const value = store.get(key);
			return value === undefined ? null : { key, size: value.length };
		},
	};
}

type FakeBucket = ReturnType<typeof createFakeBucket>;

function createFakeEnv(db: AppDatabase, bucket: FakeBucket): CloudflareEnv {
	return {
		DB: db,
		BUCKET: bucket,
		EMAIL: { send: async () => ({ messageId: "noop" }) },
	} as unknown as CloudflareEnv;
}

const ORG_A = "org_ret_a";
const ORG_B = "org_ret_b";
const USER_A = "usr_ret_a";
const USER_B = "usr_ret_b";
const MAILBOX_A = "mbx_ret_a";
const MAILBOX_B = "mbx_ret_b";

const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
	return new Date(Date.now() - days * DAY);
}

/** Two organisations, each with one user, domain and mailbox. */
async function seed(): Promise<void> {
	const db = createDb();
	await db.insert(organizations).values([
		{ id: ORG_A, name: "Retention A", slug: "retention-a", status: "active" },
		{ id: ORG_B, name: "Retention B", slug: "retention-b", status: "active" },
	]);
	await db.insert(users).values([
		{ id: USER_A, organizationId: ORG_A, email: "a@retention.test", passwordHash: "x", name: "A" },
		{ id: USER_B, organizationId: ORG_B, email: "b@retention.test", passwordHash: "x", name: "B" },
	]);
	await db.insert(domains).values([
		{ id: "dom_ret_a", organizationId: ORG_A, userId: USER_A, hostname: "a.retention.test", zoneId: "zone-a", status: "active" },
		{ id: "dom_ret_b", organizationId: ORG_B, userId: USER_B, hostname: "b.retention.test", zoneId: "zone-b", status: "active" },
	]);
	await db.insert(mailboxes).values([
		{ id: MAILBOX_A, organizationId: ORG_A, userId: USER_A, domainId: "dom_ret_a", localPart: "inbox" },
		{ id: MAILBOX_B, organizationId: ORG_B, userId: USER_B, domainId: "dom_ret_b", localPart: "inbox" },
	]);
}

type MessageOptions = {
	id: string;
	organizationId: string;
	userId: string;
	mailboxId: string;
	status: string;
	createdAt: Date;
	/** When it entered the trash; defaults to `createdAt` for trashed messages. */
	trashedAt?: Date;
	/** Raw object body; its length is the stored size. */
	raw?: string;
	/** Attachment object bodies. */
	attachments?: string[];
};

/** Inserts a message plus its stored objects and books the bytes on `org_usage`. */
async function insertMessage(bucket: FakeBucket, options: MessageOptions): Promise<number> {
	const db = createDb();
	const rawKey = options.raw === undefined ? null : `stub/mail/inbound/${options.id}.eml`;
	let bytes = 0;

	if (rawKey && options.raw !== undefined) {
		await bucket.put(rawKey, options.raw);
		bytes += options.raw.length;
	}

	await db.insert(messages).values({
		id: options.id,
		organizationId: options.organizationId,
		userId: options.userId,
		mailboxId: options.mailboxId,
		direction: "inbound",
		fromAddr: "sender@example.test",
		toAddr: "inbox@retention.test",
		rawR2Key: rawKey,
		status: options.status,
		trashedAt: options.trashedAt ?? (options.status === "trash" ? options.createdAt : null),
		createdAt: options.createdAt,
	});

	for (const [index, body] of (options.attachments ?? []).entries()) {
		const key = `attachments/${options.id}/att-${index}/file.txt`;
		await bucket.put(key, body);
		await db.insert(messageAttachments).values({
			id: `att_${options.id}_${index}`,
			messageId: options.id,
			filename: "file.txt",
			contentType: "text/plain",
			size: body.length,
			disposition: "attachment",
			r2Key: key,
		});
		bytes += body.length;
	}

	return bytes;
}

/** Writes the organisation's booked storage bytes, as inbound would have. */
async function bookStorage(organizationId: string, bytes: number): Promise<void> {
	await createDb()
		.insert(orgUsage)
		.values({ organizationId, storageBytes: bytes, dayKey: "1970-01-01", updatedAt: new Date() })
		.onConflictDoUpdate({ target: orgUsage.organizationId, set: { storageBytes: bytes } });
}

async function storageBytesOf(organizationId: string): Promise<number> {
	const [row] = await createDb()
		.select({ storageBytes: orgUsage.storageBytes })
		.from(orgUsage)
		.where(eq(orgUsage.organizationId, organizationId))
		.limit(1);
	return Number(row?.storageBytes ?? 0);
}

async function messageIds(organizationId: string): Promise<string[]> {
	const rows = await createDb()
		.select({ id: messages.id })
		.from(messages)
		.where(eq(messages.organizationId, organizationId));
	return rows.map((row) => row.id).sort();
}

describe.skipIf(!hasTestDatabase())("retention (T5.2)", () => {
	beforeAll(async () => {
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		await migrateTestDatabase();
		await createDb().execute(sql.raw(CREATE_TABLES));
	});

	beforeEach(async () => {
		await seed();
	});

	it("defaults to the documented windows when no row exists", async () => {
		const retention = await getRetention(createDb(), ORG_A);
		expect(retention).toEqual({
			trashDays: 30,
			sessionsDays: 7,
			webhookDeliveriesDays: 30,
			auditLogsDays: 365,
			autoReplyDays: 30,
			outboundJobsDays: 30,
		});
	});

	it("deletes a trashed message past the window from the database and storage, and refunds the bytes", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);

		const oldBytes = await insertMessage(bucket, {
			id: "msg_old",
			organizationId: ORG_A,
			userId: USER_A,
			mailboxId: MAILBOX_A,
			status: "trash",
			createdAt: daysAgo(40),
			raw: "x".repeat(500),
			attachments: ["y".repeat(120)],
		});
		const freshBytes = await insertMessage(bucket, {
			id: "msg_fresh",
			organizationId: ORG_A,
			userId: USER_A,
			mailboxId: MAILBOX_A,
			status: "trash",
			createdAt: daysAgo(3),
			raw: "z".repeat(70),
		});
		// A message that is merely old is not touched: only trashed ones are.
		const keptBytes = await insertMessage(bucket, {
			id: "msg_received",
			organizationId: ORG_A,
			userId: USER_A,
			mailboxId: MAILBOX_A,
			status: "received",
			createdAt: daysAgo(400),
			raw: "k".repeat(30),
		});
		await bookStorage(ORG_A, oldBytes + freshBytes + keptBytes);

		const { results, failures } = await runRetention(env);
		expect(failures).toEqual([]);
		const orgA = results.find((result) => result.organizationId === ORG_A);
		expect(orgA?.messages).toBe(1);
		expect(orgA?.bytes).toBe(oldBytes);
		// One raw object plus one attachment object.
		expect(orgA?.objects).toBe(2);

		expect(await messageIds(ORG_A)).toEqual(["msg_fresh", "msg_received"]);
		expect(bucket.store.has("stub/mail/inbound/msg_old.eml")).toBe(false);
		expect(bucket.store.has("attachments/msg_old/att-0/file.txt")).toBe(false);
		expect(bucket.store.has("stub/mail/inbound/msg_fresh.eml")).toBe(true);
		expect(await storageBytesOf(ORG_A)).toBe(freshBytes + keptBytes);

		// The attachment rows cascade with their message.
		const attachments = await db
			.select({ id: messageAttachments.id })
			.from(messageAttachments)
			.where(eq(messageAttachments.messageId, "msg_old"));
		expect(attachments).toHaveLength(0);
	});

	it("keeps an old message that was trashed today: the window is time in trash", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);

		const bytes = await insertMessage(bucket, {
			id: "msg_old_but_freshly_trashed",
			organizationId: ORG_A,
			userId: USER_A,
			mailboxId: MAILBOX_A,
			status: "trash",
			createdAt: daysAgo(40),
			trashedAt: new Date(),
			raw: "q".repeat(40),
		});
		await bookStorage(ORG_A, bytes);

		const { results, failures } = await runRetention(env);
		expect(failures).toEqual([]);
		expect(results.find((result) => result.organizationId === ORG_A)?.messages).toBe(0);
		expect(await messageIds(ORG_A)).toEqual(["msg_old_but_freshly_trashed"]);
		expect(bucket.store.has("stub/mail/inbound/msg_old_but_freshly_trashed.eml")).toBe(true);
		expect(await storageBytesOf(ORG_A)).toBe(bytes);
	});

	it("respects each organisation's own trash window", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);

		await setRetention(db, ORG_B, { trashDays: 1 });

		await insertMessage(bucket, {
			id: "msg_a",
			organizationId: ORG_A,
			userId: USER_A,
			mailboxId: MAILBOX_A,
			status: "trash",
			createdAt: daysAgo(5),
			raw: "a".repeat(10),
		});
		await insertMessage(bucket, {
			id: "msg_b",
			organizationId: ORG_B,
			userId: USER_B,
			mailboxId: MAILBOX_B,
			status: "trash",
			createdAt: daysAgo(5),
			raw: "b".repeat(10),
		});

		await runRetention(env);

		// Org A keeps the default 30 days, org B was cut to 1.
		expect(await messageIds(ORG_A)).toEqual(["msg_a"]);
		expect(await messageIds(ORG_B)).toEqual([]);
		expect(bucket.store.has("stub/mail/inbound/msg_a.eml")).toBe(true);
		expect(bucket.store.has("stub/mail/inbound/msg_b.eml")).toBe(false);
	});

	it("keeps platform.* audit rows however old they are", async () => {
		const db = createDb();
		const env = createFakeEnv(db, createFakeBucket());

		await db.insert(auditLogs).values([
			{ id: "aud_old_platform", organizationId: ORG_A, action: "platform.org.suspend", createdAt: daysAgo(900) },
			{ id: "aud_old_ordinary", organizationId: ORG_A, action: "mailbox.delete", createdAt: daysAgo(900) },
			{ id: "aud_recent", organizationId: ORG_A, action: "mailbox.delete", createdAt: daysAgo(10) },
		]);

		const { results } = await runRetention(env);
		expect(results.find((result) => result.organizationId === ORG_A)?.auditLogs).toBe(1);

		const rows = await db
			.select({ id: auditLogs.id })
			.from(auditLogs)
			.where(eq(auditLogs.organizationId, ORG_A));
		expect(rows.map((row) => row.id).sort()).toEqual(["aud_old_platform", "aud_recent"]);
	});

	it("sweeps expired sessions, auto-reply records and outbound jobs per organisation", async () => {
		const db = createDb();
		const env = createFakeEnv(db, createFakeBucket());

		await db.insert(sessions).values([
			{ id: "ses_stale", userId: USER_A, tokenHash: "hash-stale", expiresAt: daysAgo(30) },
			{ id: "ses_just_expired", userId: USER_A, tokenHash: "hash-just", expiresAt: daysAgo(2) },
			{ id: "ses_live", userId: USER_A, tokenHash: "hash-live", expiresAt: new Date(Date.now() + DAY) },
			{ id: "ses_other_org", userId: USER_B, tokenHash: "hash-other", expiresAt: daysAgo(30) },
		]);
		await db.insert(autoReplyDeliveries).values([
			{ id: "arp_old", mailboxId: MAILBOX_A, recipient: "old@example.test", sentAt: daysAgo(60) },
			{ id: "arp_new", mailboxId: MAILBOX_A, recipient: "new@example.test", sentAt: daysAgo(2) },
		]);
		await db.insert(outboundJobs).values([
			{ id: "job_old", userId: USER_A, status: "sent", payload: "{}", createdAt: daysAgo(60), updatedAt: daysAgo(60) },
			{ id: "job_new", userId: USER_A, status: "sent", payload: "{}", createdAt: daysAgo(2), updatedAt: daysAgo(2) },
		]);

		const { results } = await runRetention(env);
		const orgA = results.find((result) => result.organizationId === ORG_A);
		expect(orgA?.sessions).toBe(1);
		expect(orgA?.autoReplyDeliveries).toBe(1);
		expect(orgA?.outboundJobs).toBe(1);

		// The global sweep (`runGlobalRetention`) removes every expired session,
		// so the recently expired one goes too; only the live session survives.
		const remaining = await db.select({ id: sessions.id }).from(sessions);
		expect(remaining.map((row) => row.id)).toEqual(["ses_live"]);
	});

	it("deleteMessagesPermanently ignores messages of another organisation", async () => {
		const db = createDb();
		const bucket = createFakeBucket();
		const env = createFakeEnv(db, bucket);

		const bytes = await insertMessage(bucket, {
			id: "msg_other",
			organizationId: ORG_B,
			userId: USER_B,
			mailboxId: MAILBOX_B,
			status: "trash",
			createdAt: daysAgo(1),
			raw: "o".repeat(42),
		});
		await bookStorage(ORG_B, bytes);

		const counts = await deleteMessagesPermanently(env, ORG_A, ["msg_other"]);
		expect(counts).toEqual({ messages: 0, objects: 0, bytes: 0 });
		expect(await messageIds(ORG_B)).toEqual(["msg_other"]);
		expect(await storageBytesOf(ORG_B)).toBe(bytes);
	});
});
