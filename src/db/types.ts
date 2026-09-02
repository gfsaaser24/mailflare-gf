import { customType } from "drizzle-orm/pg-core";

/**
 * Postgres `tsvector`, for full-text search columns (T6.2).
 *
 * Drizzle has no built-in `tsvector`, so the column is declared through
 * `customType`. It is only ever read: `messages.search_vector` is a
 * `GENERATED ALWAYS ... STORED` column, so Postgres maintains it and nothing in
 * the app writes to it. The exact DDL lives at the top of
 * `src/lib/search/service.ts`.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
	dataType: () => "tsvector",
});
