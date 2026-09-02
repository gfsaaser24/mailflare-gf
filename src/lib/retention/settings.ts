/**
 * Per-organisation retention windows (T5.2).
 *
 * Every value is a number of days. A missing `org_retention` row means
 * `DEFAULT_RETENTION`, so nothing has to be written before the job can run:
 *
 *   const retention = await getRetention(db, orgId);   // defaults when unset
 *   await setRetention(db, orgId, { trashDays: 7 });   // upsert
 *
 * The windows are read by `runRetention()` (`./service.ts`) and edited from the
 * "Retention" card on the admin backups page via `/api/settings/retention`.
 */
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { orgRetention } from "@/db/schema";

export type RetentionSettings = {
	/** Days a message may sit in `status = 'trash'` before it is really deleted. */
	trashDays: number;
	/** Days an expired session row is kept after `expires_at`. */
	sessionsDays: number;
	webhookDeliveriesDays: number;
	/** `platform.*` audit actions are kept forever whatever this says. */
	auditLogsDays: number;
	autoReplyDays: number;
	outboundJobsDays: number;
};

/** What an organisation without an `org_retention` row gets. */
export const DEFAULT_RETENTION: RetentionSettings = {
	trashDays: 30,
	sessionsDays: 7,
	webhookDeliveriesDays: 30,
	auditLogsDays: 365,
	autoReplyDays: 30,
	outboundJobsDays: 30,
};

/** Resolved `inbound_failures` window; not configurable (spec T5.2). */
export const RESOLVED_INBOUND_FAILURE_DAYS = 30;

/** Days must be a whole number in this range; 0 is not allowed (it would mean "now"). */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

export const RETENTION_KEYS = [
	"trashDays",
	"sessionsDays",
	"webhookDeliveriesDays",
	"auditLogsDays",
	"autoReplyDays",
	"outboundJobsDays",
] as const satisfies readonly (keyof RetentionSettings)[];

function toDays(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	const days = Math.trunc(parsed);
	if (days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) return fallback;
	return days;
}

/** The organisation's windows. A missing row is `DEFAULT_RETENTION`. */
export async function getRetention(
	db: AppDatabase,
	organizationId: string,
): Promise<RetentionSettings> {
	const [row] = await db
		.select()
		.from(orgRetention)
		.where(eq(orgRetention.organizationId, organizationId))
		.limit(1);
	if (!row) return { ...DEFAULT_RETENTION };
	return {
		trashDays: toDays(row.trashDays, DEFAULT_RETENTION.trashDays),
		sessionsDays: toDays(row.sessionsDays, DEFAULT_RETENTION.sessionsDays),
		webhookDeliveriesDays: toDays(
			row.webhookDeliveriesDays,
			DEFAULT_RETENTION.webhookDeliveriesDays,
		),
		auditLogsDays: toDays(row.auditLogsDays, DEFAULT_RETENTION.auditLogsDays),
		autoReplyDays: toDays(row.autoReplyDays, DEFAULT_RETENTION.autoReplyDays),
		outboundJobsDays: toDays(row.outboundJobsDays, DEFAULT_RETENTION.outboundJobsDays),
	};
}

/**
 * Rejects anything that is not a whole number of days in range, so a typo in the
 * admin form can never turn into "delete everything". Returns null when invalid.
 */
export function parseRetentionInput(input: unknown): RetentionSettings | null {
	if (!input || typeof input !== "object") return null;
	const record = input as Record<string, unknown>;
	const parsed = {} as RetentionSettings;
	for (const key of RETENTION_KEYS) {
		const raw = record[key];
		const value = typeof raw === "number" ? raw : Number(raw);
		if (raw === undefined || raw === null || raw === "" || !Number.isInteger(value)) return null;
		if (value < MIN_RETENTION_DAYS || value > MAX_RETENTION_DAYS) return null;
		parsed[key] = value;
	}
	return parsed;
}

/** Writes the organisation's windows, filling anything the caller left out. */
export async function setRetention(
	db: AppDatabase,
	organizationId: string,
	settings: Partial<RetentionSettings>,
): Promise<RetentionSettings> {
	const current = await getRetention(db, organizationId);
	const next: RetentionSettings = { ...current, ...settings };
	await db
		.insert(orgRetention)
		.values({ organizationId, ...next, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: orgRetention.organizationId,
			set: { ...next, updatedAt: new Date() },
		});
	return next;
}

/** `now` minus `days`, the cut-off every sweep compares against. */
export function cutoffFor(days: number, now: Date = new Date()): Date {
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
