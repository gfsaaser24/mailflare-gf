/**
 * Quota enforcement (T5.1, decision D5).
 *
 * Every check runs inside one Postgres transaction that takes
 * `SELECT ... FOR UPDATE` on the organisation's `org_usage` row, so two
 * concurrent creates can never both pass the same limit:
 *
 *   await reserveQuota(db, orgId, { mailboxes: 1 });   // throws QuotaExceededError
 *   await releaseQuota(db, orgId, { mailboxes: 1 });   // give it back on rollback
 *
 * The general form hands the locked usage row and the limits to a callback and
 * applies whatever increment it returns:
 *
 *   const id = await withQuota(db, orgId, (usage, quota) => ({
 *     increment: { mailboxes: 1 },
 *     value: newId("mbx"),
 *   }));
 *
 * Rules:
 * - a `null` limit (or a missing `org_quotas` row) is unlimited: no check runs;
 * - `day_key` is the UTC `yyyy-mm-dd` `sends_today` belongs to. When it is not
 *   today the counter is treated as 0 and rewritten, so sends roll over;
 * - counters never go below zero.
 */
import { and, count, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { mailboxes, orgQuotas, orgUsage } from "@/db/schema";
import { QuotaExceededError, type QuotaKind } from "./errors";
import { notifyQuotaWarnings } from "./warnings";
import {
	quotaTemplateLimits,
	UNLIMITED_QUOTA,
	type QuotaLimits,
	type QuotaTemplate,
} from "./templates";

/** The transaction handle drizzle hands to `db.transaction(...)`. */
export type QuotaTx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
/** Anything that can run the queries: the database or an open transaction. */
export type QuotaRunner = AppDatabase | QuotaTx;

export type QuotaUsage = {
	mailboxes: number;
	accounts: number;
	domains: number;
	storageBytes: number;
	sendsToday: number;
	dayKey: string;
};

/**
 * What a request adds. `sharedMailboxes` has no counter of its own: it is
 * checked against the live `mailboxes` rows of type `shared`.
 */
export type QuotaIncrement = {
	mailboxes?: number;
	sharedMailboxes?: number;
	accounts?: number;
	domains?: number;
	storageBytes?: number;
	sendsToday?: number;
};

export type QuotaOutcome<T> = {
	increment?: QuotaIncrement;
	value: T;
};

const ZERO_USAGE: QuotaUsage = {
	mailboxes: 0,
	accounts: 0,
	domains: 0,
	storageBytes: 0,
	sendsToday: 0,
	dayKey: "1970-01-01",
};

/** UTC `yyyy-mm-dd`, the value stored in `org_usage.day_key`. */
export function utcDayKey(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

function toNumber(value: unknown): number {
	if (value === null || value === undefined) return 0;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function toLimit(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** The organisation's limits. A missing row means unlimited. */
export async function getOrganizationQuota(
	db: QuotaRunner,
	organizationId: string,
): Promise<QuotaLimits> {
	const [row] = await db
		.select()
		.from(orgQuotas)
		.where(eq(orgQuotas.organizationId, organizationId))
		.limit(1);
	if (!row) return { ...UNLIMITED_QUOTA };
	return {
		maxMailboxes: toLimit(row.maxMailboxes),
		maxSharedMailboxes: toLimit(row.maxSharedMailboxes),
		maxAccounts: toLimit(row.maxAccounts),
		maxDomains: toLimit(row.maxDomains),
		maxStorageBytes: toLimit(row.maxStorageBytes),
		maxDailySends: toLimit(row.maxDailySends),
		maxAttachmentBytes: toLimit(row.maxAttachmentBytes),
	};
}

/** The organisation's counters, with `sends_today` rolled to today. */
export async function getOrganizationUsage(
	db: QuotaRunner,
	organizationId: string,
): Promise<QuotaUsage> {
	const [row] = await db
		.select()
		.from(orgUsage)
		.where(eq(orgUsage.organizationId, organizationId))
		.limit(1);
	if (!row) return { ...ZERO_USAGE, dayKey: utcDayKey() };
	return rollDay({
		mailboxes: toNumber(row.mailboxes),
		accounts: toNumber(row.accounts),
		domains: toNumber(row.domains),
		storageBytes: toNumber(row.storageBytes),
		sendsToday: toNumber(row.sendsToday),
		dayKey: row.dayKey,
	});
}

/** Zeroes `sends_today` when the stored day is not today. */
function rollDay(usage: QuotaUsage, today: string = utcDayKey()): QuotaUsage {
	if (usage.dayKey === today) return usage;
	return { ...usage, sendsToday: 0, dayKey: today };
}

/** Creates the zero row if it is missing, then locks it. */
async function lockUsage(tx: QuotaTx, organizationId: string): Promise<QuotaUsage> {
	await tx.execute(sql`
		INSERT INTO "org_usage" ("organization_id", "day_key", "updated_at")
		VALUES (${organizationId}::text, ${utcDayKey()}::text, now())
		ON CONFLICT ("organization_id") DO NOTHING
	`);
	const rows = (await tx.execute(sql`
		SELECT "mailboxes", "accounts", "domains", "storage_bytes", "sends_today", "day_key"
		FROM "org_usage"
		WHERE "organization_id" = ${organizationId}::text
		FOR UPDATE
	`)) as unknown as Array<Record<string, unknown>>;
	const row = rows[0];
	if (!row) return { ...ZERO_USAGE, dayKey: utcDayKey() };
	return {
		mailboxes: toNumber(row.mailboxes),
		accounts: toNumber(row.accounts),
		domains: toNumber(row.domains),
		storageBytes: toNumber(row.storage_bytes),
		sendsToday: toNumber(row.sends_today),
		dayKey: String(row.day_key ?? ZERO_USAGE.dayKey),
	};
}

type CheckSpec = {
	kind: QuotaKind;
	limit: number | null;
	current: number;
	add: number;
};

/** Throws on the first limit the increment would break. */
async function assertIncrementFits(
	tx: QuotaTx,
	organizationId: string,
	usage: QuotaUsage,
	quota: QuotaLimits,
	increment: QuotaIncrement,
): Promise<void> {
	const checks: CheckSpec[] = [
		{ kind: "mailboxes", limit: quota.maxMailboxes, current: usage.mailboxes, add: increment.mailboxes ?? 0 },
		{ kind: "accounts", limit: quota.maxAccounts, current: usage.accounts, add: increment.accounts ?? 0 },
		{ kind: "domains", limit: quota.maxDomains, current: usage.domains, add: increment.domains ?? 0 },
		{
			kind: "storage_bytes",
			limit: quota.maxStorageBytes,
			current: usage.storageBytes,
			add: increment.storageBytes ?? 0,
		},
		{
			kind: "daily_sends",
			limit: quota.maxDailySends,
			current: usage.sendsToday,
			add: increment.sendsToday ?? 0,
		},
	];

	const sharedAdd = increment.sharedMailboxes ?? 0;
	if (sharedAdd > 0 && quota.maxSharedMailboxes !== null) {
		// No counter for shared mailboxes: count the rows, inside the same lock.
		const [row] = await tx
			.select({ value: count() })
			.from(mailboxes)
			.where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.type, "shared")));
		checks.push({
			kind: "shared_mailboxes",
			limit: quota.maxSharedMailboxes,
			current: toNumber(row?.value),
			add: sharedAdd,
		});
	}

	for (const check of checks) {
		if (check.limit === null || check.add <= 0) continue;
		if (check.current + check.add > check.limit) {
			throw new QuotaExceededError({
				kind: check.kind,
				limit: check.limit,
				current: check.current,
			});
		}
	}
}

/** Writes the counters back. `sends_today` is rebased on the rolled value. */
async function applyIncrement(
	tx: QuotaTx,
	organizationId: string,
	usage: QuotaUsage,
	increment: QuotaIncrement,
	today: string,
): Promise<void> {
	const mailboxesDelta = increment.mailboxes ?? 0;
	const accountsDelta = increment.accounts ?? 0;
	const domainsDelta = increment.domains ?? 0;
	const storageDelta = increment.storageBytes ?? 0;
	const sendsDelta = increment.sendsToday ?? 0;
	const nothingToDo =
		mailboxesDelta === 0 &&
		accountsDelta === 0 &&
		domainsDelta === 0 &&
		storageDelta === 0 &&
		sendsDelta === 0 &&
		usage.dayKey === today;
	if (nothingToDo) return;

	await tx.execute(sql`
		UPDATE "org_usage" SET
			"mailboxes" = GREATEST(0, "mailboxes" + ${mailboxesDelta}::int),
			"accounts" = GREATEST(0, "accounts" + ${accountsDelta}::int),
			"domains" = GREATEST(0, "domains" + ${domainsDelta}::int),
			"storage_bytes" = GREATEST(0::bigint, "storage_bytes" + ${storageDelta}::bigint),
			"sends_today" = GREATEST(0, ${usage.sendsToday}::int + ${sendsDelta}::int),
			"day_key" = ${today}::text,
			"updated_at" = now()
		WHERE "organization_id" = ${organizationId}::text
	`);
}

/**
 * Runs `fn` under the organisation's usage lock, checks the increment it asks
 * for against the limits, applies it and commits. Throws `QuotaExceededError`
 * (nothing is written) when a limit would break.
 */
export async function withQuota<T>(
	db: AppDatabase,
	organizationId: string,
	fn: (usage: QuotaUsage, quota: QuotaLimits, tx: QuotaTx) => Promise<QuotaOutcome<T>> | QuotaOutcome<T>,
): Promise<T> {
	const committed = await db.transaction(async (tx) => {
		const today = utcDayKey();
		const usage = rollDay(await lockUsage(tx, organizationId), today);
		const quota = await getOrganizationQuota(tx, organizationId);
		const outcome = await fn(usage, quota, tx);
		const increment = outcome.increment ?? {};
		await assertIncrementFits(tx, organizationId, usage, quota, increment);
		await applyIncrement(tx, organizationId, usage, increment, today);
		return { value: outcome.value, usage, quota, increment };
	});
	// T6.3: fires `quota.warning` when this increment crosses 80% of a limit.
	// Runs AFTER commit: the listener opens its own connection, and doing that while
	// holding the FOR UPDATE row inside the transaction can exhaust the pool.
	notifyQuotaWarnings(organizationId, committed.usage, committed.quota, committed.increment).catch((error) =>
		console.error("quota warning listener failed", error),
	);
	return committed.value;
}

/** Checks and books an increment in one go. */
export async function reserveQuota(
	db: AppDatabase,
	organizationId: string,
	increment: QuotaIncrement,
): Promise<void> {
	await withQuota(db, organizationId, () => ({ increment, value: undefined }));
}

/**
 * Gives usage back (a create that failed after its reservation, a delete).
 * Never checks anything and never goes below zero.
 */
export async function releaseQuota(
	db: AppDatabase,
	organizationId: string,
	decrement: QuotaIncrement,
): Promise<void> {
	const negated: QuotaIncrement = {
		mailboxes: -(decrement.mailboxes ?? 0),
		accounts: -(decrement.accounts ?? 0),
		domains: -(decrement.domains ?? 0),
		storageBytes: -(decrement.storageBytes ?? 0),
		sendsToday: -(decrement.sendsToday ?? 0),
	};
	await withQuota(db, organizationId, () => ({ increment: negated, value: undefined }));
}

/** Books stored bytes without checking (the check happens where they arrive). */
export async function addStorageBytes(
	db: AppDatabase,
	organizationId: string,
	bytes: number,
): Promise<void> {
	if (!Number.isFinite(bytes) || bytes === 0) return;
	await withQuota(db, organizationId, () => ({
		increment: { storageBytes: bytes },
		value: undefined,
	}));
}

/** Releases stored bytes for objects that were deleted. */
export async function releaseStorageBytes(
	db: AppDatabase,
	organizationId: string,
	bytes: number,
): Promise<void> {
	if (!Number.isFinite(bytes) || bytes <= 0) return;
	await addStorageBytes(db, organizationId, -bytes);
}

/**
 * Per-attachment size check. Not a counter: it is a hard ceiling on one part,
 * so it is checked wherever attachments are validated.
 */
export function assertAttachmentBytes(
	quota: Pick<QuotaLimits, "maxAttachmentBytes"> | null | undefined,
	size: number,
): void {
	const limit = quota?.maxAttachmentBytes;
	if (limit === null || limit === undefined) return;
	if (size > limit) {
		throw new QuotaExceededError({ kind: "attachment_bytes", limit, current: size });
	}
}

/** Writes (or overwrites) the organisation's limits. */
export async function setOrganizationQuota(
	db: AppDatabase,
	organizationId: string,
	limits: Partial<QuotaLimits>,
): Promise<QuotaLimits> {
	const current = await getOrganizationQuota(db, organizationId);
	const next: QuotaLimits = { ...current, ...limits };
	await db
		.insert(orgQuotas)
		.values({ organizationId, ...next })
		.onConflictDoUpdate({ target: orgQuotas.organizationId, set: next });
	return next;
}

/** Applies a named template and makes sure the zero usage row exists. */
export async function applyQuotaTemplate(
	db: AppDatabase,
	organizationId: string,
	template: QuotaTemplate,
): Promise<QuotaLimits> {
	const limits = await setOrganizationQuota(db, organizationId, quotaTemplateLimits(template));
	await ensureUsageRow(db, organizationId);
	return limits;
}

/** Inserts the zero usage row when it is missing. */
export async function ensureUsageRow(db: AppDatabase, organizationId: string): Promise<void> {
	await db
		.insert(orgUsage)
		.values({ organizationId, dayKey: utcDayKey(), updatedAt: new Date() })
		.onConflictDoNothing({ target: orgUsage.organizationId });
}

export type { QuotaLimits, QuotaTemplate } from "./templates";
export { QuotaExceededError, isQuotaExceededError, quotaErrorBody } from "./errors";
export type { QuotaKind } from "./errors";
