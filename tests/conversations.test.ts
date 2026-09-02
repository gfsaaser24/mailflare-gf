import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { conversations, domains, mailboxes, messages, users } from "@/db/schema";
import { normalizeSubject, parseMessageIdList } from "@/lib/conversations/service";
import { processInboundMessage, storeRawToR2 } from "@/lib/email/inbound";
import { sendEmail } from "@/lib/email/send";
import { createDb, hasTestDatabase } from "./helpers/db";

const MAILBOX_ADDRESS = "box@conversation-test.example";

function buildEml(options: {
	messageId: string;
	subject: string;
	from?: string;
	inReplyTo?: string;
	references?: string;
	body?: string;
}): ArrayBuffer {
	const lines = [
		`Message-ID: ${options.messageId}`,
		`From: Sender <${options.from ?? "sender@example.org"}>`,
		`To: ${MAILBOX_ADDRESS}`,
		`Subject: ${options.subject}`,
	];
	if (options.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo}`);
	if (options.references) lines.push(`References: ${options.references}`);
	lines.push("Content-Type: text/plain; charset=utf-8", "", options.body ?? "Body.", "");
	return new TextEncoder().encode(lines.join("\r\n")).buffer as ArrayBuffer;
}

type StoredObject = { bytes: Uint8Array; contentType?: string; metadata?: Record<string, string> };

/** In-memory stand-in for src/lib/storage/bucket.ts (get/put/delete/head only). */
class FakeBucket {
	readonly objects = new Map<string, StoredObject>();

	async put(
		key: string,
		value: ArrayBuffer | Uint8Array | string,
		options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
	): Promise<void> {
		const bytes =
			typeof value === "string"
				? new TextEncoder().encode(value)
				: value instanceof Uint8Array
					? value
					: new Uint8Array(value);
		this.objects.set(key, {
			bytes,
			contentType: options?.httpMetadata?.contentType,
			metadata: options?.customMetadata,
		});
	}

	async get(key: string) {
		const object = this.objects.get(key);
		if (!object) return null;
		const bytes = object.bytes;
		return {
			key,
			size: bytes.byteLength,
			httpMetadata: { contentType: object.contentType },
			customMetadata: object.metadata,
			body: null,
			arrayBuffer: async () =>
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
			text: async () => new TextDecoder().decode(bytes),
		};
	}

	async head(key: string) {
		const object = this.objects.get(key);
		return object ? { size: object.bytes.byteLength, contentType: object.contentType } : null;
	}

	async delete(key: string | string[]): Promise<void> {
		for (const k of Array.isArray(key) ? key : [key]) this.objects.delete(k);
	}
}

type SentMessage = { headers?: Record<string, string>; subject: string; to: string };

const stubEmail = {
	sent: [] as SentMessage[],
	counter: 0,
	async send(message: SentMessage) {
		stubEmail.sent.push(message);
		stubEmail.counter += 1;
		return { messageId: `<outbound-${stubEmail.counter}@conversation-test.example>` };
	},
};

function createEnv(bucket: FakeBucket): CloudflareEnv {
	return {
		DB: createDb(),
		BUCKET: bucket as unknown as CloudflareEnv["BUCKET"],
		EMAIL: stubEmail as unknown as CloudflareEnv["EMAIL"],
		NODE_ENV: "test",
	} as CloudflareEnv;
}

async function seedMailbox() {
	const db = createDb();
	await db.insert(users).values({
		id: "usr_test",
		email: "owner@conversation-test.example",
		passwordHash: "x",
		name: "Owner",
		role: "admin",
	});
	await db.insert(domains).values({
		id: "dom_test",
		userId: "usr_test",
		hostname: "conversation-test.example",
		zoneId: "zone_test",
		status: "active",
	});
	await db.insert(mailboxes).values({
		id: "mbx_test",
		userId: "usr_test",
		domainId: "dom_test",
		localPart: "box",
		displayName: "Box",
		useAllDomains: false,
	});
}

async function deliver(env: CloudflareEnv, raw: ArrayBuffer, from = "sender@example.org") {
	const key = await storeRawToR2(env, from, MAILBOX_ADDRESS, raw);
	await processInboundMessage(env, { from, to: MAILBOX_ADDRESS, rawR2Key: key });
}

async function messageByProviderId(providerMessageId: string) {
	const db = createDb();
	const [row] = await db
		.select()
		.from(messages)
		.where(eq(messages.providerMessageId, providerMessageId))
		.limit(1);
	return row;
}

describe("subject normalisation", () => {
	it("strips stacked reply and forward prefixes and folds case", () => {
		expect(normalizeSubject("Re: Fwd:  Quarterly Report ")).toBe("quarterly report");
		expect(normalizeSubject("RE:re: Hello")).toBe("hello");
		expect(normalizeSubject("FW: Hello")).toBe("hello");
		expect(normalizeSubject("Hello")).toBe("hello");
		expect(normalizeSubject(null)).toBe("");
		// "Retro" must not lose its first three letters.
		expect(normalizeSubject("Retro notes")).toBe("retro notes");
	});

	it("splits message id lists", () => {
		expect(parseMessageIdList("<a@x> <b@x>")).toEqual(["<a@x>", "<b@x>"]);
		expect(parseMessageIdList("<a@x>\r\n\t<b@x> <a@x>")).toEqual(["<a@x>", "<b@x>"]);
		expect(parseMessageIdList(null)).toEqual([]);
	});
});

describe.skipIf(!hasTestDatabase())("conversation threading", () => {
	beforeEach(async () => {
		stubEmail.sent.length = 0;
		stubEmail.counter = 0;
		await seedMailbox();
	});

	it("joins an inbound reply to the original by In-Reply-To", async () => {
		const env = createEnv(new FakeBucket());
		await deliver(env, buildEml({ messageId: "<orig@example.org>", subject: "Quarterly report" }));
		await deliver(
			env,
			buildEml({
				messageId: "<reply@example.org>",
				// Deliberately unrelated subject: the header alone must thread it.
				subject: "A completely different subject",
				inReplyTo: "<orig@example.org>",
				references: "<orig@example.org>",
			}),
		);

		const original = await messageByProviderId("<orig@example.org>");
		const reply = await messageByProviderId("<reply@example.org>");
		expect(original.conversationId).toBeTruthy();
		expect(reply.conversationId).toBe(original.conversationId);
		expect(reply.inReplyTo).toBe("<orig@example.org>");
		expect(reply.referencesHeader).toEqual(["<orig@example.org>"]);

		const db = createDb();
		const [conversation] = await db
			.select()
			.from(conversations)
			.where(eq(conversations.id, original.conversationId!));
		expect(conversation.messageCount).toBe(2);
		expect(conversation.subjectNormalized).toBe("quarterly report");
		expect(conversation.lastMessageAt).toBeInstanceOf(Date);
	});

	it("joins on the same normalised subject and participant without threading headers", async () => {
		const env = createEnv(new FakeBucket());
		await deliver(env, buildEml({ messageId: "<a1@example.org>", subject: "Invoice 42" }));
		await deliver(env, buildEml({ messageId: "<a2@example.org>", subject: "Re: Invoice 42" }));

		const first = await messageByProviderId("<a1@example.org>");
		const second = await messageByProviderId("<a2@example.org>");
		expect(second.conversationId).toBe(first.conversationId);

		const db = createDb();
		const rows = await db.select().from(conversations);
		expect(rows).toHaveLength(1);
		expect(rows[0].messageCount).toBe(2);
	});

	it("starts a new conversation for the same subject from a different participant", async () => {
		const env = createEnv(new FakeBucket());
		await deliver(env, buildEml({ messageId: "<b1@example.org>", subject: "Invoice 42" }));
		await deliver(
			env,
			buildEml({ messageId: "<b2@example.org>", subject: "Re: Invoice 42", from: "other@example.net" }),
			"other@example.net",
		);

		const first = await messageByProviderId("<b1@example.org>");
		const second = await messageByProviderId("<b2@example.org>");
		expect(second.conversationId).not.toBe(first.conversationId);
		const db = createDb();
		expect(await db.select().from(conversations)).toHaveLength(2);
	});

	it("does not join a subject match older than the 7 day window", async () => {
		const env = createEnv(new FakeBucket());
		const db = createDb();
		await deliver(env, buildEml({ messageId: "<c1@example.org>", subject: "Invoice 99" }));
		const first = await messageByProviderId("<c1@example.org>");
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		await db.update(messages).set({ createdAt: eightDaysAgo }).where(eq(messages.id, first.id));

		await deliver(env, buildEml({ messageId: "<c2@example.org>", subject: "Re: Invoice 99" }));
		const second = await messageByProviderId("<c2@example.org>");
		expect(second.conversationId).not.toBe(first.conversationId);
	});

	it("emits In-Reply-To and References on an outbound reply and keeps one conversation", async () => {
		const env = createEnv(new FakeBucket());
		await deliver(
			env,
			buildEml({
				messageId: "<thread-1@example.org>",
				subject: "Support request",
				references: "<older@example.org>",
			}),
		);
		const inbound = await messageByProviderId("<thread-1@example.org>");

		await sendEmail(env, {
			userId: "usr_test",
			mailboxId: "mbx_test",
			from: MAILBOX_ADDRESS,
			to: "sender@example.org",
			subject: "Re: Support request",
			text: "On it.",
		});

		expect(stubEmail.sent).toHaveLength(1);
		const headers = stubEmail.sent[0].headers ?? {};
		expect(headers["In-Reply-To"]).toBe("<thread-1@example.org>");
		expect(headers.References).toBe("<older@example.org> <thread-1@example.org>");

		const db = createDb();
		const rows = await db
			.select()
			.from(messages)
			.where(eq(messages.mailboxId, "mbx_test"))
			.orderBy(asc(messages.createdAt));
		expect(rows).toHaveLength(2);
		const outbound = rows.find((row) => row.direction === "outbound")!;
		expect(outbound.conversationId).toBe(inbound.conversationId);
		expect(outbound.inReplyTo).toBe("<thread-1@example.org>");
		expect(outbound.referencesHeader).toEqual(["<older@example.org>", "<thread-1@example.org>"]);
		expect(await db.select().from(conversations)).toHaveLength(1);
	});

	it("leaves an explicit In-Reply-To header from the caller alone", async () => {
		const env = createEnv(new FakeBucket());
		await deliver(env, buildEml({ messageId: "<explicit@example.org>", subject: "Ping" }));
		await sendEmail(env, {
			userId: "usr_test",
			mailboxId: "mbx_test",
			from: MAILBOX_ADDRESS,
			to: "sender@example.org",
			subject: "Re: Ping",
			text: "Pong.",
			headers: { "In-Reply-To": "<caller-chose-this@example.org>" },
		});
		expect(stubEmail.sent[0].headers?.["In-Reply-To"]).toBe("<caller-chose-this@example.org>");
	});
});

describe.skipIf(!hasTestDatabase())("conversation backfill", () => {
	beforeEach(async () => {
		await seedMailbox();
	});

	it("groups pre-existing messages by mailbox and normalised subject", async () => {
		const db = createDb();
		const base = {
			userId: "usr_test",
			mailboxId: "mbx_test",
			direction: "inbound" as const,
			fromAddr: "sender@example.org",
			toAddr: MAILBOX_ADDRESS,
		};
		const day = 24 * 60 * 60 * 1000;
		const now = Date.now();
		await db.insert(messages).values([
			{
				id: "msg_old_1",
				...base,
				subject: "Legacy thread",
				providerMessageId: "<old1@example.org>",
				createdAt: new Date(now - 2 * day),
			},
			{
				id: "msg_old_2",
				...base,
				subject: "RE: Legacy thread",
				providerMessageId: "<old2@example.org>",
				createdAt: new Date(now - day),
			},
			{
				id: "msg_old_3",
				...base,
				subject: "Another thread",
				providerMessageId: "<old3@example.org>",
				createdAt: new Date(now),
			},
		]);
		// The rows must look like pre-migration data.
		await db.update(messages).set({ conversationId: null });

		for (const statement of backfillStatements()) {
			await db.execute(sql.raw(statement));
		}

		const rows = await db.select().from(messages).orderBy(asc(messages.id));
		expect(rows[0].conversationId).toBeTruthy();
		expect(rows[1].conversationId).toBe(rows[0].conversationId);
		expect(rows[2].conversationId).not.toBe(rows[0].conversationId);

		const conversationRows = await db.select().from(conversations).orderBy(asc(conversations.messageCount));
		expect(conversationRows).toHaveLength(2);
		expect(conversationRows.map((row) => row.messageCount)).toEqual([1, 2]);
		expect(conversationRows[1].subjectNormalized).toBe("legacy thread");
		// The first subject seen wins, not the "RE:" one.
		expect(conversationRows[1].subject).toBe("Legacy thread");
	});
});

/** The data-backfill half of drizzle/migrations/0002_conversations.sql. */
function backfillStatements(): string[] {
	const file = readFileSync(resolve(process.cwd(), "drizzle/migrations/0002_conversations.sql"), "utf8");
	const marker = "-- Backfill:";
	const index = file.indexOf(marker);
	if (index < 0) throw new Error("Backfill SQL missing from 0002_conversations.sql");
	return file
		.slice(index)
		.split("--> statement-breakpoint")
		.map((statement) => statement.trim())
		.filter(Boolean);
}
