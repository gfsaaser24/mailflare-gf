/**
 * Cc and Bcc on outbound mail.
 *
 * Three layers, because a Cc that is only a header is a silent data loss:
 *   1. `sendEmailSchema` turns whatever the wire carries into `string[]`.
 *   2. `sendEmail` stores the lists and hands them to the transport.
 *   3. `EdgeWorkerEmailSender` puts them in the JSON body the edge worker
 *      reads, which is what reaches Cloudflare's `send_email` binding.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { contacts, domains, mailboxes, messages, users } from "@/db/schema";
import { EdgeWorkerEmailSender, type OutboundMessage } from "@/lib/email/transport";
import { sendEmail } from "@/lib/email/send";
import { MAX_RECIPIENTS, normalizeRecipients, splitAddressList } from "@/lib/email/recipients";
import { sendEmailSchema } from "@/lib/validators";
import { createDb, hasTestDatabase } from "./helpers/db";

const HOSTNAME = "cc-bcc-test.example";
const MAILBOX_ADDRESS = `box@${HOSTNAME}`;

function baseBody(overrides: Record<string, unknown> = {}) {
	return {
		from: MAILBOX_ADDRESS,
		to: "one@example.org",
		subject: "Hello",
		mailboxId: "mbx_cc",
		text: "Body.",
		...overrides,
	};
}

describe("recipient normalisation", () => {
	it("splits a comma or semicolon separated string into an array", () => {
		const parsed = sendEmailSchema.parse(baseBody({ to: "a@example.org, b@example.org; c@example.org" }));
		expect(parsed.to).toEqual(["a@example.org", "b@example.org", "c@example.org"]);
	});

	it("keeps a single address a one-element array and leaves `to` the wire name", () => {
		const parsed = sendEmailSchema.parse(baseBody());
		expect(parsed.to).toEqual(["one@example.org"]);
		expect(parsed.cc).toBeUndefined();
		expect(parsed.bcc).toBeUndefined();
	});

	it("accepts arrays as well as strings for cc and bcc", () => {
		const parsed = sendEmailSchema.parse(
			baseBody({ cc: ["c1@example.org", "c2@example.org"], bcc: "b1@example.org" }),
		);
		expect(parsed.cc).toEqual(["c1@example.org", "c2@example.org"]);
		expect(parsed.bcc).toEqual(["b1@example.org"]);
	});

	it("trims blanks and drops empty entries", () => {
		const parsed = sendEmailSchema.parse(baseBody({ to: "  a@example.org ,, ; b@example.org  " }));
		expect(parsed.to).toEqual(["a@example.org", "b@example.org"]);
	});

	it("does not split on a comma inside a quoted display name", () => {
		expect(splitAddressList('"Chen, Maya" <maya@example.org>, bob@example.org')).toEqual([
			'"Chen, Maya" <maya@example.org>',
			"bob@example.org",
		]);
		const parsed = sendEmailSchema.parse(baseBody({ to: '"Chen, Maya" <maya@example.org>, bob@example.org' }));
		expect(parsed.to).toEqual(['"Chen, Maya" <maya@example.org>', "bob@example.org"]);
	});

	it("rejects an address that is not an address", () => {
		expect(sendEmailSchema.safeParse(baseBody({ to: "not-an-address" })).success).toBe(false);
		expect(sendEmailSchema.safeParse(baseBody({ cc: "a@example.org, nope" })).success).toBe(false);
		expect(sendEmailSchema.safeParse(baseBody({ bcc: "who@" })).success).toBe(false);
	});

	it("rejects an empty `to`", () => {
		expect(sendEmailSchema.safeParse(baseBody({ to: "" })).success).toBe(false);
	});

	it("caps to + cc + bcc at 50 combined", () => {
		const addresses = (count: number, prefix: string) =>
			Array.from({ length: count }, (_, index) => `${prefix}${index}@example.org`);

		expect(
			sendEmailSchema.safeParse(baseBody({ to: addresses(20, "t"), cc: addresses(20, "c"), bcc: addresses(10, "b") }))
				.success,
		).toBe(true);
		const overflow = sendEmailSchema.safeParse(
			baseBody({ to: addresses(20, "t"), cc: addresses(20, "c"), bcc: addresses(11, "b") }),
		);
		expect(overflow.success).toBe(false);
		expect(MAX_RECIPIENTS).toBe(50);
	});

	it("normalizeRecipients tolerates null, undefined and nested lists", () => {
		expect(normalizeRecipients(null)).toEqual([]);
		expect(normalizeRecipients(undefined)).toEqual([]);
		expect(normalizeRecipients(["a@example.org, b@example.org", " c@example.org "])).toEqual([
			"a@example.org",
			"b@example.org",
			"c@example.org",
		]);
	});
});

describe("edge worker send body", () => {
	it("carries to, cc, bcc and replyTo, and omits the empty ones", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(JSON.stringify({ messageId: "<edge-1@example.org>" }), { status: 200 });
		}) as typeof globalThis.fetch;

		try {
			const sender = new EdgeWorkerEmailSender("https://edge.example/", "secret");
			const message: OutboundMessage = {
				from: MAILBOX_ADDRESS,
				to: ["a@example.org", "b@example.org"],
				cc: ["c@example.org"],
				bcc: ["d@example.org"],
				replyTo: "reply@example.org",
				subject: "Hello",
				text: "Body.",
			};
			await sender.send(message);
			await sender.send({ from: MAILBOX_ADDRESS, to: "a@example.org", subject: "Hello", text: "Body." });
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(bodies[0]).toMatchObject({
			to: ["a@example.org", "b@example.org"],
			cc: ["c@example.org"],
			bcc: ["d@example.org"],
			replyTo: "reply@example.org",
		});
		// JSON.stringify drops undefined, so the worker never sees an empty key.
		expect(bodies[1]).not.toHaveProperty("cc");
		expect(bodies[1]).not.toHaveProperty("bcc");
		expect(bodies[1]).not.toHaveProperty("replyTo");
		expect(bodies[1].to).toBe("a@example.org");
	});
});

type SentMessage = {
	from: string;
	to: string | string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	headers?: Record<string, string>;
};

const stubEmail = {
	sent: [] as SentMessage[],
	async send(message: SentMessage) {
		stubEmail.sent.push(message);
		return { messageId: `<outbound-${stubEmail.sent.length}@${HOSTNAME}>` };
	},
};

function createEnv(): CloudflareEnv {
	return {
		DB: createDb(),
		BUCKET: {} as CloudflareEnv["BUCKET"],
		EMAIL: stubEmail as unknown as CloudflareEnv["EMAIL"],
		NODE_ENV: "test",
	} as CloudflareEnv;
}

async function seedMailbox(): Promise<void> {
	const db = createDb();
	await db.insert(users).values({
		id: "usr_cc",
		email: `owner@${HOSTNAME}`,
		passwordHash: "x",
		name: "Owner",
		role: "admin",
	});
	await db.insert(domains).values({
		id: "dom_cc",
		userId: "usr_cc",
		hostname: HOSTNAME,
		zoneId: "zone_cc",
		status: "active",
	});
	await db.insert(mailboxes).values({
		id: "mbx_cc",
		userId: "usr_cc",
		domainId: "dom_cc",
		localPart: "box",
		displayName: "Box",
		useAllDomains: false,
	});
}

describe.skipIf(!hasTestDatabase())("sendEmail with cc and bcc", () => {
	beforeEach(async () => {
		stubEmail.sent.length = 0;
		await seedMailbox();
	});

	it("stores the lists and passes them to the transport", async () => {
		const env = createEnv();
		await sendEmail(env, {
			userId: "usr_cc",
			mailboxId: "mbx_cc",
			from: MAILBOX_ADDRESS,
			to: ["first@example.org", "second@example.org"],
			cc: ["copied@example.org"],
			bcc: ["hidden@example.org"],
			subject: "Quarterly report",
			text: "Attached.",
		});

		expect(stubEmail.sent).toHaveLength(1);
		expect(stubEmail.sent[0].to).toEqual(["first@example.org", "second@example.org"]);
		expect(stubEmail.sent[0].cc).toEqual(["copied@example.org"]);
		expect(stubEmail.sent[0].bcc).toEqual(["hidden@example.org"]);

		const db = createDb();
		const [row] = await db.select().from(messages).where(eq(messages.direction, "outbound"));
		expect(row.toAddr).toBe("first@example.org, second@example.org");
		expect(row.ccAddr).toBe("copied@example.org");
		expect(row.bccAddr).toBe("hidden@example.org");
		expect(row.status).toBe("sent");
	});

	it("leaves cc_addr and bcc_addr null when there are none, and keeps `to` a plain string", async () => {
		const env = createEnv();
		await sendEmail(env, {
			userId: "usr_cc",
			mailboxId: "mbx_cc",
			from: MAILBOX_ADDRESS,
			to: "only@example.org",
			subject: "Ping",
			text: "Pong.",
		});

		expect(stubEmail.sent[0].to).toBe("only@example.org");
		expect(stubEmail.sent[0].cc).toBeUndefined();
		expect(stubEmail.sent[0].bcc).toBeUndefined();

		const db = createDb();
		const [row] = await db.select().from(messages).where(eq(messages.direction, "outbound"));
		expect(row.toAddr).toBe("only@example.org");
		expect(row.ccAddr).toBeNull();
		expect(row.bccAddr).toBeNull();
	});

	it("upserts a contact for every to, cc and bcc address", async () => {
		const env = createEnv();
		await sendEmail(env, {
			userId: "usr_cc",
			mailboxId: "mbx_cc",
			from: MAILBOX_ADDRESS,
			to: ["first@example.org", "FIRST@example.org"],
			cc: ["copied@example.org"],
			bcc: ["hidden@example.org"],
			subject: "Quarterly report",
			text: "Attached.",
		});

		const db = createDb();
		const rows = await db.select().from(contacts).where(eq(contacts.userId, "usr_cc"));
		expect(rows.map((row) => row.email).sort()).toEqual([
			"copied@example.org",
			"first@example.org",
			"hidden@example.org",
		]);
	});
});
