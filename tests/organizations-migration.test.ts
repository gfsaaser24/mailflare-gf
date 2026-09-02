import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { organizations, users } from "@/db/schema";
import { DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_SLUG } from "@/lib/organizations/constants";
import {
	closeTestDatabase,
	createDb,
	hasTestDatabase,
	migrateTestDatabase,
	truncateAll,
} from "./helpers/db";

describe.skipIf(!hasTestDatabase())("organizations migration", () => {
	beforeEach(async () => {
		await truncateAll();
	});

	afterAll(async () => {
		await closeTestDatabase();
	});

	it("seeds the default organisation", async () => {
		await migrateTestDatabase();
		const db = createDb();

		const rows = await db
			.select()
			.from(organizations)
			.where(eq(organizations.id, DEFAULT_ORGANIZATION_ID));

		expect(rows).toHaveLength(1);
		expect(rows[0]?.slug).toBe(DEFAULT_ORGANIZATION_SLUG);
		expect(rows[0]?.status).toBe("active");
		// No app_settings row exists in a fresh test database, so the fallback name wins.
		expect(rows[0]?.name).toBe("Mailflare");
		expect(rows[0]?.createdAt).toBeInstanceOf(Date);
	});

	it("puts rows inserted without an organisation into the default org", async () => {
		const db = createDb();

		await db.insert(users).values({
			id: "usr_no_org",
			email: "no-org@example.test",
			passwordHash: "x",
			name: "No Org",
			role: "user",
		});

		const rows = await db.select().from(users).where(eq(users.id, "usr_no_org"));
		expect(rows[0]?.organizationId).toBe(DEFAULT_ORGANIZATION_ID);
	});

	it("rejects a duplicate organisation slug", async () => {
		const db = createDb();

		await db.insert(organizations).values({ id: "org_a", name: "A", slug: "acme" });

		await expect(
			db.insert(organizations).values({ id: "org_b", name: "B", slug: "acme" }),
		).rejects.toThrow();

		// The default org's slug is taken too.
		await expect(
			db
				.insert(organizations)
				.values({ id: "org_c", name: "C", slug: DEFAULT_ORGANIZATION_SLUG }),
		).rejects.toThrow();
	});
});
