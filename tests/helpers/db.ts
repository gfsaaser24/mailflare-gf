import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb as createAppDb, type AppDatabase } from "@/db";
import { DEFAULT_ORGANIZATION_ID } from "@/lib/organizations/constants";

/** Drizzle's bookkeeping table; never truncate it. */
const MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_FOLDER = "drizzle/migrations";
/** Preserved across truncations: holds the migration-seeded default org. */
const ORGANIZATIONS_TABLE = "organizations";

export function getTestDatabaseUrl(): string | undefined {
	const url = process.env.TEST_DATABASE_URL;
	return url && url.length > 0 ? url : undefined;
}

/** True when DB-backed tests can run. Use with `describe.skipIf(!hasTestDatabase())`. */
export function hasTestDatabase(): boolean {
	return getTestDatabaseUrl() !== undefined;
}

function databaseNameOf(url: string): string {
	const path = new URL(url).pathname.replace(/^\//, "");
	return decodeURIComponent(path);
}

function requireTestDatabaseUrl(): string {
	const url = getTestDatabaseUrl();
	if (!url) throw new Error("TEST_DATABASE_URL is not set");
	const name = databaseNameOf(url);
	if (name === "postgres" || name === "") {
		throw new Error(
			`Refusing to run tests against database "${name || "(none)"}". ` +
				"TEST_DATABASE_URL must point at a dedicated test database (e.g. mailflare_test).",
		);
	}
	return url;
}

let db: AppDatabase | undefined;
let migrated: Promise<void> | undefined;

/** The shared test database, same shape as `createDb` from `@/db`. */
export function createDb(): AppDatabase {
	if (!db) db = createAppDb(requireTestDatabaseUrl());
	return db;
}

/** Runs the drizzle migrations once per process. */
export function migrateTestDatabase(): Promise<void> {
	if (!migrated) {
		migrated = (async () => {
			const url = requireTestDatabaseUrl();
			// A dedicated single connection: the migrator takes locks and must not
			// be multiplexed over the pool.
			const client = postgres(url, { max: 1, prepare: false });
			try {
				await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
			} finally {
				await client.end({ timeout: 5 });
			}
		})();
	}
	return migrated;
}

/**
 * Empties every public table (except drizzle's and `organizations`) and resets
 * identity sequences.
 *
 * `organizations` is kept because every tenant table has a NOT NULL
 * `organization_id` defaulting to the migration-seeded default org; wiping it
 * would break every insert. Orgs a test created are removed instead.
 */
export async function truncateAll(): Promise<void> {
	await migrateTestDatabase();
	const database = createDb();
	const rows = (await database.execute(
		sql`SELECT quote_ident(tablename) AS name FROM pg_tables
		    WHERE schemaname = 'public'
		      AND tablename <> ${MIGRATIONS_TABLE}
		      AND tablename <> ${ORGANIZATIONS_TABLE}`,
	)) as unknown as Array<{ name: string }>;
	if (rows.length === 0) return;
	const list = rows.map((r) => `public.${r.name}`).join(", ");
	await database.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));
	await database.execute(
		sql`DELETE FROM "organizations" WHERE "id" <> ${DEFAULT_ORGANIZATION_ID}`,
	);
}

/** Closes the pool so vitest can exit cleanly. */
export async function closeTestDatabase(): Promise<void> {
	if (!db) return;
	// drizzle keeps the postgres-js client on the session.
	const client = (db as unknown as { $client: postgres.Sql }).$client;
	db = undefined;
	migrated = undefined;
	await client.end({ timeout: 5 });
}
