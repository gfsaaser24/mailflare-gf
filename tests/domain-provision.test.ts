import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

/**
 * Cloudflare is mocked wholesale: a small in-memory zone whose state the
 * provisioner mutates, so we can assert exactly which resources were created
 * and which were reused or rolled back.
 */
type FakeZoneState = {
	routingEnabled: boolean;
	subdomains: { tag: string; name: string; enabled: boolean }[];
	catchAll: { actions?: { type: string; value?: string[] }[]; enabled?: boolean } | null;
};

const zoneState: FakeZoneState = { routingEnabled: false, subdomains: [], catchAll: null };
let failCatchAllPut = false;
let subdomainCounter = 0;

vi.mock("@/lib/cloudflare-api", () => ({
	findZoneByHostname: vi.fn(async () => ({ id: "zone_1", name: "example.test" })),
	getEmailRoutingSettings: vi.fn(async () => ({
		enabled: zoneState.routingEnabled,
		status: zoneState.routingEnabled ? "ready" : "unconfigured",
	})),
	enableEmailRouting: vi.fn(async () => {
		zoneState.routingEnabled = true;
		return { enabled: true, status: "ready" };
	}),
	disableEmailRouting: vi.fn(async () => {
		zoneState.routingEnabled = false;
		return {};
	}),
	listSendingSubdomains: vi.fn(async () => zoneState.subdomains),
	createSendingSubdomain: vi.fn(async (_env: unknown, _zoneId: string, name: string) => {
		subdomainCounter += 1;
		const sub = { tag: `sub_${subdomainCounter}`, name, enabled: true };
		zoneState.subdomains.push(sub);
		return sub;
	}),
	deleteSendingSubdomain: vi.fn(async (_env: unknown, _zoneId: string, tag: string) => {
		zoneState.subdomains = zoneState.subdomains.filter((sub) => sub.tag !== tag);
		return {};
	}),
	// The catch-all endpoints go through cfRequest.
	cfRequest: vi.fn(async (_env: unknown, path: string, init?: RequestInit) => {
		if (path.endsWith("/email/routing/rules/catch_all")) {
			if (init?.method === "PUT") {
				if (failCatchAllPut) throw new Error("catch-all rule write failed");
				zoneState.catchAll = JSON.parse(String(init.body));
				return zoneState.catchAll;
			}
			return zoneState.catchAll;
		}
		throw new Error(`unexpected cfRequest ${path}`);
	}),
	getEmailRoutingDns: vi.fn(async () => ({ records: [], missing: [] })),
	getSendingSubdomainDns: vi.fn(async () => []),
	listEmailRoutingRules: vi.fn(async () => []),
	deleteEmailRoutingRule: vi.fn(async () => ({})),
}));

const cf = await import("@/lib/cloudflare-api");
const { DomainProvisionError, provisionDomain } = await import("@/lib/domains/provision");
const { domains, users } = await import("@/db/schema");
const { closeTestDatabase, createDb, hasTestDatabase, truncateAll } = await import("./helpers/db");

const HOSTNAME = "mail.example.test";
const USER_ID = "usr_domain_owner";

function testEnv() {
	return { DB: createDb(), CF_EMAIL_WORKER_NAME: "mailflare-edge" } as unknown as CloudflareEnv;
}

async function insertOwner() {
	await createDb().insert(users).values({
		id: USER_ID,
		email: `admin@${HOSTNAME}`,
		passwordHash: "x",
		name: "admin",
		role: "admin",
	});
}

function resetCloudflare() {
	zoneState.routingEnabled = false;
	zoneState.subdomains = [];
	zoneState.catchAll = null;
	failCatchAllPut = false;
	subdomainCounter = 0;
	vi.clearAllMocks();
}

