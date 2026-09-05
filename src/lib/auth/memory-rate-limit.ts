/**
 * In-process sliding-window limiter with a hard cap on tracked keys. Good
 * enough for a single app container.
 *
 * The cap used to be enforced by evicting the 1 000 least-recently-seen keys,
 * which made the limiter itself the bypass: spraying distinct keys (one request
 * each from a rotating IP or email) pushed a victim's bucket out of the map and
 * handed them a fresh budget. Overflow now drops EXPIRED keys first — entries
 * whose every hit is already outside the window, which are pure garbage — and
 * only falls back to evicting live entries if the map is still over the cap.
 * The cap is 50 000, so a spray has to be large and sustained before it can
 * even reach that fallback.
 */
const MAX_KEYS = 50_000;
const EVICT_BATCH = 1_000;

export function createMemoryRateLimit(options: { limit: number; periodSeconds: number }) {
	const hits = new Map<string, number[]>();
	const period = options.periodSeconds * 1000;

	/** Drops every key with no hit left inside the window. Returns nothing. */
	function purgeExpired(now: number): void {
		for (const [key, times] of hits) {
			const last = times[times.length - 1];
			if (last === undefined || now - last >= period) hits.delete(key);
		}
	}

	/**
	 * Drops keys in least-recently-seen order until the map is back under the
	 * cap by one batch. With `spareExhausted`, a bucket that is already at its
	 * limit is left alone.
	 */
	function evictOldest(now: number, spareExhausted: boolean): void {
		for (const [k, times] of hits) {
			if (hits.size <= MAX_KEYS - EVICT_BATCH) break;
			if (spareExhausted) {
				const live = times.filter((t) => now - t < period).length;
				if (live >= options.limit) continue;
			}
			hits.delete(k);
		}
	}

	return {
		async limit({ key }: { key: string }): Promise<{ success: boolean }> {
			const now = Date.now();
			const recent = (hits.get(key) ?? []).filter((t) => now - t < period);
			if (recent.length >= options.limit) {
				hits.set(key, recent);
				return { success: false };
			}
			recent.push(now);
			// Re-insert so Map iteration order == least recently seen first.
			hits.delete(key);
			hits.set(key, recent);
			if (hits.size > MAX_KEYS) {
				purgeExpired(now);
				// Still over the cap: everything tracked is live. Evict the
				// oldest, but skip buckets that are already at their limit —
				// dropping one of those is precisely the free budget a spray is
				// after. The key just written was re-inserted last, so it is the
				// last thing this loop would ever reach.
				if (hits.size > MAX_KEYS) evictOldest(now, true);
				// Every remaining bucket is exhausted: the map still has to stay
				// bounded, so give up the protection rather than the memory.
				if (hits.size > MAX_KEYS) evictOldest(now, false);
			}
			return { success: true };
		},
	};
}
