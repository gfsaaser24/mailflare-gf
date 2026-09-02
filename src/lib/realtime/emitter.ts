import type { NewMessageNotification } from "./types";

type Listener = (payload: NewMessageNotification) => void;

class RealtimeEmitter {
	private listeners = new Map<string, Set<Listener>>();

	subscribe(userId: string, fn: Listener): () => void {
		let set = this.listeners.get(userId);
		if (!set) {
			set = new Set();
			this.listeners.set(userId, set);
		}
		set.add(fn);

		return () => {
			const current = this.listeners.get(userId);
			if (!current) return;
			current.delete(fn);
			if (current.size === 0) this.listeners.delete(userId);
		};
	}

	publish(userId: string, payload: NewMessageNotification): void {
		const set = this.listeners.get(userId);
		if (!set) return;
		for (const fn of set) {
			try {
				fn(payload);
			} catch (error) {
				console.error("Realtime listener failed", error);
			}
		}
	}
}

declare global {
	// eslint-disable-next-line no-var
	var __mailflareRealtimeEmitter: RealtimeEmitter | undefined;
}

export function getRealtimeEmitter(): RealtimeEmitter {
	if (!globalThis.__mailflareRealtimeEmitter) {
		globalThis.__mailflareRealtimeEmitter = new RealtimeEmitter();
	}
	return globalThis.__mailflareRealtimeEmitter;
}
