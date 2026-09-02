import {
	cfRequest,
	deleteEmailRoutingRule,
	listEmailRoutingRules,
} from "@/lib/cloudflare-api";
import type { CfEmailRoutingRule } from "@/lib/cloudflare-api.types";

function routesToDomain(ruleValue: string | undefined, hostname: string): boolean {
	if (!ruleValue) return false;

	const normalized = ruleValue.toLowerCase();
	return normalized === hostname || normalized.endsWith(`@${hostname}`);
}

export async function deleteEmailRoutingRulesForDomain(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
): Promise<void> {
	const normalizedHostname = hostname.toLowerCase();
	const rules = await listEmailRoutingRules(env, zoneId);
	const linkedRules = rules.filter((rule) =>
		rule.matchers?.some(
			(matcher) =>
				matcher.type === "literal" &&
				matcher.field === "to" &&
				routesToDomain(matcher.value, normalizedHostname),
		),
	);

	await Promise.all(
		linkedRules.map(async (rule) => {
			const ruleId = rule.id ?? rule.tag;
			if (!ruleId) return;

			await deleteEmailRoutingRule(env, zoneId, ruleId);
		}),
	);
}

/** The zone catch-all rule, or `null` when the zone has none. */
export async function getEmailRoutingCatchAllRule(
	env: CloudflareEnv,
	zoneId: string,
): Promise<CfEmailRoutingRule | null> {
	const rule = await cfRequest<CfEmailRoutingRule | null>(
		env,
		`/zones/${zoneId}/email/routing/rules/catch_all`,
	);
	return rule ?? null;
}

/** True when the catch-all rule is enabled and already delivers to `workerName`. */
export function catchAllRoutesToWorker(
	rule: CfEmailRoutingRule | null | undefined,
	workerName: string,
): boolean {
	if (!rule?.enabled) return false;
	return (
		rule.actions?.some(
			(action) =>
				action.type === "worker" &&
				(action.value?.length ? action.value.includes(workerName) : true),
		) ?? false
	);
}

/**
 * Puts the catch-all rule back the way it was. Compensating action for a
 * catch-all this process created; `previous` of `null` disables it again.
 */
export async function restoreEmailRoutingCatchAllRule(
	env: CloudflareEnv,
	zoneId: string,
	previous: CfEmailRoutingRule | null,
): Promise<void> {
	const body = previous
		? {
				actions: previous.actions ?? [{ type: "drop" }],
				enabled: previous.enabled ?? false,
				matchers: previous.matchers ?? [{ type: "all" }],
				name: previous.name ?? "Catch-all",
			}
		: {
				actions: [{ type: "drop" }],
				enabled: false,
				matchers: [{ type: "all" }],
				name: "Catch-all",
			};

	await cfRequest<CfEmailRoutingRule>(env, `/zones/${zoneId}/email/routing/rules/catch_all`, {
		method: "PUT",
		body: JSON.stringify(body),
	});
}
