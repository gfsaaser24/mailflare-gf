/**
 * Re-checks every domain against live Cloudflare state and rewrites
 * `domains.status` / `status_reason` / `dns_ok` / `last_checked_at`.
 *
 * Run it:
 *
 *   npx tsx scripts/reconcile-domains.ts
 *
 * `tsx` is present in node_modules/.bin (it ships as a transitive dependency),
 * so `npx` resolves it locally without a network fetch. There is deliberately
 * no `npm run` alias for it.
 *
 * It needs the same environment as the app (`DATABASE_URL`, `CF_TOKEN` or
 * `CF_API_KEY` + `CF_EMAIL`, `CF_EMAIL_WORKER_NAME`). On the box this is meant
 * to run daily from cron or as a Coolify scheduled task:
 *
 *   0 6 * * *  cd /app && npx tsx scripts/reconcile-domains.ts
 *
 * Exit code 0 when every domain was checked, 1 when any domain failed.
 */
import { getEnv } from "@/lib/env";
import { reconcileAllDomains } from "@/lib/domains/status";

async function main(): Promise<number> {
	const env = getEnv();
	const { results, failures } = await reconcileAllDomains(env);

	for (const result of results) {
		const reason = result.statusReason ? ` - ${result.statusReason}` : "";
		const changed = result.changed ? " (changed)" : "";
		console.log(`${result.hostname}: ${result.status}${changed}${reason}`);
	}
	for (const failure of failures) {
		console.error(`${failure.domainId}: reconcile failed - ${failure.error}`);
	}

	const counts = results.reduce<Record<string, number>>((acc, result) => {
		acc[result.status] = (acc[result.status] ?? 0) + 1;
		return acc;
	}, {});
	console.log(
		`checked ${results.length} domain(s): ` +
			`${counts.active ?? 0} active, ${counts.error ?? 0} error, ${counts.pending ?? 0} pending, ` +
			`${failures.length} failed`,
	);

	return failures.length > 0 ? 1 : 0;
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
