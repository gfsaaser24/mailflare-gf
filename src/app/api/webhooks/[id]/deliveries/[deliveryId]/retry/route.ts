/**
 * T6.3 — replay one delivery by hand.
 *
 * This is how an operator gets a dead-lettered delivery out of the drawer: the
 * same body and the same `X-Mailflare-Delivery` id go out again, so a consumer
 * that deduplicates on the id sees a repeat, not a new event.
 *
 * A successful replay marks the row `delivered`; a failure walks the normal
 * backoff, which can put an already-dead row straight back to `dead`.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { webhookDeliveries, webhooks } from "@/db/schema";
import { withOrg, type RouteContext } from "@/lib/api/with-org";
import { retryDelivery } from "@/lib/webhooks/retry";

export const POST = withOrg(
	async (
		{ db, user, scoped },
		_request,
		{ params }: RouteContext<{ id: string; deliveryId: string }>,
	) => {
		const { id, deliveryId } = await params;

		// Ownership first: the delivery is only reachable through its webhook.
		const [row] = await db
			.select({ id: webhookDeliveries.id })
			.from(webhookDeliveries)
			.innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
			.where(
				and(
					scoped(webhooks),
					eq(webhooks.id, id),
					eq(webhooks.userId, user.id),
					eq(webhookDeliveries.id, deliveryId),
				),
			)
			.limit(1);
		if (!row) return NextResponse.json({ error: "Delivery not found" }, { status: 404 });

		const outcome = await retryDelivery(db, deliveryId);
		if (!outcome) return NextResponse.json({ error: "Delivery not found" }, { status: 404 });

		return NextResponse.json({
			id: outcome.deliveryId,
			status: outcome.status,
			attempts: outcome.attempts,
			error: outcome.error,
		});
	},
);
