/**
 * The in-process limiter's key cap.
 *
 * The property that matters is not memory, it is that the eviction policy is
 * not itself a bypass: an attacker who can mint distinct keys (a rotating IP,
 * a rotating email) must not be able to push a victim's exhausted bucket out of
 * the map and hand them a fresh budget.
 */
import { describe, expect, it } from "vitest";
import { createMemoryRateLimit } from "@/lib/auth/memory-rate-limit";

describe("createMemoryRateLimit", () => {
	it("refuses once the budget for a key is spent", async () => {
		const limiter = createMemoryRateLimit({ limit: 3, periodSeconds: 300 });
		for (let i = 0; i < 3; i++) {
			await expect(limiter.limit({ key: "a" })).resolves.toEqual({ success: true });
		}
		await expect(limiter.limit({ key: "a" })).resolves.toEqual({ success: false });
		// A different key has its own budget.
		await expect(limiter.limit({ key: "b" })).resolves.toEqual({ success: true });
	});

	it("keeps a spent bucket through a spray of 60 000 cold keys", async () => {
		const limiter = createMemoryRateLimit({ limit: 5, periodSeconds: 300 });

		for (let i = 0; i < 5; i++) await limiter.limit({ key: "victim" });
		await expect(limiter.limit({ key: "victim" })).resolves.toEqual({ success: false });

		// Well past MAX_KEYS (50 000), so the overflow path runs many times.
		for (let i = 0; i < 60_000; i++) await limiter.limit({ key: `cold-${i}` });

		await expect(limiter.limit({ key: "victim" })).resolves.toEqual({ success: false });
	}, 30_000);
});
