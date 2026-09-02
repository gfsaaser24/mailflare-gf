/**
 * T6.3 — one webhook endpoint.
 *
 * `PATCH` changes the url, the subscribed events, the description or the
 * enabled flag; `DELETE` removes the endpoint (and, by cascade, its delivery
 * history).
 *
 * Both are scoped to the caller's organisation *and* to the caller as the
 * owner. Anything else is a 404, so an unrelated caller learns nothing about
 * whether the id exists.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { webhooks } from "@/db/schema";
import { withOrg, type RouteContext } from "@/lib/api/with-org";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { webhookUpdateSchema } from "@/lib/validators";

export const GET = withOrg(
	async ({ db, user, scoped }, _request, { params }: RouteContext<{ id: string }>) => {
		const { id } = await params;
		const [row] = await db
			.select()
			.from(webhooks)
			.where(and(scoped(webhooks), eq(webhooks.id, id), eq(webhooks.userId, user.id)))
			.limit(1);
		if (!row) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
		return NextResponse.json({
			id: row.id,
			url: row.url,
			events: row.events,
			description: row.description,
			enabled: row.enabled,
			createdAt: row.createdAt,
		});
	},
);

export const PATCH = withOrg(
	async ({ db, user, scoped }, request, { params }: RouteContext<{ id: string }>) => {
		const { id } = await params;

		let body: unknown;
		try {
			body = await readJsonBody(request, 16 * 1024);
		} catch (error) {
			const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
			return NextResponse.json({ error: "Invalid webhook request" }, { status });
		}
		const parsed = webhookUpdateSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
		}

		const values: Partial<typeof webhooks.$inferInsert> = {};
		if (parsed.data.url !== undefined) values.url = parsed.data.url;
		if (parsed.data.events !== undefined) values.events = JSON.stringify(parsed.data.events);
		if (parsed.data.description !== undefined) values.description = parsed.data.description ?? null;
		if (parsed.data.enabled !== undefined) values.enabled = parsed.data.enabled;
		if (Object.keys(values).length === 0) {
			return NextResponse.json({ error: "No fields to update" }, { status: 400 });
		}

		const [row] = await db
			.update(webhooks)
			.set(values)
			.where(and(scoped(webhooks), eq(webhooks.id, id), eq(webhooks.userId, user.id)))
			.returning();
		if (!row) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });

		return NextResponse.json({
			id: row.id,
			url: row.url,
			events: row.events,
			description: row.description,
			enabled: row.enabled,
		});
	},
);

export const DELETE = withOrg(
	async ({ db, user, scoped }, _request, { params }: RouteContext<{ id: string }>) => {
		const { id } = await params;
		const [row] = await db
			.delete(webhooks)
			.where(and(scoped(webhooks), eq(webhooks.id, id), eq(webhooks.userId, user.id)))
			.returning({ id: webhooks.id });
		if (!row) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
		return NextResponse.json({ id: row.id, deleted: true });
	},
);
