import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import {
	ALLOWED_AVATAR_TYPES,
	MAX_AVATAR_SIZE,
	avatarKeyFor,
	isUploadedAvatarFile,
} from "@/app/api/profile/avatar/utils";
import { requireTeamAdmin } from "../../utils";
import type { AccountRouteParams } from "../types";
import { getManagedAccount } from "../utils";

export const GET = withOrg<AccountRouteParams>(async (ctx, _request, { params }) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;
	const { id } = await params;
	const account = await getManagedAccount(ctx, id);
	if (!account?.avatarKey) return new Response("Not found", { status: 404 });
	const object = await ctx.env.BUCKET.get(account.avatarKey);
	if (!object) return new Response("Not found", { status: 404 });
	return new Response(object.body, {
		headers: {
			"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
			"Cache-Control": "private, no-cache",
			"X-Content-Type-Options": "nosniff",
		},
	});
});

export const POST = withOrg<AccountRouteParams>(async (ctx, request, { params }) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;
	const { id } = await params;
	const account = await getManagedAccount(ctx, id);
	if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	const form = await request.formData();
	const file = form.get("file");
	if (!isUploadedAvatarFile(file)) return NextResponse.json({ error: "Missing image file" }, { status: 400 });
	if (!ALLOWED_AVATAR_TYPES.includes(file.type)) return NextResponse.json({ error: "Use a JPEG, PNG, WebP, or GIF image" }, { status: 400 });
	if (file.size > MAX_AVATAR_SIZE) return NextResponse.json({ error: "Image must be 2 MB or smaller" }, { status: 413 });
	const key = avatarKeyFor(account.id);
	await ctx.env.BUCKET.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
	await ctx.db
		.update(users)
		.set({ avatarKey: key })
		.where(and(ctx.scoped(users), eq(users.id, account.id)));
	return NextResponse.json({ ok: true });
});
