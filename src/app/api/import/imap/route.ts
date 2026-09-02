import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { folders } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { getImportMessageUserId } from "@/lib/import/destination";
import { fetchImapMessages } from "@/lib/import/imap";
import { importMessagesToMailbox } from "@/lib/import/service";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { ImapImportRequest } from "./types";
import { parseImapImportRequest } from "./utils";

export const runtime = "nodejs";

export const POST = withOrg(async ({ db, env, user, orgId, scoped }, request) => {
	let input: ReturnType<typeof parseImapImportRequest>;
	try {
		const body = await readJsonBody<ImapImportRequest>(request, 16 * 1024);
		input = parseImapImportRequest(body);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid IMAP import request" }, { status });
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

	try {
		const rawMessages = await fetchImapMessages(input);
		// Every message and contact the import writes is stamped with `orgId`.
		const result = await importMessagesToMailbox(env, {
			organizationId: orgId,
			userId: getImportMessageUserId(input.destination, user.id, access.mailbox.userId),
			mailboxId: access.mailbox.id,
			destination: input.destination,
			messages: rawMessages,
		});
		return NextResponse.json(result);
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "IMAP import failed" },
			{ status: 502 },
		);
	}
});
