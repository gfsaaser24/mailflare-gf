import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema } from "@/db";
import { createDb, hasTestDatabase } from "./helpers/db";

describe.skipIf(!hasTestDatabase())("database smoke test", () => {
	it("inserts and reads a users row", async () => {
		const db = createDb();
		await db.insert(schema.users).values({
			id: "smoke-user-1",
			email: "smoke@example.test",
			passwordHash: "not-a-real-hash",
			name: "Smoke Test",
		});

		const rows = await db.select().from(schema.users).where(eq(schema.users.id, "smoke-user-1"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.email).toBe("smoke@example.test");
		expect(rows[0]?.role).toBe("user");
	});

	it("truncates between tests", async () => {
		const db = createDb();
		const rows = await db.select().from(schema.users);
		expect(rows).toHaveLength(0);
	});
});
