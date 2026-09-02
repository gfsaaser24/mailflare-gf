import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { mailboxes } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import {
	ALLOWED_AVATAR_TYPES,
	MAX_AVATAR_SIZE,
	isUploadedAvatarFile,
} from "@/app/api/profile/avatar/utils";
import type { MailboxAvatarRouteParams } from "./types";
import { mailboxAvatarKeyFor } from "./utils";

export const GET = withOrg<MailboxAvatarRouteParams>(async (ctx, _request, { params }) => {
	const { id } = await params;
	const { db, env, user, orgId, scoped } = ctx;
	const access = await getMailboxAccessLevel(db, user, id, orgId);
	if (!access?.canRead) return new Response("Not found", { status: 404 });

	const [mailbox] = await db
		.select({ avatarKey: mailboxes.avatarKey })
		.from(mailboxes)
		.where(and(scoped(mailboxes), eq(mailboxes.id, id)))
		.limit(1);
	if (!mailbox?.avatarKey) return new Response("Not found", { status: 404 });

	const object = await env.BUCKET.get(mailbox.avatarKey);
	if (!object) return new Response("Not found", { status: 404 });

	const headers = new Headers();
	headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox");
	headers.set("Cache-Control", "private, no-cache");
	return new Response(object.body, { headers });
});

export const POST = withOrg<MailboxAvatarRouteParams>(async (ctx, request, { params }) => {
	const { id } = await params;
	const { db, env, user, orgId, scoped } = ctx;
	const access = await getMailboxAccessLevel(db, user, id, orgId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
	}
	const file = form.get("file");
	if (!isUploadedAvatarFile(file)) {
		return NextResponse.json({ error: "Missing image file" }, { status: 400 });
	}
	if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
		return NextResponse.json({ error: "Use a JPEG, PNG, WebP, or GIF image" }, { status: 400 });
	}
	if (file.size > MAX_AVATAR_SIZE) {
		return NextResponse.json({ error: "Image must be 2 MB or smaller" }, { status: 413 });
	}

	const key = mailboxAvatarKeyFor(id);
	await env.BUCKET.put(key, await file.arrayBuffer(), {
		httpMetadata: { contentType: file.type },
	});
	await db
		.update(mailboxes)
		.set({ avatarKey: key })
		.where(and(scoped(mailboxes), eq(mailboxes.id, id)));
	return NextResponse.json({ ok: true });
});
