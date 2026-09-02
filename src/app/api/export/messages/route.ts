import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { exportMailboxToMbox } from "@/lib/export/mbox";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

export const GET = withOrg(async ({ db, env, user, orgId }, request) => {
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	if (!mailboxId) return NextResponse.json({ error: "Mailbox is required" }, { status: 400 });

	// The mailbox is reached through another table, so it is re-checked against
	// the request's organisation: another org's mailbox looks missing.
	const access = await getMailboxAccessLevel(db, user, mailboxId, orgId);
	if (!access?.canRead) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const mbox = await exportMailboxToMbox(env, mailboxId);
	const address = `${access.mailbox.localPart}.mbox`;
	return new Response(mbox, {
		headers: {
			"Content-Type": "application/mbox; charset=utf-8",
			"Content-Disposition": `attachment; filename="${address}"`,
			"Cache-Control": "no-store",
		},
	});
});
