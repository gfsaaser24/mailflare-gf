import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { folders } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { newId } from "@/lib/ids";
import { folderSchema } from "@/lib/validators";
import { getMailboxFolderAccess, listFoldersForMailbox } from "./utils";

export const GET = withOrg(async (ctx, request) => {
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	if (!mailboxId) {
		return NextResponse.json({ folders: [] });
	}

	const access = await getMailboxFolderAccess(ctx, mailboxId);
	if (!access) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const rows = await listFoldersForMailbox(ctx, mailboxId);
	return NextResponse.json({ folders: rows });
});

export const POST = withOrg(async (ctx, request) => {
	const { db, scoped, insertValues } = ctx;
	const parsed = folderSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const access = await getMailboxFolderAccess(ctx, parsed.data.mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const name = parsed.data.name.trim();
	const [existing] = await db
		.select()
		.from(folders)
		.where(
			and(scoped(folders), eq(folders.mailboxId, parsed.data.mailboxId), eq(folders.name, name)),
		)
		.limit(1);
	if (existing) {
		return NextResponse.json({ error: "Folder already exists" }, { status: 409 });
	}

	const id = newId("fld");
	await db.insert(folders).values(
		insertValues(folders, {
			id,
			userId: access.mailboxUserId,
			mailboxId: parsed.data.mailboxId,
			name,
			color: parsed.data.color,
		}),
	);

	return NextResponse.json({ id, mailboxId: parsed.data.mailboxId, name, color: parsed.data.color });
});
