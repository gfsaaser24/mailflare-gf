import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { domains, inboundFailures, mailboxes, messages, users } from "@/db/schema";
import { processInboundMessage, storeRawToR2 } from "@/lib/email/inbound";
import {
	listInboundFailures,
	recordInboundFailure,
	retryInboundFailure,
} from "@/lib/inbound-failures/service";
import { createDb, hasTestDatabase } from "./helpers/db";
import { DEFAULT_ORGANIZATION_ID } from "@/lib/organizations/constants";

const EML = [
	"Message-ID: <idempotency-test@example.org>",
	"From: Sender <sender@example.org>",
	"To: box@inbound-test.example",
	"Subject: Hello there",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Body of the test message.",
	"",
].join("\r\n");

type StoredObject = { bytes: Uint8Array; contentType?: string; metadata?: Record<string, string> };

/** In-memory stand-in for src/lib/storage/bucket.ts (get/put/delete/head only). */
class FakeBucket {
	readonly objects = new Map<string, StoredObject>();
	/** Keys whose next `get` throws, so a processing failure can be forced. */
	readonly failNextGet = new Set<string>();

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
		if (this.failNextGet.delete(key)) throw new Error(`Storage read failed for ${key}`);
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

const stubEmail = {
	sent: [] as unknown[],
	async send(message: unknown) {
		stubEmail.sent.push(message);
		return { messageId: "stub" };
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
		email: "owner@inbound-test.example",
		passwordHash: "x",
		name: "Owner",
		role: "admin",
	});
	await db.insert(domains).values({
		id: "dom_test",
		userId: "usr_test",
		hostname: "inbound-test.example",
		zoneId: "zone_test",
		status: "active",
	});
	await db.insert(mailboxes).values({
		id: "mbx_test",
		userId: "usr_test",
		domainId: "dom_test",
		localPart: "box",
		displayName: "Box",
	});
}

describe.skipIf(!hasTestDatabase())("inbound idempotency", () => {
	beforeEach(async () => {
		stubEmail.sent.length = 0;
		await seedMailbox();
	});

	it("stores one message when the same .eml is delivered twice", async () => {
		const bucket = new FakeBucket();
		const env = createEnv(bucket);
		const db = createDb();
		const raw = new TextEncoder().encode(EML).buffer as ArrayBuffer;

		const firstKey = await storeRawToR2(env, "sender@example.org", "box@inbound-test.example", raw);
		await processInboundMessage(env, {
			from: "sender@example.org",
			to: "box@inbound-test.example",
			rawR2Key: firstKey,
		});

		const secondKey = await storeRawToR2(env, "sender@example.org", "box@inbound-test.example", raw);
		expect(secondKey).not.toBe(firstKey);
		await processInboundMessage(env, {
			from: "sender@example.org",
			to: "box@inbound-test.example",
			rawR2Key: secondKey,
		});

		const rows = await db
			.select()
			.from(messages)
			.where(and(eq(messages.mailboxId, "mbx_test"), eq(messages.direction, "inbound")));
		expect(rows).toHaveLength(1);
		expect(rows[0].providerMessageId).toBe("<idempotency-test@example.org>");
		expect(rows[0].rawR2Key).toBe(firstKey);
		// The duplicate raw object is removed so nothing is orphaned.
		expect(bucket.objects.has(secondKey)).toBe(false);
		expect(bucket.objects.has(firstKey)).toBe(true);
	});

	it("rejects a duplicate inbound row at the database level", async () => {
		const db = createDb();
		const values = {
			organizationId: DEFAULT_ORGANIZATION_ID,
			userId: "usr_test",
			mailboxId: "mbx_test",
			direction: "inbound" as const,
			providerMessageId: "<dupe@example.org>",
			fromAddr: "sender@example.org",
			toAddr: "box@inbound-test.example",
		};
		await db.insert(messages).values({ id: "msg_a", ...values });
		const error = await db
			.insert(messages)
			.values({ id: "msg_b", ...values })
			.then(() => null)
			.catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(Error);
		// Drizzle wraps the driver error; the partial unique index raises unique_violation.
		expect((error as { cause?: { code?: string } }).cause?.code).toBe("23505");
	});
});

describe.skipIf(!hasTestDatabase())("inbound failures", () => {
	beforeEach(async () => {
		stubEmail.sent.length = 0;
		await seedMailbox();
	});

	it("records a failure and clears it on retry", async () => {
		const bucket = new FakeBucket();
		const env = createEnv(bucket);
		const db = createDb();
		const raw = new TextEncoder().encode(EML).buffer as ArrayBuffer;
		const rawKey = await storeRawToR2(env, "sender@example.org", "box@inbound-test.example", raw);

		// Force processing to blow up the way the edge route sees it.
		bucket.failNextGet.add(rawKey);
		let caught: unknown;
		try {
			await processInboundMessage(env, {
				from: "sender@example.org",
				to: "box@inbound-test.example",
				rawR2Key: rawKey,
			});
		} catch (error) {
			caught = error;
			await recordInboundFailure(env, {
				rawR2Key: rawKey,
				mailboxId: "mbx_test",
				fromAddr: "sender@example.org",
				toAddr: "box@inbound-test.example",
				error,
			});
		}
		expect(caught).toBeInstanceOf(Error);

		const open = await listInboundFailures(env);
		expect(open).toHaveLength(1);
		expect(open[0].attempts).toBe(1);
		expect(open[0].rawR2Key).toBe(rawKey);
		expect(await db.select().from(messages)).toHaveLength(0);

		const result = await retryInboundFailure(env, open[0].id);
		expect(result.status).toBe("resolved");
		expect(await listInboundFailures(env)).toHaveLength(0);

		const [failure] = await db
			.select()
			.from(inboundFailures)
			.where(eq(inboundFailures.id, open[0].id));
		expect(failure.resolvedAt).not.toBeNull();
		expect(failure.attempts).toBe(2);
		expect(await db.select().from(messages)).toHaveLength(1);
	});

	it("bumps attempts and keeps the row when a retry fails", async () => {
		const bucket = new FakeBucket();
		const env = createEnv(bucket);

		const id = await recordInboundFailure(env, {
			rawR2Key: "inbound/missing.eml",
			mailboxId: "mbx_test",
			fromAddr: "sender@example.org",
			toAddr: "box@inbound-test.example",
			error: new Error("boom"),
		});

		const result = await retryInboundFailure(env, id);
		expect(result.status).toBe("failed");

		const open = await listInboundFailures(env);
		expect(open).toHaveLength(1);
		expect(open[0].attempts).toBe(2);
		expect(open[0].error).toContain("no longer in storage");
	});

	it("bumps attempts instead of duplicating a row for the same raw object", async () => {
		const env = createEnv(new FakeBucket());
		const input = {
			rawR2Key: "inbound/same.eml",
			mailboxId: "mbx_test",
			fromAddr: "sender@example.org",
			toAddr: "box@inbound-test.example",
			error: new Error("first"),
		};
		const first = await recordInboundFailure(env, input);
		const second = await recordInboundFailure(env, { ...input, error: new Error("second") });
		expect(second).toBe(first);

		const open = await listInboundFailures(env);
		expect(open).toHaveLength(1);
		expect(open[0].attempts).toBe(2);
		expect(open[0].error).toBe("second");
	});
});
