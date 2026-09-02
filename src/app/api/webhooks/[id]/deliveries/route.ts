/**
 * T6.3 — the delivery log of one webhook (last 50 attempts, newest first).
 *
 * `webhook_deliveries` has no `organization_id` of its own: it is scoped
 * through its parent `webhooks` row, which is what the ownership check below
 * establishes before anything is read.
 */
import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { webhookDeliveries, webhooks } from "@/db/schema";
import { withOrg, type RouteContext } from "@/lib/api/with-org";

/** How many rows the drawer shows. */
export const DELIVERY_PAGE_SIZE = 50;

export const GET = withOrg(
	async ({ db, user, scoped }, _request, { params }: RouteContext<{ id: string }>) => {
		const { id } = await params;

		const [hook] = await db
			.select({ id: webhooks.id })
			.from(webhooks)
			.where(and(scoped(webhooks), eq(webhooks.id, id), eq(webhooks.userId, user.id)))
			.limit(1);
		if (!hook) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });

		const rows = await db
			.select({
				id: webhookDeliveries.id,
				eventType: webhookDeliveries.eventType,
				status: webhookDeliveries.status,
				attempts: webhookDeliveries.attempts,
				lastError: webhookDeliveries.lastError,
				responseStatus: webhookDeliveries.responseStatus,
				nextAttemptAt: webhookDeliveries.nextAttemptAt,
				deliveredAt: webhookDeliveries.deliveredAt,
				createdAt: webhookDeliveries.createdAt,
			})
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.webhookId, hook.id))
			.orderBy(desc(webhookDeliveries.createdAt))
			.limit(DELIVERY_PAGE_SIZE);

		return NextResponse.json({ deliveries: rows });
	},
);
