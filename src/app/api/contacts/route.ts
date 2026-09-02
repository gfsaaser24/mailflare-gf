import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { normalizeEmailAddress } from "@/lib/email/address";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { ContactRequestInput } from "./types";
import { getContactByEmail, saveManualContactName } from "./utils";

export const GET = withOrg(async (ctx, request) => {
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const email = normalizeEmailAddress(url.searchParams.get("address") ?? "");
	if (!mailboxId || !email) {
		return NextResponse.json({ error: "Mailbox and contact are required" }, { status: 400 });
	}

	const access = await getMailboxAccessLevel(ctx.db, ctx.user, mailboxId, ctx.orgId);
	if (!access?.canRead) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const contact = await getContactByEmail(ctx, access.mailbox.userId, email);
	return NextResponse.json({
		contact: contact ?? {
			email,
			displayName: null,
			source: null,
			blocked: false,
			lastSeenAt: null,
		},
	});
});

export const PATCH = withOrg(async (ctx, request) => {
	const body = (await request.json()) as ContactRequestInput;
	const email = normalizeEmailAddress(body.address ?? "");
	const displayName = body.displayName?.trim() ?? "";
	if (!body.mailboxId || !email || !displayName || displayName.length > 100) {
		return NextResponse.json({ error: "A valid contact name is required" }, { status: 400 });
	}

	const access = await getMailboxAccessLevel(ctx.db, ctx.user, body.mailboxId, ctx.orgId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const contact = await saveManualContactName(ctx, {
		userId: access.mailbox.userId,
		email,
		displayName,
	});
	return NextResponse.json({ contact });
});
