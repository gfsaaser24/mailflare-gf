/**
 * Mailflare edge worker.
 *
 * Cloudflare keeps exactly two jobs and stores nothing:
 *   1. Email Routing delivers inbound mail to `email()`, which relays the raw
 *      message to the app at `${APP_URL}/api/edge/inbound`.
 *   2. `POST /send` relays outbound mail through the `send_email` binding.
 */

/** Must match MAILFLARE_FORWARDED_HEADER in src/lib/email/account-forwarding.ts. */
const MAILFLARE_FORWARDED_HEADER = "x-mailflare-forwarded";

export interface Env {
	/** Public URL of the Mailflare app. */
	APP_URL: string;
	/** Shared secret with the app (wrangler secret). */
	EDGE_WORKER_SECRET: string;
	/** Cloudflare outbound relay binding. */
	EMAIL: SendEmail;
}

type InboundResponse = { ok: true; forwardTo?: string };

type SendRequestAttachment = {
	filename: string;
	type: string;
	/** base64 */
	content: string;
	disposition: "attachment" | "inline";
	contentId?: string;
};

type SendRequestBody = {
	from: string;
	to: string;
	subject: string;
	headers?: Record<string, string>;
	html?: string;
	text?: string;
	attachments?: SendRequestAttachment[];
};

export default {
	async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
		const raw = await new Response(message.raw).arrayBuffer();
		const alreadyForwarded = message.headers.get(MAILFLARE_FORWARDED_HEADER) !== null;

		let response: Response;
		try {
			response = await fetch(appUrl(env) + "/api/edge/inbound", {
				method: "POST",
				headers: {
					Authorization: "Bearer " + env.EDGE_WORKER_SECRET,
					"Content-Type": "message/rfc822",
					"X-Mail-From": message.from,
					"X-Mail-To": message.to,
					"X-Mail-Headers": JSON.stringify(Object.fromEntries(message.headers)),
				},
				body: raw,
			});
		} catch (error) {
			console.error("Inbound relay failed for " + message.to, error);
			message.setReject("Temporarily unavailable, try again");
			return;
		}

		if (response.status === 404) {
			message.setReject("Unknown recipient");
			return;
		}
		if (!response.ok) {
			console.error(
				"Inbound relay returned " + response.status + " for " + message.to,
				(await response.text().catch(() => "")).slice(0, 300),
			);
			message.setReject("Temporarily unavailable, try again");
			return;
		}

		const result = (await response.json().catch(() => null)) as InboundResponse | null;
		const forwardTo = result?.forwardTo;
		if (!forwardTo || alreadyForwarded) return;

		try {
			const headers = new Headers();
			headers.set(MAILFLARE_FORWARDED_HEADER, "1");
			await message.forward(forwardTo, headers);
		} catch (error) {
			console.error("Account forwarding failed for " + message.to, error);
		}
	},

	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/health") {
			return new Response("ok", { status: 200 });
		}

		if (request.method === "POST" && url.pathname === "/send") {
			if (!isAuthorized(request, env)) {
				return json({ error: "Unauthorized" }, 401);
			}
			let body: SendRequestBody;
			try {
				body = (await request.json()) as SendRequestBody;
			} catch {
				return json({ error: "Invalid JSON body" }, 400);
			}
			if (!body?.from || !body?.to) {
				return json({ error: "from and to are required" }, 400);
			}
			try {
				const result = await env.EMAIL.send({
					from: body.from,
					to: body.to,
					subject: body.subject ?? "",
					headers: body.headers,
					html: body.html,
					text: body.text,
					attachments: (body.attachments ?? []).map((attachment) =>
						attachment.disposition === "inline" && attachment.contentId
							? {
									filename: attachment.filename,
									type: attachment.type,
									content: fromBase64(attachment.content),
									disposition: "inline" as const,
									contentId: attachment.contentId,
								}
							: {
									filename: attachment.filename,
									type: attachment.type,
									content: fromBase64(attachment.content),
									disposition: "attachment" as const,
								},
					),
				});
				return json({ messageId: result.messageId }, 200);
			} catch (error) {
				console.error("Outbound send failed for " + body.to, error);
				return json({ error: error instanceof Error ? error.message : "Send failed" }, 502);
			}
		}

		return json({ error: "Not found" }, 404);
	},
};

function appUrl(env: Env): string {
	return (env.APP_URL ?? "").replace(/\/$/, "");
}

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function isAuthorized(request: Request, env: Env): boolean {
	const header = request.headers.get("Authorization") ?? "";
	const prefix = "Bearer ";
	if (!header.startsWith(prefix)) return false;
	return timingSafeEqual(header.slice(prefix.length), env.EDGE_WORKER_SECRET ?? "");
}

function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	// Length is not secret, but bail out early so the loop below stays constant time.
	if (left.byteLength === 0 || left.byteLength !== right.byteLength) return false;
	let diff = 0;
	for (let i = 0; i < left.byteLength; i++) diff |= left[i] ^ right[i];
	return diff === 0;
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
