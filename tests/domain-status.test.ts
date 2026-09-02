import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

/**
 * Cloudflare is mocked wholesale: `zoneState` is the live truth the reconciler
 * reads, so each test can break exactly one thing (MX record, routing switch)
 * and assert the resulting status.
 */
type FakeZoneState = {
	routingEnabled: boolean;
	routingStatus: string;
	catchAllWorker: string | null;
	subdomains: { tag: string; name: string; enabled: boolean }[];
	routingRecords: { type: string; name: string; content: string }[];
	routingMissing: { type: string; name: string; content: string }[];
	sendingRecords: { type: string; name: string; content: string }[];
	failSettings: boolean;
};

const MX = { type: "MX", name: "mail.example.test", content: "route1.mx.cloudflare.net" };
const SPF = { type: "TXT", name: "mail.example.test", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" };
const DKIM = { type: "TXT", name: "cf2024-1._domainkey.mail.example.test", content: "v=DKIM1;" };

const zoneState: FakeZoneState = {
	routingEnabled: true,
	routingStatus: "ready",
	catchAllWorker: "mailflare-edge",
	subdomains: [{ tag: "sub_1", name: "mail.example.test", enabled: true }],
	routingRecords: [MX, SPF],
	routingMissing: [],
	sendingRecords: [DKIM],
	failSettings: false,
};

vi.mock("@/lib/cloudflare-api", () => ({
	getEmailRoutingSettings: vi.fn(async () => {
		if (zoneState.failSettings) throw new Error("Cloudflare API 500");
		return { enabled: zoneState.routingEnabled, status: zoneState.routingStatus };
	}),
	getEmailRoutingDns: vi.fn(async () => ({
		records: zoneState.routingRecords,
		missing: zoneState.routingMissing,
	})),
	listSendingSubdomains: vi.fn(async () => zoneState.subdomains),
	getSendingSubdomainDns: vi.fn(async () => zoneState.sendingRecords),
	// The catch-all rule is read through cfRequest (see domains/cloudflare-cleanup).
	cfRequest: vi.fn(async (_env: unknown, path: string) => {
		if (path.endsWith("/email/routing/rules/catch_all")) {
			if (!zoneState.catchAllWorker) return null;
			return {
				enabled: true,
				actions: [{ type: "worker", value: [zoneState.catchAllWorker] }],
				matchers: [{ type: "all" }],
			};
		}
		throw new Error(`unexpected cfRequest ${path}`);
	}),
	listEmailRoutingRules: vi.fn(async () => []),
	deleteEmailRoutingRule: vi.fn(async () => ({})),
	deleteSendingSubdomain: vi.fn(async () => ({})),
	disableEmailRouting: vi.fn(async () => ({})),
}));

const { reconcileAllDomains, reconcileDomain } = await import("@/lib/domains/status");
const { domains, users } = await import("@/db/schema");
const { closeTestDatabase, createDb, hasTestDatabase, truncateAll } = await import("./helpers/db");

const USER_ID = "usr_domain_status";
const DOMAIN_ID = "dom_status_1";
const HOSTNAME = "mail.example.test";

function testEnv() {
	return { DB: createDb(), CF_EMAIL_WORKER_NAME: "mailflare-edge" } as unknown as CloudflareEnv;
}

function resetCloudflare() {
	zoneState.routingEnabled = true;
	zoneState.routingStatus = "ready";
	zoneState.catchAllWorker = "mailflare-edge";
	zoneState.subdomains = [{ tag: "sub_1", name: HOSTNAME, enabled: true }];
	zoneState.routingRecords = [MX, SPF];
	zoneState.routingMissing = [];
	zoneState.sendingRecords = [DKIM];
	zoneState.failSettings = false;
	vi.clearAllMocks();
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

async function insertDomain(
	overrides: Partial<{
		id: string;
		hostname: string;
		routingEnabled: boolean;
		sendingEnabled: boolean;
		sendingSubdomainTag: string | null;
	}> = {},
) {
	const values = {
		id: overrides.id ?? DOMAIN_ID,
		userId: USER_ID,
		hostname: overrides.hostname ?? HOSTNAME,
		zoneId: "zone_1",
		status: "pending" as const,
		routingEnabled: overrides.routingEnabled ?? true,
		sendingEnabled: overrides.sendingEnabled ?? true,
		sendingSubdomainTag:
			overrides.sendingSubdomainTag === undefined ? "sub_1" : overrides.sendingSubdomainTag,
	};
	await createDb().insert(domains).values(values);
	return values.id;
}

async function readDomain(id: string) {
	const [row] = await createDb().select().from(domains).where(eq(domains.id, id)).limit(1);
	return row!;
}

describe.skipIf(!hasTestDatabase())("reconcileDomain", () => {
	beforeEach(async () => {
		await truncateAll();
		resetCloudflare();
		await insertOwner();
	});

	afterAll(async () => {
		await closeTestDatabase();
	});

	it("marks a healthy domain active and records the check", async () => {
		await insertDomain();

		const result = await reconcileDomain(testEnv(), DOMAIN_ID);

		expect(result.status).toBe("active");
		expect(result.statusReason).toBeNull();
		expect(result.dnsOk).toBe(true);

		const row = await readDomain(DOMAIN_ID);
		expect(row.status).toBe("active");
		expect(row.statusReason).toBeNull();
		expect(row.dnsOk).toBe(true);
		expect(row.routingStatus).toBe("ready");
		expect(row.lastCheckedAt).toBeInstanceOf(Date);
	});

	it("flips to error with a reason when the MX record is missing", async () => {
		await insertDomain();
		zoneState.routingRecords = [SPF];
		zoneState.routingMissing = [MX];

		const result = await reconcileDomain(testEnv(), DOMAIN_ID);

		expect(result.status).toBe("error");
		expect(result.dnsOk).toBe(false);
		expect(result.statusReason).toContain("MX");

		const row = await readDomain(DOMAIN_ID);
		expect(row.status).toBe("error");
		expect(row.statusReason).toContain("MX");
		expect(row.dnsOk).toBe(false);
	});

	it("goes back to active once the MX record is restored", async () => {
		await insertDomain();
		zoneState.routingRecords = [SPF];
		zoneState.routingMissing = [MX];
		await reconcileDomain(testEnv(), DOMAIN_ID);

		resetCloudflare();
		const result = await reconcileDomain(testEnv(), DOMAIN_ID);

		expect(result.status).toBe("active");
		expect((await readDomain(DOMAIN_ID)).statusReason).toBeNull();
	});

	it("errors when Email Routing is switched off on the zone", async () => {
		await insertDomain();
		zoneState.routingEnabled = false;
		zoneState.routingStatus = "unconfigured";

		const result = await reconcileDomain(testEnv(), DOMAIN_ID);

		expect(result.status).toBe("error");
		expect(result.statusReason).toContain("Email Routing is disabled");
		expect((await readDomain(DOMAIN_ID)).status).toBe("error");
	});

	it("errors when the catch-all rule no longer points at the worker", async () => {
		await insertDomain();
		zoneState.catchAllWorker = "some-other-worker";

		const result = await reconcileDomain(testEnv(), DOMAIN_ID);

		expect(result.status).toBe("error");
		expect(result.statusReason).toContain("catch-all");
	});

	it("errors with the Cloudflare message when the API call fails", async () => {
		await insertDomain();
		zoneState.failSettings = true;

		const result = await reconcileDomain(testEnv(), DOMAIN_ID);

		expect(result.status).toBe("error");
		expect(result.statusReason).toContain("Cloudflare API 500");
		expect(result.dnsOk).toBe(false);
	});

	it("stays pending for a row that was never provisioned", async () => {
		await insertDomain({
			routingEnabled: false,
			sendingEnabled: false,
			sendingSubdomainTag: null,
		});

		const result = await reconcileDomain(testEnv(), DOMAIN_ID);

		expect(result.status).toBe("pending");
		expect(result.statusReason).toBeNull();
		const row = await readDomain(DOMAIN_ID);
		expect(row.status).toBe("pending");
		expect(row.lastCheckedAt).toBeInstanceOf(Date);
	});

	it("throws for an unknown domain", async () => {
		await expect(reconcileDomain(testEnv(), "dom_missing")).rejects.toThrow("Domain not found");
	});
});

describe.skipIf(!hasTestDatabase())("reconcileAllDomains", () => {
	beforeEach(async () => {
		await truncateAll();
		resetCloudflare();
		await insertOwner();
	});

	afterAll(async () => {
		await closeTestDatabase();
	});

	it("touches every row", async () => {
		await insertDomain({ id: "dom_a", hostname: HOSTNAME });
		await insertDomain({ id: "dom_b", hostname: "other.example.test" });
		await insertDomain({
			id: "dom_c",
			hostname: "unprovisioned.example.test",
			routingEnabled: false,
			sendingEnabled: false,
			sendingSubdomainTag: null,
		});

		const { results, failures } = await reconcileAllDomains(testEnv());

		expect(failures).toEqual([]);
		expect(results.map((r) => r.domainId).sort()).toEqual(["dom_a", "dom_b", "dom_c"]);
		for (const id of ["dom_a", "dom_b", "dom_c"]) {
			expect((await readDomain(id)).lastCheckedAt).toBeInstanceOf(Date);
		}
		expect((await readDomain("dom_a")).status).toBe("active");
		expect((await readDomain("dom_b")).status).toBe("active");
		expect((await readDomain("dom_c")).status).toBe("pending");
	});
});
