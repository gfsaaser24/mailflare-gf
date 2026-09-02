import { getUserFromSession } from "@/lib/auth/session";
import { getEnv } from "@/lib/cloudflare";
import { getRealtimeEmitter } from "@/lib/realtime/emitter";
import { getSessionTokenFromRequest } from "@/lib/realtime/utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 25_000;

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getUserFromSession(env, getSessionTokenFromRequest(request));
	if (!user || user.disabled) {
		return new Response("Unauthorized", { status: 401 });
	}

	const emitter = getRealtimeEmitter();
	const encoder = new TextEncoder();

	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(": connected\n\n"));

			unsubscribe = emitter.subscribe(user.id, (payload) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
				} catch {
					// Controller may already be closed.
				}
			});

			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": ping\n\n"));
				} catch {
					// Controller may already be closed.
				}
			}, HEARTBEAT_INTERVAL_MS);

			const cleanup = () => {
				if (heartbeat) clearInterval(heartbeat);
				heartbeat = null;
				unsubscribe?.();
				unsubscribe = null;
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			};

			request.signal.addEventListener("abort", cleanup);
		},
		cancel() {
			if (heartbeat) clearInterval(heartbeat);
			heartbeat = null;
			unsubscribe?.();
			unsubscribe = null;
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}
