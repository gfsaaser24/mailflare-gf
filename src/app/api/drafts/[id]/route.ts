import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { messages } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { buildSnippet } from "@/lib/email/parse";
import type { DraftPayload, DraftRouteParams } from "./types";
import { selectDraftWithBody } from "./utils";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getDraftSender, userOwnsDraft } from "../utils";

export const GET = withOrg(async (ctx, _request, { params }: DraftRouteParams) => {
	const { id } = await params;
	const draft = await selectDraftWithBody(ctx, ctx.user.id, id);

	if (!draft) {
		return NextResponse.json({ error: "Draft not found" }, { status: 404 });
	}

	return NextResponse.json({ draft });
});

export const PATCH = withOrg(async (ctx, request, { params }: DraftRouteParams) => {
	const { id } = await params;
	const { env, db, user, scoped } = ctx;
	let input: DraftPayload;
	try {
		input = await readJsonBody<DraftPayload>(request, 1024 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid draft request" }, { status });
	}
	const [draft] = await db
		.select()
		.from(messages)
		.where(and(scoped(messages), eq(messages.id, id)))
		.limit(1);

	if (!userOwnsDraft(draft, user.id)) {
		return NextResponse.json({ error: "Draft not found" }, { status: 404 });
	}
	const sender = await getDraftSender(env, user.id, ctx.orgId, input);
	if ("error" in sender) {
		return NextResponse.json({ error: sender.error }, { status: 403 });
	}

	const text = input.text ?? "";
	const html = input.html ?? "";
	await db
		.update(messages)
		.set({
			mailboxId: sender.mailboxId,
			fromAddr: sender.fromAddr,
			toAddr: input.to ?? "",
			subject: input.subject ?? null,
			snippet: buildSnippet(text || null, html || null),
			textBody: text || null,
			htmlBody: html || null,
		})
		.where(and(scoped(messages), eq(messages.id, id)));

	return NextResponse.json({ draft: { id } });
});

export const DELETE = withOrg(async ({ db, user, scoped }, _request, { params }: DraftRouteParams) => {
	const { id } = await params;
	const [draft] = await db
		.select()
		.from(messages)
		.where(and(scoped(messages), eq(messages.id, id)))
		.limit(1);

	if (!userOwnsDraft(draft, user.id)) {
		return NextResponse.json({ error: "Draft not found" }, { status: 404 });
	}

	await db.delete(messages).where(and(scoped(messages), eq(messages.id, id)));
	return NextResponse.json({ ok: true });
});
