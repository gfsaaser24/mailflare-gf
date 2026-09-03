import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { folders, messages } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { deleteMessagesPermanently } from "@/lib/retention/service";
import type { BulkMessagePayload } from "./types";
import {
	getReadValueForBulkAction,
	getStatusForBulkAction,
	isAllowedBulkMessageAction,
} from "./utils";

export const POST = withOrg(async ({ env, db, user, orgId, scoped }, request) => {
	const payload = (await request.json()) as BulkMessagePayload;
	const messageIds = payload.messageIds?.filter(Boolean) ?? [];
	if (messageIds.length === 0 || !isAllowedBulkMessageAction(payload.action)) {
		return NextResponse.json({ error: "Invalid bulk message action" }, { status: 400 });
	}

	const status = getStatusForBulkAction(payload.action);
	const read = getReadValueForBulkAction(payload.action);
	let folderId: string | null | undefined;

	if (payload.action === "folder") {
		if (!payload.folderId) {
			return NextResponse.json({ error: "Folder is required" }, { status: 400 });
		}
		const [folder] = await db
			.select({ id: folders.id, mailboxId: folders.mailboxId })
			.from(folders)
			.where(and(scoped(folders), eq(folders.id, payload.folderId)))
			.limit(1);
		if (!folder) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
		const folderAccess = await getMailboxAccessLevel(db, user, folder.mailboxId, orgId);
		if (!folderAccess?.canManage) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
		folderId = folder.id;
	} else if (payload.action === "spam" || payload.action === "trash" || payload.action === "inbox" || payload.action === "archive") {
		folderId = null;
	}

	const values = {
		...(status ? { status } : {}),
		// Retention purges by time in trash, not by message age.
		...(status ? { trashedAt: status === "trash" ? new Date() : null } : {}),
		...(read !== null ? { read } : {}),
		...(folderId !== undefined ? { folderId } : {}),
	};

	// `delete` writes nothing, it removes; every other action must change something.
	if (payload.action !== "delete" && Object.keys(values).length === 0) {
		return NextResponse.json({ error: "No changes requested" }, { status: 400 });
	}

	const selectedMessages = await db
		.select()
		.from(messages)
		.where(and(scoped(messages), inArray(messages.id, messageIds)));
	const allowedMessageIds: string[] = [];

	for (const message of selectedMessages) {
		if (!message.mailboxId) {
			// A message with no mailbox (a draft) belongs to its author alone, and
			// only the permanent delete has anything to do with it.
			if (payload.action === "delete" && message.userId === user.id) {
				allowedMessageIds.push(message.id);
			}
			continue;
		}
		const access = await getMailboxAccessLevel(db, user, message.mailboxId, orgId);
		const canUpdate = payload.action === "read" || payload.action === "unread" ? access?.canRead : access?.canManage;
		if (!canUpdate) continue;
		allowedMessageIds.push(message.id);
	}

	if (allowedMessageIds.length === 0) {
		return NextResponse.json({ error: "No accessible messages" }, { status: 404 });
	}

	// Permanent delete (empty trash) goes through the one delete path, which also
	// removes the raw objects and attachments and refunds the storage bytes.
	if (payload.action === "delete") {
		const counts = await deleteMessagesPermanently(env, orgId, allowedMessageIds);
		await Promise.all(
			allowedMessageIds.map((messageId) =>
				createAuditLog(env, {
					actorUserId: user.id,
					// The message rows are gone, so they cannot be referenced.
					messageId: null,
					action: "email.delete",
					metadata: { messageId, bulkAction: payload.action, permanent: true },
				}),
			),
		);
		return NextResponse.json({ ok: true, ...counts });
	}

	await db
		.update(messages)
		.set(values)
		.where(and(scoped(messages), inArray(messages.id, allowedMessageIds)));
	await Promise.all(
		allowedMessageIds.map((messageId) =>
			createAuditLog(env, {
				actorUserId: user.id,
				messageId,
				action: payload.action === "read" || payload.action === "unread" ? "email.read" : "email.delete",
				metadata: { bulkAction: payload.action },
			}),
		),
	);

	return NextResponse.json({ ok: true });
});
