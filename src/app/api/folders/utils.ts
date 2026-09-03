import { and, asc, eq } from "drizzle-orm";
import { folders } from "@/db/schema";
import type { OrgContext } from "@/lib/api/with-org";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

/**
 * Mailbox access for folder operations, re-checked against the request's
 * organisation: a mailbox in another org is treated as missing.
 */
export async function getMailboxFolderAccess(ctx: OrgContext, mailboxId: string) {
	const access = await getMailboxAccessLevel(ctx.db, ctx.user, mailboxId, ctx.orgId);
	if (!access?.canRead) return null;
	if (access.mailbox.organizationId !== ctx.orgId) return null;
	return { mailboxId: access.mailbox.id, mailboxUserId: access.mailbox.userId, canManage: access.canManage };
}

export function listFoldersForMailbox({ db, scoped }: OrgContext, mailboxId: string) {
	return db
		.select()
		.from(folders)
		.where(and(scoped(folders), eq(folders.mailboxId, mailboxId)))
		.orderBy(asc(folders.name));
}

export async function getFolderForMailbox(
	{ db, scoped }: OrgContext,
	folderId: string,
	mailboxId: string,
) {
	const [folder] = await db
		.select()
		.from(folders)
		.where(and(scoped(folders), eq(folders.id, folderId), eq(folders.mailboxId, mailboxId)))
		.limit(1);
	return folder ?? null;
}
