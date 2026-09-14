/**
 * Admins reach every mailbox of their organisation; and the account permissions
 * form can save an account whose forwarding address is `null` (it used to come
 * back as a zod object rendered "[object Object]").
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { domains, mailboxes, organizations, users } from "@/db/schema";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { getMailboxAccessLevel, listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { apiErrorMessage } from "@/app/(admin)/accounts/[id]/utils";
import { createDb, hasTestDatabase } from "./helpers/db";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) => {
			const value = cookieJar.get(name);
			return value === undefined ? undefined : { name, value };
		},
	}),
}));

const ORG = "org_ama";
const OTHER_ORG = "org_ama_other";
const ADMIN = "usr_ama_admin";
const USER = "usr_ama_user";
const OTHER_ADMIN = "usr_ama_other_admin";
const MBX_ADMIN = "mbx_ama_admin";
const MBX_USER = "mbx_ama_user";
const MBX_DISABLED = "mbx_ama_disabled";
const MBX_OTHER_ORG = "mbx_ama_other";

async function seed() {
	const db = createDb();
	await db.insert(organizations).values([
		{ id: ORG, name: "AMA", slug: "ama", status: "active" },
		{ id: OTHER_ORG, name: "AMA other", slug: "ama-other", status: "active" },
	]);
	await db.insert(users).values([
		{ id: ADMIN, organizationId: ORG, email: "admin@ama.test", passwordHash: "x", name: "Admin", role: "admin" },
		{
			id: USER,
			organizationId: ORG,
			email: "ricky@ama.test",
			passwordHash: "x",
			name: "Ricky",
			role: "user",
			createdByUserId: ADMIN,
		},
		{
			id: OTHER_ADMIN,
			organizationId: OTHER_ORG,
			email: "admin@ama-other.test",
			passwordHash: "x",
			name: "Other",
			role: "admin",
		},
	]);
	await db.insert(domains).values([
		{ id: "dom_ama", organizationId: ORG, userId: ADMIN, hostname: "ama.test", zoneId: "z_ama" },
		{ id: "dom_ama_other", organizationId: OTHER_ORG, userId: OTHER_ADMIN, hostname: "ama-other.test", zoneId: "z_o" },
	]);
	await db.insert(mailboxes).values([
		{ id: MBX_ADMIN, organizationId: ORG, userId: ADMIN, domainId: "dom_ama", localPart: "admin", type: "personal" },
		{ id: MBX_USER, organizationId: ORG, userId: USER, domainId: "dom_ama", localPart: "ricky", type: "personal" },
		{
			id: MBX_DISABLED,
			organizationId: ORG,
			userId: USER,
			domainId: "dom_ama",
			localPart: "old",
			type: "personal",
			disabled: true,
		},
		{
			id: MBX_OTHER_ORG,
			organizationId: OTHER_ORG,
			userId: OTHER_ADMIN,
			domainId: "dom_ama_other",
			localPart: "admin",
			type: "personal",
		},
	]);
}

async function signIn(userId: string) {
	const token = await createSession({ DB: createDb() } as unknown as CloudflareEnv, userId);
	cookieJar.clear();
	cookieJar.set(SESSION_COOKIE, token);
}

describe.skipIf(!hasTestDatabase())("admin mailbox access", () => {
	beforeAll(() => {
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
	});
	beforeEach(async () => {
		cookieJar.clear();
		await seed();
	});

	it("gives an admin full access to another account's personal mailbox, not ownership", async () => {
		const db = createDb();
		const admin = { id: ADMIN, role: "admin" as const };
		const access = await getMailboxAccessLevel(db, admin, MBX_USER, ORG);
		expect(access).toMatchObject({ permission: "full_access", isOwner: false, canManage: true, canRead: true });
		// Owner semantics are untouched for the admin's own inbox.
		expect(await getMailboxAccessLevel(db, admin, MBX_ADMIN, ORG)).toMatchObject({ isOwner: true });
		// Disabled and foreign-organisation mailboxes stay closed.
		expect(await getMailboxAccessLevel(db, admin, MBX_DISABLED, ORG)).toBeNull();
		expect(await getMailboxAccessLevel(db, admin, MBX_OTHER_ORG, ORG)).toBeNull();
	});

	it("keeps a plain user out of mailboxes they do not own", async () => {
		const db = createDb();
		expect(await getMailboxAccessLevel(db, { id: USER, role: "user" }, MBX_ADMIN, ORG)).toBeNull();
	});

	it("lists every enabled mailbox of the organisation for an admin", async () => {
		const db = createDb();
		const rows = await listAccessibleMailboxes(db, { id: ADMIN, email: "admin@ama.test", role: "admin" }, ORG);
		expect(rows.map((row) => row.id).sort()).toEqual([MBX_ADMIN, MBX_USER].sort());
		const theirs = rows.find((row) => row.id === MBX_USER);
		expect(theirs).toMatchObject({ permission: "full_access", isPrimary: false, userId: USER });
		expect(rows.find((row) => row.id === MBX_ADMIN)?.isPrimary).toBe(true);

		const userRows = await listAccessibleMailboxes(db, { id: USER, email: "ricky@ama.test", role: "user" }, ORG);
		expect(userRows.map((row) => row.id)).toEqual([MBX_USER]);
	});

	it("saves account permissions when the forwarding address is null", async () => {
		const { PATCH } = await import("@/app/api/accounts/[id]/route");
		await signIn(ADMIN);
		const response = await PATCH(
			new Request(`http://localhost/api/accounts/${USER}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "Ricky",
					role: "user",
					disabled: false,
					canManageMailboxes: true,
					forwardingEmail: null,
				}),
			}),
			{ params: Promise.resolve({ id: USER }) },
		);
		expect(response.status).toBe(200);
		const db = createDb();
		const [row] = await db.select({ canManageMailboxes: users.canManageMailboxes, forwardingEmail: users.forwardingEmail }).from(users).where((await import("drizzle-orm")).eq(users.id, USER));
		expect(row).toEqual({ canManageMailboxes: true, forwardingEmail: null });
	});

	it("renders a zod error object as readable text", () => {
		expect(apiErrorMessage({ error: "Plain" }, "fallback")).toBe("Plain");
		expect(
			apiErrorMessage(
				{ error: { formErrors: [], fieldErrors: { forwardingEmail: ["Expected string, received null"] } } },
				"fallback",
			),
		).toBe("forwardingEmail: Expected string, received null");
		expect(apiErrorMessage({ error: {} }, "fallback")).toBe("fallback");
		expect(apiErrorMessage(undefined, "fallback")).toBe("fallback");
	});
});
