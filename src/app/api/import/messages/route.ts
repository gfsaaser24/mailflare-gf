import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { folders } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getImportMessageUserId } from "@/lib/import/destination";
import { importMessagesToMailbox } from "@/lib/import/service";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { parseImportForm } from "./utils";

export const POST = withOrg(async ({ db, env, user, orgId, scoped }, request) => {
	let input: Awaited<ReturnType<typeof parseImportForm>>;
	try {
		input = await parseImportForm(request);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid import upload" }, { status });
	}

	if (!input.mailboxId || input.messages.length === 0) {
		return NextResponse.json({ error: "Select a mailbox and at least one .eml or .mbox file" }, { status: 400 });
	}

	const access = await getMailboxAccessLevel(db, user, input.mailboxId, orgId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	if (input.destination.type === "folder") {
		const [folder] = await db
			.select({ id: folders.id })
			.from(folders)
			.where(
				and(
					scoped(folders),
					eq(folders.id, input.destination.folderId),
					eq(folders.mailboxId, access.mailbox.id),
				),
			)
			.limit(1);
		if (!folder) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
	}

	// Every message and contact the import writes is stamped with `orgId`.
	const result = await importMessagesToMailbox(env, {
		organizationId: orgId,
		userId: getImportMessageUserId(input.destination, user.id, access.mailbox.userId),
		mailboxId: access.mailbox.id,
		destination: input.destination,
		messages: input.messages,
	});
	return NextResponse.json(result);
});
