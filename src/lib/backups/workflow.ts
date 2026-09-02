import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { backups } from "@/db/schema";
import { exportDatabaseRecords } from "./export";
import { getBackupSettings } from "./service";
import { BACKUP_PREFIX, createBackupFilename } from "./utils";

/**
 * Runs a single database backup end to end: mark running, export the DB to
 * JSON, store it in the bucket, then mark completed (or failed on error).
 *
 * This replaces the old Cloudflare Workflow (`DatabaseBackupWorkflow`), which
 * doesn't exist on a plain Node server. Callers fire this off in the
 * background (see `src/lib/backups/utils.ts`) rather than awaiting it inline.
 */
export async function runBackup(env: AppEnv, backupId: string): Promise<void> {
	const db = getDb(env);
	try {
		await db
			.update(backups)
			.set({ status: "running", startedAt: new Date() })
			.where(eq(backups.id, backupId));

		const content = await exportDatabaseRecords(db);
		const filename = createBackupFilename(new Date());
		const r2Key = `${BACKUP_PREFIX}/${backupId}/${filename}`;
		await env.BUCKET.put(r2Key, content, {
			httpMetadata: { contentType: "application/json" },
			customMetadata: { backupId },
		});

		await db
			.update(backups)
			.set({
				status: "completed",
				filename,
				r2Key,
				size: content.byteLength,
				completedAt: new Date(),
				error: null,
			})
			.where(eq(backups.id, backupId));
	} catch (error) {
		const message = error instanceof Error ? error.message : "Backup failed";
		await db
			.update(backups)
			.set({ status: "failed", error: message, completedAt: new Date() })
			.where(eq(backups.id, backupId));
		throw error;
	}

	// Retention cleanup is separate: a failure here must not flip a completed backup to failed.
	try {
		await deleteExpiredBackups(env);
	} catch (error) {
		console.error("Backup retention cleanup failed", error);
	}
}

/** Backups still "queued"/"running" after this long were interrupted by a restart or deploy. */
const STALE_BACKUP_MS = 60 * 60 * 1000;

/**
 * Marks backups that can no longer be running as failed. Backups run inside the
 * app process, so a restart mid-run leaves a non-terminal row behind; this is
 * called from the backups list route to reconcile those.
 */
export async function reconcileStaleBackups(env: AppEnv): Promise<number> {
	const db = getDb(env);
	const cutoff = new Date(Date.now() - STALE_BACKUP_MS);
	const stale = await db
		.update(backups)
		.set({ status: "failed", error: "Interrupted by an app restart", completedAt: new Date() })
		.where(and(inArray(backups.status, ["queued", "running"]), lt(backups.createdAt, cutoff)))
		.returning({ id: backups.id });
	return stale.length;
}

/**
 * Deletes backups past the configured retention window. Called after every
 * backup run. Scheduled/periodic backups themselves are not created by this
 * app — supascale's backup scheduler is responsible for triggering scheduled
 * runs; this file only performs the work once a backup has been requested.
 */
async function deleteExpiredBackups(env: AppEnv): Promise<{ deleted: number }> {
	const settings = await getBackupSettings(env);
	if (!settings?.retentionEnabled) return { deleted: 0 };
	const cutoff = new Date(Date.now() - settings.retentionDays * 86_400_000);
	const db = getDb(env);
	const expired = await db
		.select()
		.from(backups)
		.where(
			and(
				lt(backups.createdAt, cutoff),
				inArray(backups.status, ["completed", "failed"]),
			),
		);
	for (const backup of expired) {
		if (backup.r2Key) await env.BUCKET.delete(backup.r2Key);
		await db.delete(backups).where(eq(backups.id, backup.id));
	}
	return { deleted: expired.length };
}
