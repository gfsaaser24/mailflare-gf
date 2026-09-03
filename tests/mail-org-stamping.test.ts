/**
 * Inbound and outbound mail must be stamped with the mailbox owner's
 * organisation, not with the default org.
 *
 * `messages.organization_id` and `conversations.organization_id` lost their
 * `DEFAULT 'org_default'` in migration 0008 exactly so this cannot regress
 * silently: before the fix a message for a non-default org landed in
 * `org_default` and was invisible to the org that owned the mailbox.
 */
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiKeys,
	conversations,
	domains,
	mailboxes,
	messages,
	organizations,
	users,
} from "@/db/schema";
import { generateApiKey, scopesToJson } from "@/lib/api-keys";
import { processInboundMessage, storeRawToR2 } from "@/lib/email/inbound";
import { DEFAULT_ORGANIZATION_ID } from "@/lib/organizations/constants";
import { ensureApiKeyColumns } from "./helpers/api-key-columns";
import { createDb, hasTestDatabase } from "./helpers/db";

/** The v1 route reads the cookie jar before it falls back to the API key. */
vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => undefined }),
}));

const ORG = "org_stamp";
const USER = "usr_stamp";
const DOMAIN = "dom_stamp";
const MAILBOX = "mbx_stamp";
const HOSTNAME = "stamp-org.test";
const ADDRESS = `box@${HOSTNAME}`;

const EML = [
	"Message-ID: <stamped@example.org>",
	"From: Sender <sender@example.org>",
	`To: ${ADDRESS}`,
	"Subject: Stamped delivery",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Body of the stamped message.",
	"",
].join("\r\n");

type StoredObject = { bytes: Uint8Array; contentType?: string };

/** In-memory stand-in for src/lib/storage/bucket.ts (get/put/delete/head only). */
class FakeBucket {
	readonly objects = new Map<string, StoredObject>();

	async put(
		key: string,
		value: ArrayBuffer | Uint8Array | string,
		options?: { httpMetadata?: { contentType?: string } },
	): Promise<void> {
		const bytes =
			typeof value === "string"
				? new TextEncoder().encode(value)
				: value instanceof Uint8Array
					? value
					: new Uint8Array(value);
		this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
	}

	async get(key: string) {
		const object = this.objects.get(key);
		if (!object) return null;
		const bytes = object.bytes;
		return {
			key,
			size: bytes.byteLength,
			httpMetadata: { contentType: object.contentType },
			customMetadata: undefined,
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
	async send() {
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

let apiKey = "";

async function seed(): Promise<void> {
	const db = createDb();
	await db
		.insert(organizations)
		.values({ id: ORG, name: "Stamp Org", slug: "stamp-org", status: "active" });
	await db.insert(users).values({
		id: USER,
		organizationId: ORG,
		email: `owner@${HOSTNAME}`,
		passwordHash: "x",
		name: "Owner",
		role: "admin",
	});
	await db.insert(domains).values({
		id: DOMAIN,
		organizationId: ORG,
		userId: USER,
		hostname: HOSTNAME,
		zoneId: "z_stamp",
		status: "active",
	});
	await db.insert(mailboxes).values({
		id: MAILBOX,
		organizationId: ORG,
		userId: USER,
		domainId: DOMAIN,
		localPart: "box",
		displayName: "Box",
	});

	const key = generateApiKey();
	apiKey = key.fullKey;
	await db.insert(apiKeys).values({
		id: "key_stamp",
		organizationId: ORG,
		userId: USER,
		name: "Stamp key",
		prefix: key.prefix,
		keyHash: key.hash,
		hashAlgo: key.hashAlgo,
		scopes: scopesToJson(["messages:read"]),
	});
}

describe.skipIf(!hasTestDatabase())("mail is stamped with the mailbox's organisation", () => {
	beforeAll(async () => {
		await ensureApiKeyColumns();
		// The route handlers build their env from process.env.
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		// `getEnv()` refuses a half-configured mail transport; these tests send no mail.
		if (!!process.env.EDGE_WORKER_URL !== !!process.env.EDGE_WORKER_SECRET) {
			delete process.env.EDGE_WORKER_URL;
			delete process.env.EDGE_WORKER_SECRET;
		}
	});

	beforeEach(async () => {
		await seed();
	});

	it("stores an inbound message and its conversation in the mailbox's org, and shows it to that org", async () => {
		const bucket = new FakeBucket();
		const env = createEnv(bucket);
		const db = createDb();

		const rawKey = await storeRawToR2(
			env,
			"sender@example.org",
			ADDRESS,
			new TextEncoder().encode(EML).buffer as ArrayBuffer,
		);
		await processInboundMessage(env, { from: "sender@example.org", to: ADDRESS, rawR2Key: rawKey });

		const rows = await db
			.select({
				id: messages.id,
				organizationId: messages.organizationId,
				conversationId: messages.conversationId,
			})
			.from(messages)
			.where(eq(messages.mailboxId, MAILBOX));
		expect(rows).toHaveLength(1);
		const stored = rows[0];
		expect(stored.organizationId).toBe(ORG);
		expect(stored.organizationId).not.toBe(DEFAULT_ORGANIZATION_ID);

		// The conversation the message was threaded into carries the same org.
		expect(stored.conversationId).toBeTruthy();
		const [conversation] = await db
			.select({ id: conversations.id, organizationId: conversations.organizationId })
			.from(conversations)
			.where(eq(conversations.id, stored.conversationId as string))
			.limit(1);
		expect(conversation?.organizationId).toBe(ORG);

		// And the org's own API key can see it on the public surface.
		const { GET } = await import("@/app/api/v1/messages/route");
		const response = await GET(
			new Request("http://localhost/api/v1/messages", {
				headers: { authorization: `Bearer ${apiKey}` },
			}),
			{ params: Promise.resolve({}) },
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { messages: Array<{ id: string }> };
		expect(body.messages.map((message) => message.id)).toEqual([stored.id]);
	});
});