describe.skipIf(!hasTestDatabase())("provisionDomain", () => {
	beforeEach(async () => {
		await truncateAll();
		resetCloudflare();
	});

	afterAll(async () => {
		await closeTestDatabase();
	});

	it("creates routing, the sending subdomain, the catch-all rule and the row", async () => {
		await insertOwner();
		const env = testEnv();

		const result = await provisionDomain(env, {
			hostname: HOSTNAME,
			userId: USER_ID,
			enableRouting: true,
			enableSending: true,
		});

		expect(result.created).toEqual({ routing: true, sendingSubdomain: true, catchAllRule: true });
		expect(result.domain?.hostname).toBe(HOSTNAME);
		expect(result.domain?.zoneId).toBe("zone_1");
		expect(result.domain?.status).toBe("active");
		expect(result.domain?.sendingSubdomainTag).toBe("sub_1");

		expect(zoneState.routingEnabled).toBe(true);
		expect(zoneState.subdomains).toHaveLength(1);
		expect(zoneState.catchAll?.actions?.[0]?.value).toEqual(["mailflare-edge"]);

		const rows = await createDb().select().from(domains).where(eq(domains.hostname, HOSTNAME));
		expect(rows).toHaveLength(1);
	});

	it("rolls back the subdomain and routing when the rules step fails, writing no row", async () => {
		await insertOwner();
		const env = testEnv();
		failCatchAllPut = true;

		const error = await provisionDomain(env, {
			hostname: HOSTNAME,
			userId: USER_ID,
			enableRouting: true,
			enableSending: true,
		}).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(DomainProvisionError);
		expect((error as InstanceType<typeof DomainProvisionError>).step).toBe("rules");
		expect((error as Error).cause).toBeInstanceOf(Error);

		// Everything this call created is gone again.
		expect(cf.deleteSendingSubdomain).toHaveBeenCalledWith(env, "zone_1", "sub_1");
		expect(cf.disableEmailRouting).toHaveBeenCalledWith(env, "zone_1");
		expect(zoneState.subdomains).toHaveLength(0);
		expect(zoneState.routingEnabled).toBe(false);

		const rows = await createDb().select().from(domains).where(eq(domains.hostname, HOSTNAME));
		expect(rows).toHaveLength(0);
	});

	it("keeps pre-existing Cloudflare state when a later step fails", async () => {
		await insertOwner();
		const env = testEnv();
		// Routing and the subdomain were already there before this call.
		zoneState.routingEnabled = true;
		zoneState.subdomains = [{ tag: "sub_pre", name: HOSTNAME, enabled: true }];
		failCatchAllPut = true;

		await expect(
			provisionDomain(env, { hostname: HOSTNAME, userId: USER_ID }),
		).rejects.toBeInstanceOf(DomainProvisionError);

		expect(cf.disableEmailRouting).not.toHaveBeenCalled();
		expect(cf.deleteSendingSubdomain).not.toHaveBeenCalled();
		expect(zoneState.routingEnabled).toBe(true);
		expect(zoneState.subdomains).toHaveLength(1);
	});

	it("is idempotent: a rerun creates nothing new and returns the same row", async () => {
		await insertOwner();
		const env = testEnv();

		const first = await provisionDomain(env, { hostname: HOSTNAME, userId: USER_ID });
		vi.clearAllMocks();

		const second = await provisionDomain(env, { hostname: HOSTNAME, userId: USER_ID });

		expect(second.created).toEqual({ routing: false, sendingSubdomain: false, catchAllRule: false });
		expect(cf.enableEmailRouting).not.toHaveBeenCalled();
		expect(cf.createSendingSubdomain).not.toHaveBeenCalled();
		const catchAllWrites = vi
			.mocked(cf.cfRequest)
			.mock.calls.filter(([, , init]) => (init as RequestInit | undefined)?.method === "PUT");
		expect(catchAllWrites).toHaveLength(0);

		expect(second.domain?.id).toBe(first.domain?.id);
		const rows = await createDb().select().from(domains).where(eq(domains.hostname, HOSTNAME));
		expect(rows).toHaveLength(1);
	});

	it("writes no row when no userId is given, but still provisions Cloudflare", async () => {
		const env = testEnv();

		const result = await provisionDomain(env, { hostname: HOSTNAME });

		expect(result.domain).toBeNull();
		expect(result.created.routing).toBe(true);
		const rows = await createDb().select().from(domains);
		expect(rows).toHaveLength(0);
	});

	it("refuses a hostname already owned by someone else and rolls back", async () => {
		await insertOwner();
		const db = createDb();
		await db.insert(users).values({
			id: "usr_other",
			email: "other@example.test",
			passwordHash: "x",
			name: "other",
			role: "admin",
		});
		await db.insert(domains).values({
			id: "dom_existing",
			userId: "usr_other",
			hostname: HOSTNAME,
			zoneId: "zone_1",
		});

		const env = testEnv();
		const error = await provisionDomain(env, { hostname: HOSTNAME, userId: USER_ID }).catch(
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(DomainProvisionError);
		expect((error as InstanceType<typeof DomainProvisionError>).step).toBe("db");
		// The row still belongs to the original owner.
		const [row] = await db.select().from(domains).where(eq(domains.hostname, HOSTNAME));
		expect(row?.userId).toBe("usr_other");
		// And the Cloudflare work this call did was undone.
		expect(cf.disableEmailRouting).toHaveBeenCalled();
		expect(cf.deleteSendingSubdomain).toHaveBeenCalled();
	});
});
