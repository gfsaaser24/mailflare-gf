/**
 * T6.3 — the webhook retry worker.
 *
 * `webhook_deliveries` rows that failed stay `pending` with a `next_attempt_at`
 * in the future. `retryDueDeliveries` picks up the ones that are due, re-sends
 * them and reschedules or dead-letters them. Run it every minute from
 * `scripts/webhook-retry.ts`.
 *
 * Retrying is idempotent from our side: the same body and the same
 * `X-Mailflare-Delivery` id go out again, so a consumer can deduplicate on it.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { webhookDeliveries, webhooks } from "@/db/schema";
import { attemptDelivery, recordAttempt, type WebhookDeliveryStatus } from "./dispatch";

/** Rows processed per run, so one bad backlog cannot run for ever. */
export const RETRY_BATCH_SIZE = 200;

export type RetryOutcome = {
	deliveryId: string;
	webhookId: string;
	eventType: string;
	attempts: number;
	status: WebhookDeliveryStatus;
	error: string | null;
};

export type RetrySummary = {
	processed: number;
	delivered: number;
	rescheduled: number;
	dead: number;
	outcomes: RetryOutcome[];
};

/**
 * Re-sends one delivery whatever its schedule says. Returns `null` when the id
 * is unknown, already delivered, or its endpoint is gone.
 *
 * Used by the manual "Retry" button as well as by `retryDueDeliveries`.
 */
export async function retryDelivery(
	db: AppDatabase,
	deliveryId: string,
	now: Date = new Date(),
): Promise<RetryOutcome | null> {
	const [row] = await db
		.select({
			id: webhookDeliveries.id,
			webhookId: webhookDeliveries.webhookId,
			eventType: webhookDeliveries.eventType,
			payload: webhookDeliveries.payload,
			attempts: webhookDeliveries.attempts,
			url: webhooks.url,
			secret: webhooks.secret,
		})
		.from(webhookDeliveries)
		.innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
		.where(eq(webhookDeliveries.id, deliveryId))
		.limit(1);
	if (!row) return null;

	return runAttempt(db, row, now);
}

type DueRow = {
	id: string;
	webhookId: string;
	eventType: string;
	payload: string;
	attempts: number;
	url: string;
	secret: string;
};

async function runAttempt(db: AppDatabase, row: DueRow, now: Date): Promise<RetryOutcome> {
	const result = await attemptDelivery(
		{ id: row.webhookId, url: row.url, secret: row.secret },
		row.id,
		row.eventType,
		row.payload,
		now,
	);
	const attempts = row.attempts + 1;
	const status = await recordAttempt(db, row.id, attempts, result, now);
	return {
		deliveryId: row.id,
		webhookId: row.webhookId,
		eventType: row.eventType,
		attempts,
		status,
		error: result.error,
	};
}

/** How far into the future a claimed row is parked while it is being sent. */
const CLAIM_LEASE = sql`interval '5 minutes'`;

/** The snake_case shape `db.execute` gives back for the claim statement. */
type ClaimedRow = {
	id: string;
	webhook_id: string;
	event_type: string;
	payload: string;
	attempts: number;
};

/**
 * Takes the next batch of due deliveries *and* parks them, in one statement.
 *
 * `FOR UPDATE ... SKIP LOCKED` plus the `next_attempt_at` push means two cron
 * runs that overlap never pick the same row: the second run either blocks out
 * on the lock and skips it, or sees the row already parked five minutes out.
 * `recordAttempt` overwrites `next_attempt_at` again once the send finishes, so
 * the lease only ever applies while a run is in flight.
 */
async function claimDueDeliveries(db: AppDatabase, now: Date): Promise<ClaimedRow[]> {
	const rows = await db.execute(sql`
		UPDATE webhook_deliveries
		SET next_attempt_at = now() + ${CLAIM_LEASE}
		WHERE id IN (
			SELECT d.id
			FROM webhook_deliveries d
			INNER JOIN webhooks w ON w.id = d.webhook_id
			WHERE d.status = 'pending'
				AND d.next_attempt_at IS NOT NULL
				-- Bound as an ISO string: a raw \`sql\` fragment has no column to
				-- infer a Date encoder from.
				AND d.next_attempt_at <= ${now.toISOString()}::timestamptz
				-- A disabled endpoint stops receiving; its backlog waits for it.
				AND w.enabled = true
			ORDER BY d.next_attempt_at ASC
			LIMIT ${RETRY_BATCH_SIZE}
			FOR UPDATE OF d SKIP LOCKED
		)
		RETURNING id, webhook_id, event_type, payload, attempts
	`);
	return rows as unknown as ClaimedRow[];
}

/**
 * Processes every `pending` delivery whose `next_attempt_at` has passed.
 *
 * Rows with a null `next_attempt_at` are skipped: they are either brand new
 * (the immediate attempt is still running) or terminal.
 */
export async function retryDueDeliveries(
	env: CloudflareEnv,
	now: Date = new Date(),
): Promise<RetrySummary> {
	const db = getDb(env);

	const claimed = await claimDueDeliveries(db, now);
	const targets = claimed.length
		? await db
				.select({ id: webhooks.id, url: webhooks.url, secret: webhooks.secret })
				.from(webhooks)
				.where(inArray(webhooks.id, [...new Set(claimed.map((r) => r.webhook_id))]))
		: [];
	const targetById = new Map(targets.map((t) => [t.id, t]));

	const due: DueRow[] = [];
	for (const row of claimed) {
		const target = targetById.get(row.webhook_id);
		// The endpoint vanished between the claim and now; the row stays parked
		// and the next run re-evaluates it.
		if (!target) continue;
		due.push({
			id: row.id,
			webhookId: row.webhook_id,
			eventType: row.event_type,
			payload: row.payload,
			attempts: Number(row.attempts),
			url: target.url,
			secret: target.secret,
		});
	}

	const summary: RetrySummary = {
		processed: 0,
		delivered: 0,
		rescheduled: 0,
		dead: 0,
		outcomes: [],
	};

	for (const row of due) {
		const outcome = await runAttempt(db, row, now);
		summary.processed += 1;
		summary.outcomes.push(outcome);
		if (outcome.status === "delivered") summary.delivered += 1;
		else if (outcome.status === "dead") summary.dead += 1;
		else summary.rescheduled += 1;
	}

	return summary;
}
