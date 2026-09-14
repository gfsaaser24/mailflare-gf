import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";

type Call = { method: string; path: string; body?: unknown };

const env = {
	CF_TOKEN: "token",
	CF_EMAIL_WORKER_NAME: "mailflare-edge",
} as unknown as CloudflareEnv;

const ZONE = "zone1";
const RULES = `/zones/${ZONE}/email/routing/rules`;

const workerRule = (id: string, to: string, enabled = true) => ({
	id,
	enabled,
	matchers: [{ type: "literal", field: "to", value: to }],
	actions: [{ type: "worker", value: ["mailflare-edge"] }],
	priority: 0,
});

const forwardRule = (id: string, to: string) => ({
	id,
	enabled: true,
	name: `${to} forward`,
	matchers: [{ type: "literal", field: "to", value: to }],
	actions: [{ type: "forward", value: ["someone@example.com"] }],
	priority: 0,
});

/**
 * Fake Cloudflare. `lists` is what page 1 of GET returns on the 1st, 2nd, ... listing
 * (the last entry repeats); `onCreate` decides how POST answers.
 */
function fakeCloudflare(opts: { lists: unknown[][]; onCreate?: () => { status: number; body: unknown } }) {
	const calls: Call[] = [];
	let listCount = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const path = url.replace("https://api.cloudflare.com/client/v4", "");
			const method = init?.method ?? "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ method, path, body });
			if (method === "GET" && path.startsWith(RULES)) {
				const page = Number(new URL(url).searchParams.get("page") ?? "1");
				const list = opts.lists[Math.min(listCount, opts.lists.length - 1)];
				if (page === 1) listCount += 1;
				return Response.json({ success: true, errors: [], result: page === 1 ? list : [] });
			}
			if (method === "POST" && path === RULES) {
				const reply = opts.onCreate?.() ?? {
					status: 200,
					body: { success: true, errors: [], result: { id: "new", ...body } },
				};
				return Response.json(reply.body, { status: reply.status });
			}
			if (method === "PUT") {
				const id = path.slice(path.lastIndexOf("/") + 1);
				return Response.json({ success: true, errors: [], result: { id, ...body } });
			}
			throw new Error(`unexpected ${method} ${path}`);
		}),
	);
	return calls;
}

describe("ensureEmailRoutingRuleToWorker", () => {
	beforeEach(() => vi.restoreAllMocks());
	afterEach(() => vi.unstubAllGlobals());

	it("creates a rule when the address has none", async () => {
		const calls = fakeCloudflare({ lists: [[workerRule("r1", "other@callslot.app")]] });
		const rule = await ensureEmailRoutingRuleToWorker(env, ZONE, "Support@callslot.app");
		expect(rule.id).toBe("new");
		expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
			matchers: [{ type: "literal", field: "to", value: "support@callslot.app" }],
			actions: [{ type: "worker", value: ["mailflare-edge"] }],
		});
	});

	it("leaves an enabled rule that already reaches the worker alone", async () => {
		const calls = fakeCloudflare({ lists: [[workerRule("r1", "support@callslot.app")]] });
		const rule = await ensureEmailRoutingRuleToWorker(env, ZONE, "support@callslot.app");
		expect(rule.id).toBe("r1");
		expect(calls.map((c) => c.method)).toEqual(["GET"]);
	});

	it("takes over a hand-made forward rule for the address instead of duplicating it", async () => {
		const calls = fakeCloudflare({ lists: [[forwardRule("fwd", "support@callslot.app")]] });
		const rule = await ensureEmailRoutingRuleToWorker(env, ZONE, "support@callslot.app");
		expect(rule.id).toBe("fwd");
		const put = calls.find((c) => c.method === "PUT");
		expect(put?.path).toBe(`${RULES}/fwd`);
		expect(put?.body).toMatchObject({
			enabled: true,
			actions: [{ type: "worker", value: ["mailflare-edge"] }],
			matchers: [{ type: "literal", field: "to", value: "support@callslot.app" }],
		});
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});

	it("re-enables a disabled worker rule", async () => {
		const calls = fakeCloudflare({ lists: [[workerRule("r1", "support@callslot.app", false)]] });
		await ensureEmailRoutingRuleToWorker(env, ZONE, "support@callslot.app");
		expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ enabled: true });
	});

	it("recovers from a duplicate-rule 409 raised between list and create", async () => {
		const calls = fakeCloudflare({
			lists: [[], [forwardRule("raced", "support@callslot.app")]],
			onCreate: () => ({
				status: 409,
				body: { success: false, errors: [{ code: 2014, message: "Duplicated Zone rule" }], result: null },
			}),
		});
		const rule = await ensureEmailRoutingRuleToWorker(env, ZONE, "support@callslot.app");
		expect(rule.id).toBe("raced");
		expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET", "PUT"]);
	});

	it("rethrows Cloudflare errors that are not the duplicate-rule code", async () => {
		fakeCloudflare({
			lists: [[]],
			onCreate: () => ({
				status: 400,
				body: { success: false, errors: [{ code: 1001, message: "bad request" }], result: null },
			}),
		});
		await expect(ensureEmailRoutingRuleToWorker(env, ZONE, "support@callslot.app")).rejects.toThrow(
			"code 1001",
		);
	});
});
