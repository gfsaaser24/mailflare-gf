/**
 * Quota breach error (T5.1).
 *
 * Routes turn it into `429 {"error":"Quota exceeded", kind, limit, current}`
 * with `quotaErrorBody()`; nothing here imports `next/server` so the mail
 * pipeline can throw it too.
 */

export type QuotaKind =
	| "mailboxes"
	| "shared_mailboxes"
	| "accounts"
	| "domains"
	| "storage_bytes"
	| "daily_sends"
	| "attachment_bytes";

export type QuotaBreach = {
	kind: QuotaKind;
	/** The limit that was hit. */
	limit: number;
	/** Usage before the request that breached it (bytes for the byte kinds). */
	current: number;
};

export class QuotaExceededError extends Error {
	/** HTTP status routes answer with. */
	readonly status = 429 as const;
	readonly kind: QuotaKind;
	readonly limit: number;
	readonly current: number;

	constructor(breach: QuotaBreach) {
		super(`Quota exceeded: ${breach.kind} (limit ${breach.limit}, current ${breach.current})`);
		this.name = "QuotaExceededError";
		this.kind = breach.kind;
		this.limit = breach.limit;
		this.current = breach.current;
	}
}

export function isQuotaExceededError(error: unknown): error is QuotaExceededError {
	return error instanceof QuotaExceededError;
}

/** The JSON body every route returns for a breach. */
export function quotaErrorBody(error: QuotaExceededError): {
	error: "Quota exceeded";
	kind: QuotaKind;
	limit: number;
	current: number;
} {
	return {
		error: "Quota exceeded",
		kind: error.kind,
		limit: error.limit,
		current: error.current,
	};
}
