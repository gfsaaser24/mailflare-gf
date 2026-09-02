/** In-process sliding-window limiter. Good enough for a single app container. */
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
			hits.set(key, recent);
			if (hits.size > 10_000) {
				for (const [k, v] of hits) if (v.every((t) => now - t >= period)) hits.delete(k);
			}
			return { success: true };
		},
	};
}
