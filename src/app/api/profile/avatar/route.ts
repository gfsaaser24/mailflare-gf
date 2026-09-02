import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { AppDatabase } from "@/db";
import { users } from "@/db/schema";
import { withOrg, type OrgContext } from "@/lib/api/with-org";
import {
	ALLOWED_AVATAR_TYPES,
	MAX_AVATAR_SIZE,
	avatarKeyFor,
	isUploadedAvatarFile,
} from "./utils";

/** The caller's avatar key, read inside the request's organisation. */
async function getAvatarKey(
	db: AppDatabase,
	scoped: OrgContext["scoped"],
	userId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ avatarKey: users.avatarKey })
		.from(users)
		.where(and(scoped(users), eq(users.id, userId)))
		.limit(1);
	return row?.avatarKey ?? null;
}

export const GET = withOrg(async ({ db, env, user, scoped }) => {
	const avatarKey = await getAvatarKey(db, scoped, user.id);
	if (!avatarKey) return new Response("Not found", { status: 404 });

	const object = await env.BUCKET.get(avatarKey);
	if (!object) return new Response("Not found", { status: 404 });

	const headers = new Headers();
	headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox");
	headers.set("Cache-Control", "private, no-cache");
	return new Response(object.body, { headers });
});

export const POST = withOrg(async ({ db, env, user, scoped }, request) => {
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

	const key = avatarKeyFor(user.id);
	await env.BUCKET.put(key, await file.arrayBuffer(), {
		httpMetadata: { contentType: file.type },
	});
	await db
		.update(users)
		.set({ avatarKey: key })
		.where(and(scoped(users), eq(users.id, user.id)));

	return NextResponse.json({ ok: true });
});

export const DELETE = withOrg(async ({ db, env, user, scoped }) => {
	const avatarKey = await getAvatarKey(db, scoped, user.id);
	if (avatarKey) {
		await env.BUCKET.delete(avatarKey);
		await db
			.update(users)
			.set({ avatarKey: null })
			.where(and(scoped(users), eq(users.id, user.id)));
	}
	return NextResponse.json({ ok: true });
});
