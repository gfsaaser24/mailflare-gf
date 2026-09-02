import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "@/db/schema";

export type AppDatabase = ReturnType<typeof createDb>;

export function createDb(connectionString: string) {
	const client = postgres(connectionString, {
		max: 10,
		// Supabase pooler (transaction mode) does not support prepared statements.
		prepare: false,
	});
	return drizzle(client, { schema });
}

let singleton: AppDatabase | undefined;

export function getSharedDb(): AppDatabase {
	if (!singleton) {
		const url = process.env.DATABASE_URL;
		if (!url) throw new Error("DATABASE_URL is not set");
		singleton = createDb(url);
	}
	return singleton;
}

export function getDb(env: Pick<AppEnv, "DB">) {
	if (!env.DB) throw new Error("No database configured");
	return env.DB;
}

export { schema };
