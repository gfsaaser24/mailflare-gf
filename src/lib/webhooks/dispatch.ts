/**
 * T6.3 — webhook delivery.
 *
 * One event fans out to every enabled webhook of the organisation that is
 * subscribed to it. Each fan-out leg gets its own `webhook_deliveries` row so a
 * failure to one endpoint never hides a success to another.
 *
 * The wire format:
 *
 *   POST <webhook.url>
 *   Content-Type: application/json
 *   X-Mailflare-Event: conversation.assigned
 *   X-Mailflare-Delivery: <webhook_deliveries.id>
 *   X-Mailflare-Timestamp: <unix seconds>
 *   X-Mailflare-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>
 *
 *   {"type":"conversation.assigned","data":{...}}
 *
 * The timestamp is inside the signed string, so a captured request cannot be
 * replayed with a fresh timestamp. Consumers should reject anything older than
 * a few minutes. Legacy `X-Email-Platform-*` headers are still sent for
 * consumers written against the pre-T6.3 format.
 *
 * Retry: a non-2xx response or a transport error bumps `attempts` and parks the
 * row at `next_attempt_at` (see `./retry`). After `MAX_ATTEMPTS` the row is
 * dead-lettered (`status = 'dead'`) and shows up in the admin UI.
 */
import { and, eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { users, webhookDeliveries, webhooks } from "@/db/schema";
import { sanitizeHtmlFields } from "@/lib/email/sanitize";
import { newId } from "@/lib/ids";
import {
	parseSubscribedEvents,
	type WebhookEventPayloads,
	type WebhookEventType,
} from "./events";

/** How long one attempt may take before it counts as a failure. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Backoff between attempts, indexed by the number of attempts already made.
 * Attempt 1 fails -> retry in 1m, attempt 2 -> 10m, attempt 3 -> 1h.
 */
export const RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000] as const;

/**
 * Attempts before the delivery is dead-lettered. The third failure ends it, so
 * the 1h slot above only comes into play if this is raised.
 */
export const MAX_ATTEMPTS = 3;

export type WebhookDeliveryStatus = "pending" | "delivered" | "dead";

/** The endpoint fields an attempt needs. */
export type WebhookTarget = {
	id: string;
	url: string;
	secret: string;
};

/** What one HTTP attempt produced. */
export type AttemptResult = {
	ok: boolean;
	responseStatus: number | null;
	error: string | null;
};

/** `sha256=<hex>` over `timestamp + "." + body`. */
export async function signWebhookPayload(
	secret: string,
	timestamp: string,
	body: string,
): Promise<string> {
	const hex = await hmacHex(secret, `${timestamp}.${body}`);
	return `sha256=${hex}`;
}

