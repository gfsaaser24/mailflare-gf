import { getUserFromSession } from "@/lib/auth/session";
import { enforceTwoFactorPolicy } from "@/lib/auth/two-factor-policy";
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
	// The stream carries sender, subject and message ids for every inbound mail,
	// so it sits behind the same organisation two-factor gate as every other door.
	const gated = await enforceTwoFactorPolicy(env, user, request);
	if (gated) return gated;

	const emitter = getRealtimeEmitter();
	const encoder = new TextEncoder();

	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(": connected\n\n"));

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

			// Bounded delivery: a client that stops reading gets disconnected instead of
			// growing the stream queue without limit. It will reconnect (EventSource) and
			// fall back to polling for anything it missed.
			const send = (chunk: string) => {
				if ((controller.desiredSize ?? 0) <= 0) {
					cleanup();
					return;
				}
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					// Controller may already be closed.
				}
			};

			unsubscribe = emitter.subscribe(user.id, (payload) => send(`data: ${JSON.stringify(payload)}\n\n`));
			heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_INTERVAL_MS);

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
