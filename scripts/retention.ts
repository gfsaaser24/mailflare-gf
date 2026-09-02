/**
 * Applies every organisation's retention windows (T5.2): trashed messages past
 * their window are deleted for good (rows, raw object, attachments, and the
 * bytes are returned to `org_usage.storage_bytes`), and expired sessions,
 * webhook deliveries, auto-reply records, outbound jobs, old audit logs and
 * resolved inbound failures are removed.
 *
 * Run it:
 *
 *   npx tsx scripts/retention.ts
 *
 * `tsx` is present in node_modules/.bin (it ships as a transitive dependency),
 * so `npx` resolves it locally without a network fetch. There is deliberately
 * no `npm run` alias for it.
 *
 * It needs the same environment as the app (`DATABASE_URL` and the
 * `STORAGE_*` values, so the objects can actually be removed). On the box this
 * is meant to run daily from cron or as a Coolify scheduled task:
 *
 *   30 3 * * *  cd /app && npx tsx scripts/retention.ts
 *
 * Exit code 0 when every organisation was swept, 1 when any organisation failed.
 */
import { getEnv } from "@/lib/env";
import { runRetention } from "@/lib/retention/service";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main(): Promise<number> {
	const env = getEnv();
	const { results, failures } = await runRetention(env);

	const totals = {
		messages: 0,
		objects: 0,
		bytes: 0,
		sessions: 0,
		webhookDeliveries: 0,
		autoReplyDeliveries: 0,
		outboundJobs: 0,
		auditLogs: 0,
		inboundFailures: 0,
	};

	for (const result of results) {
		totals.messages += result.messages;
		totals.objects += result.objects;
		totals.bytes += result.bytes;
		totals.sessions += result.sessions;
		totals.webhookDeliveries += result.webhookDeliveries;
		totals.autoReplyDeliveries += result.autoReplyDeliveries;
		totals.outboundJobs += result.outboundJobs;
		totals.auditLogs += result.auditLogs;
		totals.inboundFailures += result.inboundFailures;

		console.log(
			`${result.organizationId}: ${result.messages} message(s) (${result.objects} object(s), ` +
				`${formatBytes(result.bytes)} reclaimed), ${result.sessions} session(s), ` +
				`${result.webhookDeliveries} webhook delivery(ies), ` +
				`${result.autoReplyDeliveries} auto-reply record(s), ` +
				`${result.outboundJobs} outbound job(s), ${result.auditLogs} audit log(s), ` +
				`${result.inboundFailures} inbound failure(s)`,
		);
	}
	for (const failure of failures) {
		console.error(`${failure.organizationId}: retention failed - ${failure.error}`);
	}

	console.log(
		`swept ${results.length} organisation(s): ${totals.messages} message(s), ` +
			`${totals.objects} object(s), ${formatBytes(totals.bytes)} reclaimed, ` +
			`${totals.sessions + totals.webhookDeliveries + totals.autoReplyDeliveries + totals.outboundJobs + totals.auditLogs + totals.inboundFailures} ` +
			`other row(s), ${failures.length} failed`,
	);

	return failures.length > 0 ? 1 : 0;
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
