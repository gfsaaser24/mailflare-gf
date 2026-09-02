export type OutboundAttachment = {
	filename: string;
	type: string;
	content: ArrayBuffer | Uint8Array;
	disposition: "attachment" | "inline";
	contentId?: string;
};

export type OutboundMessage = {
	from: string;
	to: string;
	subject: string;
	headers?: Record<string, string>;
	html?: string;
	text?: string;
	attachments?: OutboundAttachment[];
};

export interface EmailSender {
	send(message: OutboundMessage): Promise<{ messageId: string }>;
}

/**
 * Sends through the thin Cloudflare edge worker (cloudflare-worker/), which owns the
 * `send_email` binding. Nothing is stored on Cloudflare; it only relays the message.
 */
export class EdgeWorkerEmailSender implements EmailSender {
	constructor(
		private readonly url: string,
		private readonly secret: string,
	) {}

	async send(message: OutboundMessage): Promise<{ messageId: string }> {
		const attachments = (message.attachments ?? []).map((a) => ({
			...a,
			content: toBase64(a.content),
		}));
		const base = this.url.replace(/\/$/, "");
		const response = await fetch(base + "/send", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.secret },
			body: JSON.stringify({ ...message, attachments }),
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error("Edge send failed (" + response.status + "): " + detail.slice(0, 300));
		}
		return (await response.json()) as { messageId: string };
	}
}

/** Used when no transport is configured (dev): logs and pretends to send. */
export class NoopEmailSender implements EmailSender {
	async send(message: OutboundMessage): Promise<{ messageId: string }> {
		console.warn("[email] no transport configured; dropping message to " + message.to + " (" + message.subject + ")");
		return { messageId: "noop-" + Date.now() };
	}
}

function toBase64(content: ArrayBuffer | Uint8Array): string {
	const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
	return Buffer.from(bytes).toString("base64");
}
