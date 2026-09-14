import type { CfDnsRecord, CfEmailRoutingRule, CfResponse } from "@/lib/cloudflare-api.types";
import {
	formatCloudflareError,
	getCloudflareAuth,
	getCloudflareAuthHeaders,
	getCloudflareAuthHint,
	getEmailWorkerName,
} from "@/lib/cloudflare-api-utils";
import { getZoneLookupCandidates } from "@/lib/domains/utils";
export type { CfDnsRecord } from "@/lib/cloudflare-api.types";

/** A Cloudflare API response with `success: false`; `codes` are Cloudflare's own error codes. */
export class CloudflareApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly codes: number[],
	) {
		super(message);
		this.name = "CloudflareApiError";
	}
}

export async function cfRequest<T>(
	env: CloudflareEnv,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const auth = getCloudflareAuth(env);
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			...getCloudflareAuthHeaders(auth),
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const json = (await res.json()) as CfResponse<T>;

	if (!json.success) {
		throw new CloudflareApiError(
			`${formatCloudflareError(path, res.status, res.statusText, json.errors ?? [])}${getCloudflareAuthHint(json.errors ?? [])}`,
			res.status,
			(json.errors ?? []).map((error) => error.code).filter((code): code is number => typeof code === "number"),
		);
	}
	return json.result;
}

export async function findZoneByHostname(
	env: CloudflareEnv,
	hostname: string,
): Promise<{ id: string; name: string } | null> {
	for (const candidate of getZoneLookupCandidates(hostname)) {
		const zones = await cfRequest<{ id: string; name: string }[]>(
			env,
			`/zones?name=${encodeURIComponent(candidate)}&status=active`,
		);
		const zone = zones.find((z) => z.name === candidate);
		if (zone) return zone;
	}

	return null;
}

export async function getEmailRoutingDns(
	env: CloudflareEnv,
	zoneId: string,
): Promise<{ records: CfDnsRecord[]; missing: CfDnsRecord[] }> {
	// Cloudflare returns two shapes here: once routing is configured, a flat array of the
	// live records; before that, { record: [...expected], errors: [{ missing }] }.
	const result = await cfRequest<
		| CfDnsRecord[]
		| { record?: CfDnsRecord[]; errors?: { missing?: CfDnsRecord }[] }
	>(env, `/zones/${zoneId}/email/routing/dns`);
	if (Array.isArray(result)) {
		return { records: result, missing: [] };
	}
	return {
		records: result.record ?? [],
		missing: (result.errors ?? [])
			.map((e) => e.missing)
			.filter(Boolean) as CfDnsRecord[],
	};
}

export async function enableEmailRouting(
	env: CloudflareEnv,
	zoneId: string,
	hostname?: string,
) {
	return cfRequest<{ status?: string; enabled?: boolean }>(
		env,
		`/zones/${zoneId}/email/routing/dns`,
		{
			method: "POST",
			...(hostname ? { body: JSON.stringify({ name: hostname }) } : {}),
		},
	);
}

export async function disableEmailRouting(env: CloudflareEnv, zoneId: string) {
	return cfRequest<unknown>(env, `/zones/${zoneId}/email/routing/dns`, {
		method: "DELETE",
	});
}

export async function listSendingSubdomains(
	env: CloudflareEnv,
	zoneId: string,
) {
	return cfRequest<{ tag: string; name: string; enabled: boolean }[]>(
		env,
		`/zones/${zoneId}/email/sending/subdomains`,
	);
}

export async function createSendingSubdomain(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
) {
	return cfRequest<{ tag: string; name: string; enabled: boolean }>(
		env,
		`/zones/${zoneId}/email/sending/subdomains`,
		{
			method: "POST",
			body: JSON.stringify({ name: hostname }),
		},
	);
}

export async function deleteSendingSubdomain(
	env: CloudflareEnv,
	zoneId: string,
	subdomainTag: string,
) {
	return cfRequest<unknown>(
		env,
		`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}`,
		{ method: "DELETE" },
	);
}

/**
 * Asks Cloudflare to publish the MX/SPF/DKIM/DMARC records of a sending domain in the
 * zone ("Fix sending subdomain DNS records"). Cloudflare only adds what is missing.
 */
export async function fixSendingSubdomainDns(
	env: CloudflareEnv,
	zoneId: string,
	subdomainTag: string,
): Promise<{ records?: CfDnsRecord[]; errors?: unknown[]; status?: string }> {
	return cfRequest<{ records?: CfDnsRecord[]; errors?: unknown[]; status?: string }>(
		env,
		`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}/dns`,
		{ method: "POST" },
	);
}

