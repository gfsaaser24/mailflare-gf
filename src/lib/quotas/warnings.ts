/**
 * T6.3 — the `quota.warning` trigger point.
 *
 * `withQuota` calls `notifyQuotaWarnings` after it has applied an increment. We
 * compare the counters *before* the increment with the counters *after* it and
 * fire once for every limit that has just crossed `WARNING_THRESHOLD`. Because
 * the crossing (below -> at-or-above) is what fires, a second create at 85%
 * stays quiet.
 *
 * The listener list lives here rather than in `service.ts` so quota enforcement
 * keeps no knowledge of webhooks; `src/lib/webhooks/quota-warning.ts` registers
 * the webhook emitter and is loaded lazily on the first warning.
 */
import type { QuotaIncrement, QuotaUsage } from "./service";
import type { QuotaLimits } from "./templates";

/** Fraction of a limit at which the warning fires. */
export const WARNING_THRESHOLD = 0.8;

export type QuotaWarning = {
	organizationId: string;
	/** `mailboxes` | `accounts` | `domains` | `storage_bytes` | `daily_sends`. */
	kind: string;
	limit: number;
	current: number;
	/** `current / limit`, rounded to two decimals. */
	usage: number;
	threshold: number;
};

export type QuotaWarningListener = (warning: QuotaWarning) => void | Promise<void>;

const listeners = new Set<QuotaWarningListener>();

/** Registers a listener. Returns the function that removes it again. */
export function onQuotaWarning(listener: QuotaWarningListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Test seam: drops every listener, including the lazily loaded default. */
export function resetQuotaWarningListeners(): void {
	listeners.clear();
	defaultsLoaded = undefined;
}

let defaultsLoaded: Promise<void> | undefined;

/**
 * Loads the built-in webhook listener the first time a warning is raised.
 * Importing it eagerly from here would make every quota check pull in the
 * webhook stack (and create an import cycle through the schema).
 */
function loadDefaultListeners(): Promise<void> {
	if (!defaultsLoaded) {
		defaultsLoaded = import("@/lib/webhooks/quota-warning")
			.then((module) => module.registerQuotaWarningWebhook())
			.catch(() => undefined);
	}
	return defaultsLoaded;
}

type Counter = { kind: string; limit: number | null; before: number; add: number };

/** The counters a limit can be expressed against. */
function counters(
	usage: QuotaUsage,
	quota: QuotaLimits,
	increment: QuotaIncrement,
): Counter[] {
	return [
		{ kind: "mailboxes", limit: quota.maxMailboxes, before: usage.mailboxes, add: increment.mailboxes ?? 0 },
		{ kind: "accounts", limit: quota.maxAccounts, before: usage.accounts, add: increment.accounts ?? 0 },
		{ kind: "domains", limit: quota.maxDomains, before: usage.domains, add: increment.domains ?? 0 },
		{
			kind: "storage_bytes",
			limit: quota.maxStorageBytes,
			before: usage.storageBytes,
			add: increment.storageBytes ?? 0,
		},
		{
			kind: "daily_sends",
			limit: quota.maxDailySends,
			before: usage.sendsToday,
			add: increment.sendsToday ?? 0,
		},
	];
}

/** The limits this increment has just pushed over the threshold. */
export function quotaWarningsFor(
	organizationId: string,
	usage: QuotaUsage,
	quota: QuotaLimits,
	increment: QuotaIncrement,
): QuotaWarning[] {
	const warnings: QuotaWarning[] = [];
	for (const counter of counters(usage, quota, increment)) {
		if (counter.limit === null || counter.limit <= 0) continue;
		if (counter.add <= 0) continue;
		const after = counter.before + counter.add;
		const wasBelow = counter.before / counter.limit < WARNING_THRESHOLD;
		const isAtOrAbove = after / counter.limit >= WARNING_THRESHOLD;
		if (!wasBelow || !isAtOrAbove) continue;
		warnings.push({
			organizationId,
			kind: counter.kind,
			limit: counter.limit,
			current: after,
			usage: Math.round((after / counter.limit) * 100) / 100,
			threshold: WARNING_THRESHOLD,
		});
	}
	return warnings;
}

/**
 * Called by `withQuota`. Never throws: a webhook problem must not roll back the
 * write that triggered it.
 */
export async function notifyQuotaWarnings(
	organizationId: string,
	usage: QuotaUsage,
	quota: QuotaLimits,
	increment: QuotaIncrement,
): Promise<void> {
	const warnings = quotaWarningsFor(organizationId, usage, quota, increment);
	if (warnings.length === 0) return;
	await loadDefaultListeners();
	for (const warning of warnings) {
		for (const listener of listeners) {
			try {
				await listener(warning);
			} catch {
				// A listener that throws is its own problem.
			}
		}
	}
}
