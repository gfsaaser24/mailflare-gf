import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { mailboxAccess, users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { requireTeamAdmin } from "@/app/api/accounts/utils";
import { newId } from "@/lib/ids";
import { mailboxAccessSchema } from "@/lib/validators";
import type { MailboxAccessRouteParams } from "./types";
import { getSharedMailboxForAdmin } from "./utils";

export const GET = withOrg<MailboxAccessRouteParams>(async (ctx, _request, { params }) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;
	const { id } = await params;
	const { db, user, scoped } = ctx;
	const mailbox = await getSharedMailboxForAdmin(ctx, id, user.id);
	if (!mailbox) return NextResponse.json({ error: "Shared inbox not found" }, { status: 404 });

	const [members, availableUsers] = await Promise.all([
		// mailbox_access has no organization_id; the mailbox above is already org-checked
		// and the join to users is scoped, so a cross-org grant cannot show up here.
		db
			.select({
				id: mailboxAccess.id,
				userId: mailboxAccess.userId,
				userEmail: users.email,
				userName: users.name,
				permission: mailboxAccess.permission,
				createdAt: mailboxAccess.createdAt,
			})
			.from(mailboxAccess)
			.innerJoin(users, and(eq(mailboxAccess.userId, users.id), scoped(users)))
			.where(eq(mailboxAccess.mailboxId, mailbox.id)),
		db
			.select({ id: users.id, email: users.email, name: users.name, role: users.role })
			.from(users)
			.where(and(scoped(users), eq(users.createdByUserId, user.id), eq(users.disabled, false))),
	]);

	return NextResponse.json({ members, availableUsers });
});

export const POST = withOrg<MailboxAccessRouteParams>(async (ctx, request, { params }) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;
	const parsed = mailboxAccessSchema.safeParse(await request.json());
	if (!parsed.success) return NextResponse.json({ error: "Choose a valid account" }, { status: 400 });
	const { id } = await params;
	const { db, user, scoped } = ctx;
	const mailbox = await getSharedMailboxForAdmin(ctx, id, user.id);
	if (!mailbox) return NextResponse.json({ error: "Shared inbox not found" }, { status: 404 });
	const [grantee] = await db
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				scoped(users),
				eq(users.id, parsed.data.userId),
				eq(users.createdByUserId, user.id),
				eq(users.disabled, false),
			),
		)
		.limit(1);
	if (!grantee) return NextResponse.json({ error: "Account not found" }, { status: 404 });

	await db
		.insert(mailboxAccess)
		.values({
			id: newId("mac"),
			mailboxId: mailbox.id,
			userId: grantee.id,
			permission: parsed.data.permission,
			createdByUserId: user.id,
		})
		.onConflictDoUpdate({
			target: [mailboxAccess.mailboxId, mailboxAccess.userId],
			set: { permission: parsed.data.permission, createdByUserId: user.id },
		});
	return NextResponse.json({ ok: true });
});

export const DELETE = withOrg<MailboxAccessRouteParams>(async (ctx, request, { params }) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;
	const { id } = await params;
	const userId = new URL(request.url).searchParams.get("userId");
	if (!userId) return NextResponse.json({ error: "Account is required" }, { status: 400 });
	const mailbox = await getSharedMailboxForAdmin(ctx, id, ctx.user.id);
	if (!mailbox) return NextResponse.json({ error: "Shared inbox not found" }, { status: 404 });
	await ctx.db
		.delete(mailboxAccess)
		.where(and(eq(mailboxAccess.mailboxId, mailbox.id), eq(mailboxAccess.userId, userId)));
	return NextResponse.json({ ok: true });
});