export async function getSendingSubdomainDns(
	env: CloudflareEnv,
	zoneId: string,
	subdomainTag: string,
): Promise<CfDnsRecord[]> {
	return cfRequest<CfDnsRecord[]>(
		env,
		`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}/dns`,
	);
}

export async function getEmailRoutingSettings(
	env: CloudflareEnv,
	zoneId: string,
) {
	return cfRequest<{ enabled?: boolean; status?: string; name?: string }>(
		env,
		`/zones/${zoneId}/email/routing`,
	);
}

/** Every routing rule on the zone. Cloudflare pages this list, so walk it to the end. */
export async function listEmailRoutingRules(env: CloudflareEnv, zoneId: string) {
	const perPage = 50;
	const rules: CfEmailRoutingRule[] = [];
	for (let page = 1; ; page += 1) {
		const batch = await cfRequest<CfEmailRoutingRule[]>(
			env,
			`/zones/${zoneId}/email/routing/rules?per_page=${perPage}&page=${page}`,
		);
		rules.push(...batch);
		if (batch.length < perPage) return rules;
	}
}

export async function deleteEmailRoutingRule(
	env: CloudflareEnv,
	zoneId: string,
	ruleId: string,
) {
	return cfRequest<unknown>(
		env,
		`/zones/${zoneId}/email/routing/rules/${ruleId}`,
		{ method: "DELETE" },
	);
}

export async function createEmailRoutingRuleToWorker(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
) {
	const workerName = getEmailWorkerName(env);
	return cfRequest<CfEmailRoutingRule>(
		env,
		`/zones/${zoneId}/email/routing/rules`,
		{
			method: "POST",
			body: JSON.stringify({
				actions: [{ type: "worker", value: [workerName] }],
				enabled: true,
				matchers: [{ type: "literal", field: "to", value: address }],
				name: `Route ${address} to ${workerName}`,
			}),
		},
	);
}

/** Cloudflare error code for "a rule with this matcher already exists" (409). */
const CF_DUPLICATE_RULE_CODE = 2014;

function ruleMatchesAddress(rule: CfEmailRoutingRule, address: string): boolean {
	return Boolean(
		rule.matchers?.some(
			(matcher) =>
				matcher.type === "literal" && matcher.field === "to" && matcher.value?.toLowerCase() === address,
		),
	);
}

function ruleSendsToWorker(rule: CfEmailRoutingRule, workerName: string): boolean {
	return Boolean(
		rule.actions?.some(
			(action) =>
				action.type === "worker" && (action.value?.length ? action.value.includes(workerName) : true),
		),
	);
}

/**
 * Make sure mail for `address` reaches our worker. Cloudflare allows exactly one rule per
 * literal address, so any rule already matching it — a hand-made forward, a rule aimed at
 * another worker, a disabled one — is taken over rather than duplicated (which is a 409).
 */
export async function ensureEmailRoutingRuleToWorker(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
) {
	const normalized = address.toLowerCase();
	const workerName = getEmailWorkerName(env);

	const takeOver = (existing: CfEmailRoutingRule & { id: string }) =>
		cfRequest<CfEmailRoutingRule>(env, `/zones/${zoneId}/email/routing/rules/${existing.id}`, {
			method: "PUT",
			body: JSON.stringify({
				actions: [{ type: "worker", value: [workerName] }],
				enabled: true,
				matchers: [{ type: "literal", field: "to", value: normalized }],
				name: `Route ${normalized} to ${workerName}`,
				priority: existing.priority,
			}),
		});

	const findExisting = async () => {
		const rules = await listEmailRoutingRules(env, zoneId);
		return rules.find(
			(rule): rule is CfEmailRoutingRule & { id: string } =>
				Boolean(rule.id) && ruleMatchesAddress(rule, normalized),
		);
	};

	const existing = await findExisting();
	if (existing) {
		if (existing.enabled && ruleSendsToWorker(existing, workerName)) return existing;
		return takeOver(existing);
	}

	try {
		return await createEmailRoutingRuleToWorker(env, zoneId, normalized);
	} catch (error) {
		// Created between our list and our POST, or by a client the list never showed.
		if (!(error instanceof CloudflareApiError) || !error.codes.includes(CF_DUPLICATE_RULE_CODE)) throw error;
		const raced = await findExisting();
		if (!raced) throw error;
		if (raced.enabled && ruleSendsToWorker(raced, workerName)) return raced;
		return takeOver(raced);
	}
}
