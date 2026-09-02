import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { blockContact } from "@/lib/contacts/service";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { BlockContactRequest } from "./types";

export const POST = withOrg(async ({ db, env, user, orgId }, request) => {
	const body = (await request.json()) as BlockContactRequest;
	if (!body.mailboxId || !body.address?.trim()) {
		return NextResponse.json({ error: "Mailbox and contact are required" }, { status: 400 });
	}

	const access = await getMailboxAccessLevel(db, user, body.mailboxId, orgId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	// `blockContact` filters and stamps `organization_id` on both the contact and
	// the trash routing rule it creates.
	const contact = await blockContact(env, {
		organizationId: orgId,
		userId: access.mailbox.userId,
		mailboxId: access.mailbox.id,
		domainId: access.mailbox.domainId,
		address: body.address,
	});
	return NextResponse.json({ contact });
});
