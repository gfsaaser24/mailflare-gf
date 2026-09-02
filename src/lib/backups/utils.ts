import type { BackupScheduleType, DatabaseBackupDocument, DatabaseRecord } from "./types";
import { runBackup } from "./workflow";

export const BACKUP_SETTINGS_ID = "default";
export const BACKUP_PREFIX = "backups/database";

/**
 * Kicks off a backup in the background and returns immediately; the caller
 * (an API route) doesn't wait for the export/upload to finish. Errors are
 * swallowed here because `runBackup` already records failures on the backup
 * row itself — there's nothing left for an HTTP response to do with them.
 *
 * Note: this only runs backups that were explicitly requested (manual, or a
 * scheduled one already marked due via `createScheduledBackupIfDue`). Actual
 * cron-style scheduling of when to trigger a backup is handled outside the
 * app by supascale's backup scheduler, not by any timer in this codebase.
 */
export function startBackup(env: AppEnv, backupId: string): void {
	void runBackup(env, backupId).catch((error: unknown) => {
		console.error(`Backup ${backupId} failed`, error);
	});
}

export function isBackupDue(
	scheduleType: BackupScheduleType,
	scheduleValue: number | null,
	now: Date,
): boolean {
	if (scheduleType === "daily") return true;
	if (scheduleType === "weekly") return now.getUTCDay() === scheduleValue;
	return now.getUTCDate() === scheduleValue;
}

export function getUtcDayBounds(now: Date): { start: number; end: number } {
	const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	return { start, end: start + 86_400_000 };
}

export function createBackupFilename(now: Date): string {
	return `mailflare-${now.toISOString().replace(/[:.]/g, "-")}.json`;
}

/** Moves records from the pre-0019 body table into their message records. */
export function mergeLegacyMessageBodies(document: DatabaseBackupDocument): void {
	const tables = document.tables as Record<string, DatabaseRecord[]>;
	const bodyRows = tables.message_bodies;
	if (!bodyRows) return;

	const bodiesByMessageId = new Map<string, DatabaseRecord>();
	for (const body of bodyRows) {
		if (!isDatabaseRecord(body) || typeof body.message_id !== "string") {
			throw new Error("Backup contains an invalid message_bodies record");
		}
		bodiesByMessageId.set(body.message_id, body);
	}

	for (const message of tables.messages) {
		const body = bodiesByMessageId.get(message.id as string);
		if (!body) continue;
		copyMissingBodyField(message, body, "text_body");
		copyMissingBodyField(message, body, "html_body");
		copyMissingBodyField(message, body, "raw_r2_key");
	}

	delete tables.message_bodies;
}

function copyMissingBodyField(
	message: DatabaseRecord,
	body: DatabaseRecord,
	field: "text_body" | "html_body" | "raw_r2_key",
): void {
	if (!(field in message) && field in body) message[field] = body[field];
}

function isDatabaseRecord(value: unknown): value is DatabaseRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
