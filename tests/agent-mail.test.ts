/**
 * Agent mail and two-factor authentication.
 *
 * `mailboxes.agent_mail` marks an inbox an automated agent owns. Nothing there
 * can read a code out of an authenticator app, so the flag and the OWNER's
 * second factor are mutually exclusive, in both directions:
 *  - an owner of an agent mailbox cannot start or finish TOTP enrolment, and is
 *    exempt from the organisation's `require_two_factor`;
 *  - the flag cannot be set while the owner already has TOTP on.
 *
 * The exemption is deliberately narrow: only the owner is relaxed. Delegated
 * access to a shared agent inbox says nothing about the delegate's own account.
 */
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { domains, mailboxAccess, mailboxes, organizations, users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { hashPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { createDb, hasTestDatabase } from "./helpers/db";

/** Cookie jar backing the mocked `next/headers`. */
const cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) => {
			const value = cookieJar.get(name);
			return value === undefined ? undefined : { name, value };
		},
	}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const routeCtx = () => ({ params: Promise.resolve({}) }) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mailboxCtx = (id: string) => ({ params: Promise.resolve({ id }) }) as any;

const ORG = "org_agent_mail";
const DOMAIN = "dom_agent_mail";
const PASSWORD = "correct-horse-battery";

function post(path: string, body?: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

function patch(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe.skipIf(!hasTestDatabase())("agent mail", () => {
	beforeAll(() => {
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		// A deterministic 32-byte key: the two-factor routes refuse to encrypt without one.
		process.env.AUTH_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
		// `getEnv()` refuses a half-configured mail transport; nothing here sends.
		if (!!process.env.EDGE_WORKER_URL !== !!process.env.EDGE_WORKER_SECRET) {
			delete process.env.EDGE_WORKER_URL;
			delete process.env.EDGE_WORKER_SECRET;
		}
	});

	beforeEach(() => {
		cookieJar.clear();
	});

	/** One organisation and one domain to hang the mailboxes off. */
	async function seedOrg(options: { requireTwoFactor?: boolean } = {}): Promise<void> {
		const db = createDb();
		await db.insert(organizations).values({
			id: ORG,
			name: "Agent mail org",
			slug: "agent-mail-org",
			status: "active",
			requireTwoFactor: !!options.requireTwoFactor,
		});
		await db.insert(users).values({
			id: "usr_owner_seed",
			organizationId: ORG,
			email: "seed@agent-mail.test",
			passwordHash: hashPassword(PASSWORD),
			name: "Seed",
			role: "admin",
		});
		await db.insert(domains).values({
			id: DOMAIN,
			organizationId: ORG,
			userId: "usr_owner_seed",
			hostname: "agent-mail.test",
			zoneId: "zone_agent_mail",
			status: "active",
		});
	}

	async function seedUser(
		id: string,
		localPart: string,
		options: { enrolled?: boolean; canManageMailboxes?: boolean } = {},
	): Promise<string> {
		const db = createDb();
		await db.insert(users).values({
			id,
			organizationId: ORG,
			email: `${localPart}@agent-mail.test`,
			passwordHash: hashPassword(PASSWORD),
			name: localPart,
			role: "admin",
			canManageMailboxes: options.canManageMailboxes ?? true,
			...(options.enrolled ? { totpEnabledAt: new Date() } : {}),
		});
		return createSession({ DB: db } as unknown as CloudflareEnv, id);
	}

	async function seedMailbox(
		id: string,
		ownerUserId: string,
		localPart: string,
		options: { agentMail?: boolean; type?: "personal" | "shared" } = {},
	): Promise<void> {
		await createDb()
			.insert(mailboxes)
			.values({
				id,
				organizationId: ORG,
				userId: ownerUserId,
				domainId: DOMAIN,
				localPart,
				displayName: localPart,
				type: options.type ?? "personal",
				agentMail: !!options.agentMail,
			});
	}

	describe("enrolment is refused for an owner", () => {
		it("refuses POST /api/auth/two-factor/setup", async () => {
			await seedOrg();
			cookieJar.set(SESSION_COOKIE, await seedUser("usr_agent_owner", "agent"));
			await seedMailbox("mbx_agent", "usr_agent_owner", "agent", { agentMail: true });

			const { POST } = await import("@/app/api/auth/two-factor/setup/route");
			const response = await POST(post("/api/auth/two-factor/setup"), routeCtx());

			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string; message: string };
			expect(body.error).toBe("two_factor_unavailable_agent_mail");
			// The sentence has to name the inbox that does the blocking.
			expect(body.message).toContain("agent@agent-mail.test");
		});

		it("refuses POST /api/auth/two-factor/enable", async () => {
			await seedOrg();
			cookieJar.set(SESSION_COOKIE, await seedUser("usr_agent_owner2", "agent2"));
			await seedMailbox("mbx_agent2", "usr_agent_owner2", "agent2", { agentMail: true });

			const { POST } = await import("@/app/api/auth/two-factor/enable/route");
			const response = await POST(
				post("/api/auth/two-factor/enable", { code: "123456", currentPassword: PASSWORD }),
				routeCtx(),
			);

			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string };
			expect(body.error).toBe("two_factor_unavailable_agent_mail");
		});

		it("reports the block on GET /api/auth/two-factor", async () => {
			await seedOrg();
			cookieJar.set(SESSION_COOKIE, await seedUser("usr_agent_owner3", "agent3"));
			await seedMailbox("mbx_agent3", "usr_agent_owner3", "agent3", { agentMail: true });

			const { GET } = await import("@/app/api/auth/two-factor/route");
			const response = await GET(new Request("http://localhost/api/auth/two-factor"), routeCtx());

			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				blockedByAgentMail: boolean;
				agentMailAddresses: string[];
			};
			expect(body.blockedByAgentMail).toBe(true);
			expect(body.agentMailAddresses).toEqual(["agent3@agent-mail.test"]);
		});
	});

	describe("the organisation requirement does not apply", () => {
		const handler = withOrg(async () => NextResponse.json({ ok: true }));

		it("does not 403 an owner of an agent mailbox", async () => {
			await seedOrg({ requireTwoFactor: true });
			cookieJar.set(SESSION_COOKIE, await seedUser("usr_exempt", "exempt"));
			await seedMailbox("mbx_exempt", "usr_exempt", "exempt", { agentMail: true });

			const response = await handler(new Request("http://localhost/api/mailboxes"), routeCtx());
			expect(response.status).toBe(200);
		});

		it("still 403s a member with no agent mailbox", async () => {
			await seedOrg({ requireTwoFactor: true });
			cookieJar.set(SESSION_COOKIE, await seedUser("usr_plain", "plain"));
			await seedMailbox("mbx_plain", "usr_plain", "plain");

			const response = await handler(new Request("http://localhost/api/mailboxes"), routeCtx());
			expect(response.status).toBe(403);
			await expect(response.json()).resolves.toEqual({ error: "two_factor_required" });
		});

		it("reports the exemption on GET /api/auth/me", async () => {
			await seedOrg({ requireTwoFactor: true });
			cookieJar.set(SESSION_COOKIE, await seedUser("usr_exempt_me", "exemptme"));
			await seedMailbox("mbx_exempt_me", "usr_exempt_me", "exemptme", { agentMail: true });

			const { GET } = await import("@/app/api/auth/me/route");
			const response = await GET(new Request("http://localhost/api/auth/me"), routeCtx());

			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				twoFactor: { requiredByOrganization: boolean; blockedByAgentMail: boolean };
			};
			// False, so the client never redirects them to a panel they cannot use.
			expect(body.twoFactor.requiredByOrganization).toBe(false);
			expect(body.twoFactor.blockedByAgentMail).toBe(true);
		});
	});

	describe("delegated access is not ownership", () => {
		it("leaves a delegate's own two-factor alone", async () => {
			await seedOrg();
			await seedUser("usr_shared_owner", "sharedowner");
			const delegateToken = await seedUser("usr_delegate", "delegate");
			await seedMailbox("mbx_shared_agent", "usr_shared_owner", "team", {
				agentMail: true,
				type: "shared",
			});
			await createDb().insert(mailboxAccess).values({
				id: "mba_delegate",
				mailboxId: "mbx_shared_agent",
				userId: "usr_delegate",
				permission: "full_access",
			});

			cookieJar.set(SESSION_COOKIE, delegateToken);
			const { POST } = await import("@/app/api/auth/two-factor/setup/route");
			const response = await POST(post("/api/auth/two-factor/setup"), routeCtx());

			// The delegate owns no agent mailbox, so enrolment goes ahead as usual.
			expect(response.status).toBe(200);
		});
	});

	describe("setting the flag", () => {
		it("is refused when the owner has two-factor on", async () => {
			await seedOrg();
			cookieJar.set(SESSION_COOKIE, await seedUser("usr_2fa_owner", "twofa", { enrolled: true }));
			await seedMailbox("mbx_2fa_owner", "usr_2fa_owner", "twofa");

			const { PATCH } = await import("@/app/api/mailboxes/[id]/route");
			const response = await PATCH(
				patch("/api/mailboxes/mbx_2fa_owner", { agentMail: true }),
				mailboxCtx("mbx_2fa_owner"),
			);

			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string; message: string };
			expect(body.error).toBe("owner_has_two_factor");
			expect(body.message).toContain("twofa@agent-mail.test");

			// Nothing was written.
			const [row] = await createDb()
				.select({ agentMail: mailboxes.agentMail })
				.from(mailboxes)
				.where(eq(mailboxes.id, "mbx_2fa_owner"))
				.limit(1);
			expect(row?.agentMail).toBe(false);
		});

		it("round-trips through PATCH and shows in the list", async () => {
			await seedOrg();
			cookieJar.set(SESSION_COOKIE, await seedUser("usr_flag", "flag"));
			await seedMailbox("mbx_flag", "usr_flag", "flag");

			const { PATCH } = await import("@/app/api/mailboxes/[id]/route");
			const on = await PATCH(
				patch("/api/mailboxes/mbx_flag", { agentMail: true }),
				mailboxCtx("mbx_flag"),
			);
			expect(on.status).toBe(200);
			expect(((await on.json()) as { mailbox: { agentMail: boolean } }).mailbox.agentMail).toBe(true);

			const db = createDb();
			const listed = await listAccessibleMailboxes(
				db,
				{ id: "usr_flag", email: "flag@agent-mail.test", role: "admin" },
				ORG,
			);
			expect(listed.find((mailbox) => mailbox.id === "mbx_flag")?.agentMail).toBe(true);

			// Turning it off is always allowed, and frees the owner to enrol.
			const off = await PATCH(
				patch("/api/mailboxes/mbx_flag", { agentMail: false }),
				mailboxCtx("mbx_flag"),
			);
			expect(off.status).toBe(200);
			expect(((await off.json()) as { mailbox: { agentMail: boolean } }).mailbox.agentMail).toBe(
				false,
			);

			const { POST } = await import("@/app/api/auth/two-factor/setup/route");
			const setup = await POST(post("/api/auth/two-factor/setup"), routeCtx());
			expect(setup.status).toBe(200);
		});
	});
});
