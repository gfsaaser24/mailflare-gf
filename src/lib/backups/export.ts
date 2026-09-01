import type { DatabaseBackupDocument, DatabaseBackupTable, DatabaseRecord } from "./types";
import { mergeLegacyMessageBodies } from "./utils";

const BACKUP_TABLES: DatabaseBackupTable[] = ["users", "domains", "mailboxes", "mailbox_access", "contacts", "folders", "api_keys", "messages", "message_attachments", "outbound_jobs", "routing_rules", "webhooks", "webhook_deliveries", "sessions", "audit_logs", "backup_settings", "backups", "app_settings", "license_settings"];
const INSERT_BATCH_SIZE = 50;

export function getD1ExportConfigurationStatus(_env?: CloudflareEnv) {
	return { configured: true, missing: [] };
}

export async function exportDatabaseRecords(db: D1Database): Promise<Uint8Array> {
	const tables = {} as Record<DatabaseBackupTable, DatabaseRecord[]>;
	for (const table of BACKUP_TABLES) {
		const result = await db.prepare(`SELECT * FROM ${table}`).all<DatabaseRecord>();
		tables[table] = result.results;
	}
	const document: DatabaseBackupDocument = { format: "mailflare-database-backup", version: 1, createdAt: new Date().toISOString(), tables };
	return new TextEncoder().encode(JSON.stringify(document));
}

export async function restoreDatabaseRecords(db: D1Database, content: ArrayBuffer): Promise<void> {
	const document = parseDatabaseBackup(content);
	mergeLegacyMessageBodies(document);
	validateDatabaseBackup(document);
	for (const table of [...BACKUP_TABLES].reverse()) await db.prepare(`DELETE FROM ${table}`).run();
	for (const table of BACKUP_TABLES) {
		const rows = document.tables[table];
		for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
			const statements = rows.slice(index, index + INSERT_BATCH_SIZE).map((row) => createInsertStatement(db, table, row));
			if (statements.length > 0) await db.batch(statements);
		}
	}
}

function parseDatabaseBackup(content: ArrayBuffer): DatabaseBackupDocument {
	let value: unknown;
	try { value = JSON.parse(new TextDecoder().decode(content)); } catch { throw new Error("The selected file is not a valid Mailflare backup"); }
	if (!isDatabaseBackupDocument(value)) throw new Error("The selected file is not a valid Mailflare backup");
	return value;
}

function isDatabaseBackupDocument(value: unknown): value is DatabaseBackupDocument {
	if (!value || typeof value !== "object") return false;
	const document = value as Partial<DatabaseBackupDocument>;
	return document.format === "mailflare-database-backup" && document.version === 1 && !!document.tables && BACKUP_TABLES.every((table) => Array.isArray(document.tables?.[table]));
}

function createInsertStatement(db: D1Database, table: DatabaseBackupTable, row: DatabaseRecord) {
	const columns = Object.keys(row);
	if (columns.length === 0) throw new Error(`Backup contains an invalid ${table} record`);
	const placeholders = columns.map(() => "?").join(", ");
	const identifiers = columns.map((column) => `\`${column.replaceAll("`", "``")}\``).join(", ");
	return db.prepare(`INSERT INTO ${table} (${identifiers}) VALUES (${placeholders})`).bind(...columns.map((column) => row[column]));
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