/** Legacy signature: bare hex HMAC over the body alone. */
export async function signPayload(secret: string, body: string): Promise<string> {
	return hmacHex(secret, body);
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Trims an error/body string so one bad endpoint cannot bloat the table. */
function truncateError(value: string): string {
	return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

/**
 * Sends one delivery. Never throws: a transport failure comes back as
 * `{ ok: false, responseStatus: null, error }`.
 */
export async function attemptDelivery(
	target: WebhookTarget,
	deliveryId: string,
	eventType: string,
	body: string,
	now: Date = new Date(),
): Promise<AttemptResult> {
	const timestamp = String(Math.floor(now.getTime() / 1000));
	try {
		const signature = await signWebhookPayload(target.secret, timestamp, body);
		const res = await fetch(target.url, {
			method: "POST",
			redirect: "manual",
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
			headers: {
				"Content-Type": "application/json",
				"X-Mailflare-Event": eventType,
				"X-Mailflare-Delivery": deliveryId,
				"X-Mailflare-Timestamp": timestamp,
				"X-Mailflare-Signature": signature,
				// Pre-T6.3 consumers.
				"X-Email-Platform-Event": eventType,
				"X-Email-Platform-Signature": await signPayload(target.secret, body),
			},
			body,
		});
		if (res.ok) return { ok: true, responseStatus: res.status, error: null };
		let detail = "";
		try {
			detail = truncateError((await res.text()).trim());
		} catch {
			detail = "";
		}
		return {
			ok: false,
			responseStatus: res.status,
			error: truncateError(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, responseStatus: null, error: truncateError(message) };
	}
}

/**
 * Writes the outcome of an attempt back to the delivery row.
 *
 * `attempts` is the count *including* the attempt just made, so the caller does
 * not have to re-read the row.
 */
export async function recordAttempt(
	db: AppDatabase,
	deliveryId: string,
	attempts: number,
	result: AttemptResult,
	now: Date = new Date(),
): Promise<WebhookDeliveryStatus> {
	if (result.ok) {
		await db
			.update(webhookDeliveries)
			.set({
				status: "delivered",
				attempts,
				deliveredAt: now,
				nextAttemptAt: null,
				lastError: null,
				responseStatus: result.responseStatus,
			})
			.where(eq(webhookDeliveries.id, deliveryId));
		return "delivered";
	}

	const exhausted = attempts >= MAX_ATTEMPTS;
	const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
	await db
		.update(webhookDeliveries)
		.set({
			status: exhausted ? "dead" : "pending",
			attempts,
			nextAttemptAt: exhausted ? null : new Date(now.getTime() + delay),
			lastError: result.error,
			responseStatus: result.responseStatus,
		})
		.where(eq(webhookDeliveries.id, deliveryId));
	return exhausted ? "dead" : "pending";
}

export type EmitInput<E extends WebhookEventType = WebhookEventType> = {
	/** The organisation the event belongs to. Never crossed. */
	orgId: string;
	/**
	 * Restrict the fan-out to one user's endpoints. Message events use this
	 * (they belong to a mailbox owner); org-wide events leave it out.
	 */
	userId?: string | null;
	type: E;
	data: WebhookEventPayloads[E] | Record<string, unknown>;
};

/**
 * Fans one event out. Returns the delivery ids that were created, in order.
 *
 * Takes a database rather than an `AppEnv` so service-layer code (which only
 * ever has a `db`) can emit without reaching for the environment.
 */
export async function emitWebhookEvent(
	db: AppDatabase,
	input: EmitInput,
): Promise<string[]> {
	const filters = [eq(webhooks.organizationId, input.orgId)];
	if (input.userId) filters.push(eq(webhooks.userId, input.userId));
	const hooks = await db
		.select()
		.from(webhooks)
		.where(and(...filters));

	// Consumers render whatever we hand them, so HTML in the payload goes out
	// sanitised; everything else is plain text.
	const safePayload = sanitizeHtmlFields(input.data as Record<string, unknown>);
	const body = JSON.stringify({ type: input.type, data: safePayload });
	const created: string[] = [];

	for (const hook of hooks) {
		if (!hook.enabled) continue;
		if (!parseSubscribedEvents(hook.events).includes(input.type)) continue;

		const deliveryId = newId("whd");
		const now = new Date();
		await db.insert(webhookDeliveries).values({
			id: deliveryId,
			webhookId: hook.id,
			eventType: input.type,
			payload: body,
			status: "pending",
			attempts: 0,
		});
		created.push(deliveryId);

		const result = await attemptDelivery(hook, deliveryId, input.type, body, now);
		await recordAttempt(db, deliveryId, 1, result, now);
	}

	return created;
}

/**
 * The pre-T6.3 entry point, kept so `inbound.ts` / `send.ts` compile unchanged.
 *
 * `orgId` is the organisation the message belongs to. When it is omitted it is
 * resolved from the user's own organisation, so the org filter is never
 * silently skipped; a webhook row from another organisation is never dispatched
 * to.
 */
export async function dispatchWebhooks(
	env: CloudflareEnv,
	userId: string,
	eventType: WebhookEventType,
	payload: Record<string, unknown>,
	orgId?: string,
): Promise<void> {
	const db = getDb(env);

	let organizationId = orgId;
	if (!organizationId) {
		const [owner] = await db
			.select({ organizationId: users.organizationId })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		organizationId = owner?.organizationId;
	}
	if (!organizationId) return;

	await emitWebhookEvent(db, { orgId: organizationId, userId, type: eventType, data: payload });
}
