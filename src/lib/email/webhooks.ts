import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users, webhookDeliveries, webhooks } from "@/db/schema";
import { newId } from "@/lib/ids";
import { sanitizeHtmlFields } from "@/lib/email/sanitize";

export type WebhookEventType = "message.inbound" | "message.outbound" | "message.failed";

/**
 * Fans a message event out to the webhooks of one user **inside one
 * organisation**.
 *
 * `orgId` is the organisation the message belongs to (`ctx.orgId`, or the
 * mailbox's `organization_id`). When it is omitted it is resolved from the
 * user's own organisation, so the org filter is never silently skipped; a
 * webhook row from another organisation is never dispatched to.
 */
export async function dispatchWebhooks(
	env: CloudflareEnv,
	userId: string,
	eventType: WebhookEventType,
	payload: Record<string, unknown>,
	orgId?: string,
): Promise<void> {
	const db = getDb(env);

	let organizationId = orgId;
	if (!organizationId) {
		const [owner] = await db
			.select({ organizationId: users.organizationId })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		organizationId = owner?.organizationId;
	}
	if (!organizationId) return;

	const hooks = await db
		.select()
		.from(webhooks)
		.where(and(eq(webhooks.organizationId, organizationId), eq(webhooks.userId, userId)));

	// Webhook consumers render whatever we hand them, so any HTML in the
	// payload goes out sanitised; everything else is plain text.
	const safePayload = sanitizeHtmlFields(payload);

	for (const hook of hooks) {
		if (!hook.enabled) continue;
		let events: string[] = [];
		try {
			events = JSON.parse(hook.events) as string[];
		} catch {
			continue;
		}
		if (!events.includes(eventType)) continue;

		const deliveryId = newId();
		const body = JSON.stringify({ type: eventType, data: safePayload });
		await db.insert(webhookDeliveries).values({
			id: deliveryId,
			webhookId: hook.id,
			eventType,
			payload: body,
			status: "pending",
			attempts: 0,
		});

		try {
			const signature = await signPayload(hook.secret, body);
			const res = await fetch(hook.url, {
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
				headers: {
					"Content-Type": "application/json",
					"X-Email-Platform-Signature": signature,
					"X-Email-Platform-Event": eventType,
				},
				body,
			});
			await db
				.update(webhookDeliveries)
				.set({ status: res.ok ? "delivered" : "failed", attempts: 1 })
				.where(eq(webhookDeliveries.id, deliveryId));
		} catch {
			await db
				.update(webhookDeliveries)
				.set({ status: "failed", attempts: 1 })
				.where(eq(webhookDeliveries.id, deliveryId));
		}
	}
}

async function signPayload(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
