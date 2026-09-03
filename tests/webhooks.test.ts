/**
 * T6.3 — webhook delivery, signing, retry backoff and dead-lettering.
 *
 * `global.fetch` is stubbed, so nothing leaves the process: every assertion is
 * about the request we *would* have sent and the `webhook_deliveries` row we
 * wrote afterwards.
 *
 * The new `webhook_deliveries` / `webhooks` columns are added with
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `beforeAll` rather than by a
 * generated migration: several agents are appending tables to
 * `src/db/schema/index.ts` at the same time, so `drizzle-kit generate` would
 * produce a migration full of other people's work. The columns below must end
 * up in the real migration when the schema is next generated.
 */
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	orgQuotas,
	orgUsage,
	organizations,
	users,
	webhookDeliveries,
	webhooks,
} from "@/db/schema";
import { reserveQuota, utcDayKey } from "@/lib/quotas/service";
import { emitWebhookEvent, MAX_ATTEMPTS } from "@/lib/webhooks/dispatch";
import { retryDueDeliveries } from "@/lib/webhooks/retry";
import { createDb, hasTestDatabase } from "./helpers/db";

const ORG_A = "org_wh_a";
const ORG_B = "org_wh_b";
const USER_A = "usr_wh_a";
const USER_B = "usr_wh_b";
const HOOK_A = "wh_wh_a";
const HOOK_B = "wh_wh_b";
const HOOK_A_URL = "https://org-a.test/hook";
const HOOK_B_URL = "https://org-b.test/hook";
const SECRET_A = "whsec_org_a";

const ALL_EVENTS = JSON.stringify([
	"message.inbound",
	"message.outbound",
	"conversation.assigned",
	"conversation.note",
	"quota.warning",
]);

/** Columns T6.3 adds; see the file header for why they are applied here. */
async function addT63Columns(): Promise<void> {
	const db = createDb();
	await db.execute(sql`ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS description text;`);
	await db.execute(
		sql`ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;`,
	);
	await db.execute(sql`ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS last_error text;`);
	await db.execute(
		sql`ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS response_status integer;`,
	);
	await db.execute(
		sql`ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS delivered_at timestamptz;`,
	);
}

async function seed(): Promise<void> {
	const db = createDb();

	await db.insert(organizations).values([
		{ id: ORG_A, name: "Org A", slug: "wh-org-a", status: "active" },
		{ id: ORG_B, name: "Org B", slug: "wh-org-b", status: "active" },
	]);

	await db.insert(users).values([
		{
			id: USER_A,
			organizationId: ORG_A,
			email: "a@wh-a.test",
			passwordHash: "x",
			name: "A",
			role: "admin",
		},
		{
			id: USER_B,
			organizationId: ORG_B,
			email: "b@wh-b.test",
			passwordHash: "x",
			name: "B",
			role: "admin",
		},
	]);

	await db.insert(webhooks).values([
		{
			id: HOOK_A,
			organizationId: ORG_A,
			userId: USER_A,
			url: HOOK_A_URL,
			secret: SECRET_A,
			events: ALL_EVENTS,
			enabled: true,
		},
		{
			id: HOOK_B,
			organizationId: ORG_B,
			userId: USER_B,
			url: HOOK_B_URL,
			secret: "whsec_org_b",
			events: ALL_EVENTS,
			enabled: true,
		},
	]);
}

/** A stub `fetch` that answers every call with the same status. */
function respondWith(status: number) {
	return vi.fn(
		async (_input: unknown, _init?: RequestInit) =>
			new Response(status === 204 ? null : `body ${status}`, { status }),
	);
}

function fetchMock() {
	return global.fetch as unknown as ReturnType<typeof respondWith>;
}

/** The headers of call `index`, lower-cased. */
function headersOf(index: number): Record<string, string> {
	const init = fetchMock().mock.calls[index]?.[1] as RequestInit | undefined;
	const raw = (init?.headers ?? {}) as Record<string, string>;
	return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
}

function bodyOf(index: number): string {
	const init = fetchMock().mock.calls[index]?.[1] as RequestInit | undefined;
	return String(init?.body ?? "");
}

function urlOf(index: number): string {
	return String(fetchMock().mock.calls[index]?.[0]);
}

async function deliveryRow(id: string) {
	const [row] = await createDb()
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.id, id))
		.limit(1);
	return row;
}

/** Pretends the delivery's backoff has elapsed. */
async function makeDue(id: string): Promise<void> {
	await createDb()
		.update(webhookDeliveries)
		.set({ nextAttemptAt: new Date(Date.now() - 1000) })
		.where(eq(webhookDeliveries.id, id));
}

const INBOUND = {
	messageId: "msg_1",
	mailboxId: "mbx_1",
	from: "sender@example.test",
	to: "team@org-a.test",
	subject: "Hello",
};

