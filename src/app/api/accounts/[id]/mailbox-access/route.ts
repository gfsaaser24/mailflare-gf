import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { domains, mailboxAccess, mailboxes } from "@/db/schema";
import { withOrg, type OrgContext } from "@/lib/api/with-org";
import { requireTeamAdmin } from "../../utils";
import { getManagedAccount } from "../utils";
import { newId } from "@/lib/ids";
import { accountMailboxAccessSchema } from "@/lib/validators";
import type { AccountRouteParams } from "../types";

// Resolves the managed account and confirms the caller administers it, inside the
// request's organisation.
async function requireManagedAccount(ctx: OrgContext, params: AccountRouteParams["params"]) {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return { error: forbidden } as const;
	const { id } = await params;
	const account = await getManagedAccount(ctx, id);
	if (!account) {
		return { error: NextResponse.json({ error: "Account not found" }, { status: 404 }) } as const;
	}
	return { error: null, adminId: ctx.user.id, accountId: account.id } as const;
}

// Shared mailboxes owned by the admin are the only ones that can be delegated, and
// only within the admin's own organisation.
async function selectSharedMailbox({ db, scoped }: OrgContext, mailboxId: string, adminId: string) {
	const [mailbox] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(
			and(
				scoped(mailboxes),
				eq(mailboxes.id, mailboxId),
				eq(mailboxes.userId, adminId),
				eq(mailboxes.type, "shared"),
			),
		)
		.limit(1);
	return mailbox;
}

export const GET = withOrg<AccountRouteParams>(async (ctx, _request, { params }) => {
	const managed = await requireManagedAccount(ctx, params);
	if (managed.error) return managed.error;

	// mailbox_access has no organization_id; it is reached through mailboxes, which is scoped.
	const rows = await ctx.db
		.select({
			id: mailboxes.id,
			mailboxId: mailboxes.id,
			localPart: mailboxes.localPart,
			displayName: mailboxes.displayName,
			domainId: mailboxes.domainId,
			hostname: domains.hostname,
			permission: mailboxAccess.permission,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.leftJoin(
			mailboxAccess,
			and(eq(mailboxAccess.mailboxId, mailboxes.id), eq(mailboxAccess.userId, managed.accountId)),
		)
		.where(
			and(
				ctx.scoped(mailboxes),
				eq(mailboxes.userId, managed.adminId),
				eq(mailboxes.type, "shared"),
			),
		);

	return NextResponse.json({ mailboxes: rows.map((row) => ({ ...row, permission: row.permission ?? undefined })) });
});

export const POST = withOrg<AccountRouteParams>(async (ctx, request, { params }) => {
	const managed = await requireManagedAccount(ctx, params);
	if (managed.error) return managed.error;
	const parsed = accountMailboxAccessSchema.safeParse(await request.json());
	if (!parsed.success) return NextResponse.json({ error: "Choose a valid inbox and permission" }, { status: 400 });

	const mailbox = await selectSharedMailbox(ctx, parsed.data.mailboxId, managed.adminId);
	if (!mailbox) return NextResponse.json({ error: "Shared inbox not found" }, { status: 404 });

	await ctx.db
		.insert(mailboxAccess)
		.values({
			id: newId("mac"),
			mailboxId: mailbox.id,
			userId: managed.accountId,
			permission: parsed.data.permission,
			createdByUserId: managed.adminId,
		})
		.onConflictDoUpdate({
			target: [mailboxAccess.mailboxId, mailboxAccess.userId],
			set: { permission: parsed.data.permission, createdByUserId: managed.adminId },
		});
	return NextResponse.json({ ok: true });
});

export const DELETE = withOrg<AccountRouteParams>(async (ctx, request, { params }) => {
	const managed = await requireManagedAccount(ctx, params);
	if (managed.error) return managed.error;
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) return NextResponse.json({ error: "Inbox is required" }, { status: 400 });

	const mailbox = await selectSharedMailbox(ctx, mailboxId, managed.adminId);
	if (!mailbox) return NextResponse.json({ error: "Shared inbox not found" }, { status: 404 });

	await ctx.db
		.delete(mailboxAccess)
		.where(and(eq(mailboxAccess.mailboxId, mailbox.id), eq(mailboxAccess.userId, managed.accountId)));
	return NextResponse.json({ ok: true });
});
