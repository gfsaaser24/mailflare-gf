import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { webhooks } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { newId } from "@/lib/ids";
import { webhookSchema } from "@/lib/validators";

export const GET = withOrg(async ({ db, user, scoped }) => {
	const rows = await db
		.select()
		.from(webhooks)
		.where(and(scoped(webhooks), eq(webhooks.userId, user.id)));
	return NextResponse.json({
		webhooks: rows.map((w) => ({
			id: w.id,
			url: w.url,
			events: w.events,
			description: w.description,
			enabled: w.enabled,
			createdAt: w.createdAt,
		})),
	});
});

export const POST = withOrg(async ({ db, user, insertValues }, request) => {
	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid webhook request" }, { status });
	}
	const parsed = webhookSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const secret = newId("whsec");
	const id = newId("wh");
	await db.insert(webhooks).values(
		insertValues(webhooks, {
			id,
			userId: user.id,
			url: parsed.data.url,
			secret,
			events: JSON.stringify(parsed.data.events),
			description: parsed.data.description ?? null,
			enabled: true,
		}),
	);

	// The secret is returned exactly once, here.
	return NextResponse.json({
		id,
		url: parsed.data.url,
		secret,
		events: parsed.data.events,
		description: parsed.data.description ?? null,
		enabled: true,
	});
});
