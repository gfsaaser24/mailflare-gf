const MAX_KEYS = 10_000;
const EVICT_BATCH = 1_000;

/** In-process sliding-window limiter with a hard cap on tracked keys. Good enough for a single app container. */
export function createMemoryRateLimit(options: { limit: number; periodSeconds: number }) {
	const hits = new Map<string, number[]>();
	const period = options.periodSeconds * 1000;
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
				// Bounded eviction: drop the oldest keys until we are back under the cap.
				for (const k of hits.keys()) {
					if (hits.size <= MAX_KEYS - EVICT_BATCH) break;
					hits.delete(k);
				}
			}
			return { success: true };
		},
	};
}