describe.skipIf(!hasTestDatabase())("webhooks (T6.3)", () => {
	beforeAll(async () => {
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		await addT63Columns();
	});

	beforeEach(async () => {
		vi.stubGlobal("fetch", respondWith(200));
		await addT63Columns();
		await seed();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("signs the body with the timestamp and the endpoint secret", async () => {
		const db = createDb();
		const [deliveryId] = await emitWebhookEvent(db, {
			orgId: ORG_A,
			userId: USER_A,
			type: "message.inbound",
			data: INBOUND,
		});

		expect(fetchMock()).toHaveBeenCalledTimes(1);
		const headers = headersOf(0);
		const body = bodyOf(0);

		expect(urlOf(0)).toBe(HOOK_A_URL);
		expect(headers["x-mailflare-event"]).toBe("message.inbound");
		expect(headers["x-mailflare-delivery"]).toBe(deliveryId);

		const timestamp = headers["x-mailflare-timestamp"];
		expect(timestamp).toMatch(/^\d+$/);

		const expected =
			"sha256=" +
			createHmac("sha256", SECRET_A).update(`${timestamp}.${body}`).digest("hex");
		expect(headers["x-mailflare-signature"]).toBe(expected);

		// A body that was tampered with must not verify against the same header.
		const tampered =
			"sha256=" +
			createHmac("sha256", SECRET_A).update(`${timestamp}.${body}x`).digest("hex");
		expect(headers["x-mailflare-signature"]).not.toBe(tampered);

		expect(JSON.parse(body)).toEqual({ type: "message.inbound", data: INBOUND });
	});

	it("marks the delivery delivered on a 2xx", async () => {
		const db = createDb();
		const [deliveryId] = await emitWebhookEvent(db, {
			orgId: ORG_A,
			userId: USER_A,
			type: "message.inbound",
			data: INBOUND,
		});

		const row = await deliveryRow(deliveryId);
		expect(row?.status).toBe("delivered");
		expect(row?.attempts).toBe(1);
		expect(row?.responseStatus).toBe(200);
		expect(row?.deliveredAt).not.toBeNull();
		expect(row?.nextAttemptAt).toBeNull();
		expect(row?.lastError).toBeNull();
	});

	it("schedules the first retry a minute out on a 500", async () => {
		vi.stubGlobal("fetch", respondWith(500));
		const before = Date.now();

		const db = createDb();
		const [deliveryId] = await emitWebhookEvent(db, {
			orgId: ORG_A,
			userId: USER_A,
			type: "message.inbound",
			data: INBOUND,
		});

		const row = await deliveryRow(deliveryId);
		expect(row?.status).toBe("pending");
		expect(row?.attempts).toBe(1);
		expect(row?.responseStatus).toBe(500);
		expect(row?.lastError).toContain("HTTP 500");
		expect(row?.deliveredAt).toBeNull();

		const next = row?.nextAttemptAt?.getTime() ?? 0;
		// ~ +1 minute, with a generous window for a slow database round trip.
		expect(next - before).toBeGreaterThan(55_000);
		expect(next - before).toBeLessThan(75_000);
	});

	it("retryDueDeliveries only re-sends rows whose next attempt is due", async () => {
		vi.stubGlobal("fetch", respondWith(500));
		const db = createDb();

		const [dueId] = await emitWebhookEvent(db, {
			orgId: ORG_A,
			userId: USER_A,
			type: "message.inbound",
			data: { ...INBOUND, messageId: "msg_due" },
		});
		const [notDueId] = await emitWebhookEvent(db, {
			orgId: ORG_A,
			userId: USER_A,
			type: "message.inbound",
			data: { ...INBOUND, messageId: "msg_not_due" },
		});
		expect(fetchMock()).toHaveBeenCalledTimes(2);

		await makeDue(dueId);

		vi.stubGlobal("fetch", respondWith(200));
		const summary = await retryDueDeliveries({ DB: db } as unknown as CloudflareEnv);

		expect(summary.processed).toBe(1);
		expect(summary.delivered).toBe(1);
		expect(fetchMock()).toHaveBeenCalledTimes(1);
		expect(JSON.parse(bodyOf(0)).data.messageId).toBe("msg_due");

		expect((await deliveryRow(dueId))?.status).toBe("delivered");
		const untouched = await deliveryRow(notDueId);
		expect(untouched?.status).toBe("pending");
		expect(untouched?.attempts).toBe(1);
	});

	it("two overlapping retry runs deliver each due row exactly once", async () => {
		vi.stubGlobal("fetch", respondWith(500));
		const db = createDb();

		// Six pending rows, all due: enough for both runs to reach for the batch.
		const dueIds: string[] = [];
		for (let i = 0; i < 6; i += 1) {
			const [id] = await emitWebhookEvent(db, {
				orgId: ORG_A,
				userId: USER_A,
				type: "message.inbound",
				data: { ...INBOUND, messageId: `msg_concurrent_${i}` },
			});
			if (id) dueIds.push(id);
		}
		expect(dueIds).toHaveLength(6);
		for (const id of dueIds) await makeDue(id);

		vi.stubGlobal("fetch", respondWith(200));
		const env = { DB: db } as unknown as CloudflareEnv;
		const [first, second] = await Promise.all([
			retryDueDeliveries(env),
			retryDueDeliveries(env),
		]);

		// Every row was claimed by exactly one of the two runs.
		expect(first.processed + second.processed).toBe(dueIds.length);
		expect(fetchMock()).toHaveBeenCalledTimes(dueIds.length);

		const sent = fetchMock().mock.calls.map(
			(_call, index) => headersOf(index)["x-mailflare-delivery"],
		);
		expect(sent.every((id) => urlOf(sent.indexOf(id)) === HOOK_A_URL)).toBe(true);
		for (const id of dueIds) {
			expect(sent.filter((seen) => seen === id)).toHaveLength(1);
			const row = await deliveryRow(id);
			expect(row?.status).toBe("delivered");
			expect(row?.attempts).toBe(2);
		}
	});

	it("dead-letters a delivery after three failed attempts", async () => {
		vi.stubGlobal("fetch", respondWith(500));
		const db = createDb();
		const env = { DB: db } as unknown as CloudflareEnv;

		const [deliveryId] = await emitWebhookEvent(db, {
			orgId: ORG_A,
			userId: USER_A,
			type: "message.inbound",
			data: INBOUND,
		});
		expect((await deliveryRow(deliveryId))?.attempts).toBe(1);

		await makeDue(deliveryId);
		await retryDueDeliveries(env);
		const afterSecond = await deliveryRow(deliveryId);
		expect(afterSecond?.attempts).toBe(2);
		expect(afterSecond?.status).toBe("pending");

		await makeDue(deliveryId);
		const summary = await retryDueDeliveries(env);
		const afterThird = await deliveryRow(deliveryId);
		expect(afterThird?.attempts).toBe(MAX_ATTEMPTS);
		expect(afterThird?.status).toBe("dead");
		expect(afterThird?.nextAttemptAt).toBeNull();
		expect(summary.dead).toBe(1);

		// A dead row is never picked up again.
		await retryDueDeliveries(env);
		expect(fetchMock()).toHaveBeenCalledTimes(3);
	});

	it("never delivers an org A event to an org B endpoint", async () => {
		const db = createDb();
		await emitWebhookEvent(db, {
			orgId: ORG_A,
			userId: USER_A,
			type: "conversation.assigned",
			data: {
				conversationId: "cnv_a",
				assignedUserId: USER_A,
				subject: "Org A only",
				status: "open",
			},
		});

		expect(fetchMock()).toHaveBeenCalledTimes(1);
		expect(urlOf(0)).toBe(HOOK_A_URL);

		const calledUrls = fetchMock().mock.calls.map((call) => String(call[0]));
		expect(calledUrls).not.toContain(HOOK_B_URL);

		const rows = await db
			.select({ webhookId: webhookDeliveries.webhookId })
			.from(webhookDeliveries);
		expect(rows.map((r) => r.webhookId)).toEqual([HOOK_A]);
	});

	it("fires quota.warning once when usage crosses 80% of a limit", async () => {
		const db = createDb();

		await db.insert(orgQuotas).values({ organizationId: ORG_A, maxMailboxes: 10 });
		await db.insert(orgUsage).values({
			organizationId: ORG_A,
			mailboxes: 7,
			dayKey: utcDayKey(),
			updatedAt: new Date(),
		});
		// 7 -> 8 of 10 crosses the threshold.
		await reserveQuota(db, ORG_A, { mailboxes: 1 });
		// 8 -> 9 is already above it, so it must stay quiet.
		await reserveQuota(db, ORG_A, { mailboxes: 1 });

		const warnings = await db
			.select()
			.from(webhookDeliveries)
			.where(
				and(
					eq(webhookDeliveries.eventType, "quota.warning"),
					eq(webhookDeliveries.webhookId, HOOK_A),
				),
			);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.webhookId).toBe(HOOK_A);
		const payload = JSON.parse(warnings[0]?.payload ?? "{}");
		expect(payload.type).toBe("quota.warning");
		expect(payload.data).toMatchObject({
			organizationId: ORG_A,
			kind: "mailboxes",
			limit: 10,
			current: 8,
			usage: 0.8,
			threshold: 0.8,
		});
	});
});
