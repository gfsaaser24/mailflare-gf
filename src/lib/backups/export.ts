import { sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import type { DatabaseBackupDocument, DatabaseBackupTable, DatabaseRecord } from "./types";
import { mergeLegacyMessageBodies } from "./utils";

const BACKUP_TABLES: DatabaseBackupTable[] = ["users", "domains", "mailboxes", "mailbox_access", "auto_reply_deliveries", "contacts", "folders", "calendar_events", "email_templates", "api_keys", "messages", "message_attachments", "outbound_jobs", "routing_rules", "webhooks", "webhook_deliveries", "sessions", "audit_logs", "backup_settings", "backups", "app_settings"];
const INSERT_BATCH_SIZE = 500;

/** Columns that hold timestamps (either `timestamp with time zone`). Values for these columns
 * are coerced to `Date` on restore so both ISO strings (current export format) and epoch
 * seconds (the old D1/SQLite export format) bind correctly to the Postgres column type. */
const TIMESTAMP_COLUMNS = new Set([
	"created_at",
	"updated_at",
	"sent_at",
	"last_seen_at",
	"last_used_at",
	"snoozed_until",
	"scheduled_at",
	"starts_at",
	"ends_at",
	"expires_at",
	"started_at",
	"completed_at",
]);

export function getExportConfigurationStatus(_env?: AppEnv) {
	return { configured: true, missing: [] };
}

export async function exportDatabaseRecords(db: AppDatabase): Promise<Uint8Array> {
	const tables = {} as Record<DatabaseBackupTable, DatabaseRecord[]>;
	for (const table of BACKUP_TABLES) {
		const result = await db.execute<DatabaseRecord>(sql.raw(`SELECT * FROM "${table}"`));
		tables[table] = Array.from(result);
	}
	// Date values in `tables` are serialised to ISO strings automatically by JSON.stringify.
	const document: DatabaseBackupDocument = {
		format: "mailflare-database-backup",
		version: 1,
		createdAt: new Date().toISOString(),
		tables,
	};
	return new TextEncoder().encode(JSON.stringify(document));
}

export async function restoreDatabaseRecords(db: AppDatabase, content: ArrayBuffer): Promise<void> {
	const document = parseDatabaseBackup(content);
	mergeLegacyMessageBodies(document);
	validateDatabaseBackup(document);

	await db.transaction(async (tx) => {
		for (const table of [...BACKUP_TABLES].reverse()) {
			await tx.execute(sql.raw(`DELETE FROM "${table}"`));
		}
		for (const table of BACKUP_TABLES) {
			const rows = document.tables[table];
			for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
				const chunk = rows.slice(index, index + INSERT_BATCH_SIZE);
				if (chunk.length > 0) await insertRows(tx, table, chunk);
			}
		}
	});
}

async function insertRows(
	tx: Pick<AppDatabase, "execute">,
	table: DatabaseBackupTable,
	rows: DatabaseRecord[],
): Promise<void> {
	const columns = Object.keys(rows[0]);
	if (columns.length === 0) throw new Error(`Backup contains an invalid ${table} record`);
	const columnList = sql.join(
		columns.map((column) => sql.identifier(column)),
		sql.raw(", "),
	);
	const valueRows = rows.map((row) => {
		const rowColumns = Object.keys(row);
		if (rowColumns.length !== columns.length || !columns.every((column) => Object.hasOwn(row, column))) {
			throw new Error(`Backup contains an invalid ${table} record`);
		}
		const values = columns.map((column) => sql`${coerceValue(column, row[column])}`);
		return sql`(${sql.join(values, sql.raw(", "))})`;
	});
	await tx.execute(
		sql`INSERT INTO ${sql.identifier(table)} (${columnList}) VALUES ${sql.join(valueRows, sql.raw(", "))}`,
	);
}

function coerceValue(column: string, value: DatabaseRecord[string]): unknown {
	if (value === null || value === undefined) return null;
	if (TIMESTAMP_COLUMNS.has(column)) {
		// Old D1 exports stored epoch seconds; current exports use ISO strings.
		if (typeof value === "number") return new Date(value * 1000);
		if (typeof value === "string") return new Date(value);
	}
	return value;
}

function parseDatabaseBackup(content: ArrayBuffer): DatabaseBackupDocument {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(content));
	} catch {
		throw new Error("The selected file is not a valid Mailflare backup");
	}
	if (!isDatabaseBackupDocument(value)) throw new Error("The selected file is not a valid Mailflare backup");
	return value;
}

function isDatabaseBackupDocument(value: unknown): value is DatabaseBackupDocument {
	if (!value || typeof value !== "object") return false;
	const document = value as Partial<DatabaseBackupDocument>;
	return document.format === "mailflare-database-backup" && document.version === 1 && !!document.tables && BACKUP_TABLES.every((table) => Array.isArray(document.tables?.[table]));
}

function validateDatabaseBackup(document: DatabaseBackupDocument): void {
	for (const table of BACKUP_TABLES) {
		for (const row of document.tables[table]) {
			if (!row || typeof row !== "object" || Array.isArray(row)) {
				throw new Error(`Backup contains an invalid ${table} record`);
			}
		}
	}
}
