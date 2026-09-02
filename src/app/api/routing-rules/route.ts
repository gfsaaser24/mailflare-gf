import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { folders, routingRules } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { routingRuleSchema } from "@/lib/validators";

export const GET = withOrg(async ({ db, user, orgId, scoped }, request) => {
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	if (!mailboxId) {
		return NextResponse.json({ rules: [] });
	}

	const access = await getMailboxAccessLevel(db, user, mailboxId, orgId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const rows = await db
		.select()
		.from(routingRules)
		.where(and(scoped(routingRules), eq(routingRules.mailboxId, mailboxId)));
	return NextResponse.json({ rules: rows });
});

export const POST = withOrg(async ({ db, user, orgId, scoped, insertValues }, request) => {
	const parsed = routingRuleSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const access = await getMailboxAccessLevel(db, user, parsed.data.mailboxId, orgId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const mailbox = access.mailbox;

	const destination = parsed.data.destination ?? (parsed.data.folderId ? `folder:${parsed.data.folderId}` : "");
	const systemAction = destination === "spam" || destination === "trash" ? destination : null;
	const folderId = destination.startsWith("folder:") ? destination.slice("folder:".length) : null;

	if (!systemAction && !folderId) {
		return NextResponse.json({ error: "Destination is required" }, { status: 400 });
	}

	if (folderId) {
		const [folder] = await db
			.select()
			.from(folders)
			.where(and(scoped(folders), eq(folders.id, folderId), eq(folders.mailboxId, mailbox.id)))
			.limit(1);
		if (!folder) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
	}

	const id = newId("rule");
	await db.insert(routingRules).values(
		insertValues(routingRules, {
			id,
			userId: user.id,
			domainId: mailbox.domainId,
			pattern: parsed.data.matchValue.trim(),
			matchField: parsed.data.matchField,
			matchOperator: parsed.data.matchOperator,
			matchValue: parsed.data.matchValue.trim(),
			action: systemAction ?? "store",
			mailboxId: mailbox.id,
			folderId,
			forwardTo: null,
			priority: parsed.data.priority,
		}),
	);

	return NextResponse.json({ id, ...parsed.data });
});
