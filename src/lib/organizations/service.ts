import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { organizations, users } from "@/db/schema";

export type Organization = typeof organizations.$inferSelect;
export type OrganizationStatus = Organization["status"];

/** The slice of an organisation a request needs; what `withOrg()` puts on `ctx.org`. */
export type OrganizationRef = Pick<Organization, "id" | "slug" | "status">;

/** Thrown by `assertOrganizationActive`. `withOrg()` turns it into a 403. */
export class OrganizationSuspendedError extends Error {
	readonly status = 403;

	constructor() {
		super("Organisation suspended");
		this.name = "OrganizationSuspendedError";
	}
}

/** Loads an organisation by id, or `null` when it does not exist. */
export async function getOrganization(
	db: AppDatabase,
	organizationId: string,
): Promise<OrganizationRef | null> {
	const [org] = await db
		.select({
			id: organizations.id,
			slug: organizations.slug,
			status: organizations.status,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	return org ?? null;
}

/** Throws `OrganizationSuspendedError` unless the organisation is active. */
export function assertOrganizationActive(org: OrganizationRef): void {
	if (org.status !== "active") throw new OrganizationSuspendedError();
}

/**
 * Organisation a user belongs to. Used by library code that is handed only a
 * userId (audit log, contact upsert from the mail pipeline) so nothing falls
 * back to the default organisation once there is more than one.
 */
export async function getUserOrganizationId(db: AppDatabase, userId: string): Promise<string> {
	const [row] = await db
		.select({ organizationId: users.organizationId })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!row) throw new Error(`Unknown user ${userId}`);
	return row.organizationId;
}
