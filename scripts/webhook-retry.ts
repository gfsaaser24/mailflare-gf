/**
 * Re-sends every `webhook_deliveries` row that is `pending` and whose
 * `next_attempt_at` has passed, then reschedules or dead-letters it.
 *
 * Run it:
 *
 *   npx tsx scripts/webhook-retry.ts
 *
 * `tsx` is present in node_modules/.bin (it ships as a transitive dependency),
 * so `npx` resolves it locally without a network fetch. There is deliberately
 * no `npm run` alias for it.
 *
 * It needs the same environment as the app (`DATABASE_URL`). The backoff steps
 * are 1m / 10m / 1h, so this is meant to run every minute from cron or as a
 * Coolify scheduled task:
 *
 *   * * * * *  cd /app && npx tsx scripts/webhook-retry.ts
 *
 * One run processes at most `RETRY_BATCH_SIZE` rows; a backlog drains over the
 * following minutes. Exit code 0 when every due delivery was attempted, 1 when
 * any of them ended up dead-lettered on this run.
 */
import { getEnv } from "@/lib/env";
import { retryDueDeliveries } from "@/lib/webhooks/retry";

async function main(): Promise<number> {
	const env = getEnv();
	const summary = await retryDueDeliveries(env);

	for (const outcome of summary.outcomes) {
		const reason = outcome.error ? ` - ${outcome.error}` : "";
		console.log(
			`${outcome.deliveryId} ${outcome.eventType} -> ${outcome.status} ` +
				`(attempt ${outcome.attempts})${reason}`,
		);
	}

	console.log(
		`processed ${summary.processed} delivery(ies): ` +
			`${summary.delivered} delivered, ${summary.rescheduled} rescheduled, ` +
			`${summary.dead} dead-lettered`,
	);

	return summary.dead > 0 ? 1 : 0;
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
