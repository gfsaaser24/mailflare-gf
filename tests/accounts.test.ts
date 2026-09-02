import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "@/db/schema";
import { listAccountsForAdmin } from "@/app/api/accounts/utils";
import { closeTestDatabase, createDb, hasTestDatabase, truncateAll } from "./helpers/db";

type Db = Parameters<typeof listAccountsForAdmin>[0];

async function insertUser(
	db: Db,
	values: { id: string; email: string; role: "admin" | "user"; createdByUserId?: string },
) {
	await db.insert(users).values({
		id: values.id,
		email: values.email,
		passwordHash: "x",
		name: values.id,
		role: values.role,
		createdByUserId: values.createdByUserId ?? null,
	});
}

describe.skipIf(!hasTestDatabase())("listAccountsForAdmin", () => {
	beforeEach(async () => {
		await truncateAll();
	});

	afterAll(async () => {
		await closeTestDatabase();
	});

	it("returns only the caller and the accounts the caller created", async () => {
		const db: Db = createDb();

		await insertUser(db, { id: "usr_admin_a", email: "a@example.test", role: "admin" });
		await insertUser(db, { id: "usr_admin_b", email: "b@example.test", role: "admin" });
		await insertUser(db, {
			id: "usr_a1",
			email: "a1@example.test",
			role: "user",
			createdByUserId: "usr_admin_a",
		});
		await insertUser(db, {
			id: "usr_b1",
			email: "b1@example.test",
			role: "user",
			createdByUserId: "usr_admin_b",
		});

		const seenByA = await listAccountsForAdmin(db, "usr_admin_a");
		const seenByB = await listAccountsForAdmin(db, "usr_admin_b");

		expect(new Set(seenByA.map((row) => row.id))).toEqual(new Set(["usr_admin_a", "usr_a1"]));
		expect(new Set(seenByB.map((row) => row.id))).toEqual(new Set(["usr_admin_b", "usr_b1"]));
	});
});
