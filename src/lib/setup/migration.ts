import path from "node:path";
import { getTableName, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { schema, type AppDatabase } from "@/db";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle", "migrations");

/** Every table the app owns; derived from the Drizzle schema so the check cannot drift. */
const REQUIRED_TABLES = Object.values(schema).map((table) => getTableName(table));

/**
 * Prepares a fresh Postgres database for first use during setup.
 *
 * Returns `true` if migrations were applied (the database was empty),
 * `false` if the schema already exists (nothing to do). Throws if the
 * database has some tables but is missing the core Mailflare schema,
 * since that indicates a partial/foreign database rather than one this
 * app should take ownership of.
 */
export async function migrateCleanDatabase(db: AppDatabase): Promise<boolean> {
	const existing = await db.execute<{ table_name: string }>(
		sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
	);
	const tableNames = new Set(Array.from(existing, (row) => row.table_name));
	if (tableNames.size > 0) {
		const missing = REQUIRED_TABLES.filter((table) => !tableNames.has(table));
		if (missing.length === 0) return false;
		throw new Error(
			`The database is not empty, but the Mailflare schema is incomplete (missing: ${missing.join(", ")}). Apply the committed migrations before continuing setup.`,
		);
	}

	await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	return true;
}
