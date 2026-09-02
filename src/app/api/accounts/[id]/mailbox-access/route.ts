import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { domains, mailboxAccess, mailboxes } from "@/db/schema";
import { requireTeamAdmin } from "../../utils";
import { selectAccountById } from "../utils";
import { newId } from "@/lib/ids";
import { accountMailboxAccessSchema } from "@/lib/validators";
import type { AccountRouteParams } from "../types";

// Resolves the managed account and confirms the caller administers it.
async function requireManagedAccount(request: Request, params: AccountRouteParams["params"]) {
	const access = await requireTeamAdmin(request);
	if (access.error) return { error: access.error } as const;
	const { id } = await params;
	const db = getDb(access.env);
	const account = await selectAccountById(db, id);
	if (!account || (account.id !== access.user!.id && account.createdByUserId !== access.user!.id)) {
		return { error: NextResponse.json({ error: "Account not found" }, { status: 404 }) } as const;
	}
	return { db, adminId: access.user!.id, accountId: id } as const;
}

// Shared mailboxes owned by the admin are the only ones that can be delegated.
async function selectSharedMailbox(db: Awaited<ReturnType<typeof requireManagedAccount>>["db"], mailboxId: string, adminId: string) {
	if (!db) return undefined;
	const [mailbox] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.userId, adminId), eq(mailboxes.type, "shared")))
		.limit(1);
	return mailbox;
}

export async function GET(request: Request, { params }: AccountRouteParams) {
	const ctx = await requireManagedAccount(request, params);
	if (ctx.error) return ctx.error;

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
			and(eq(mailboxAccess.mailboxId, mailboxes.id), eq(mailboxAccess.userId, ctx.accountId)),
		)
		.where(and(eq(mailboxes.userId, ctx.adminId), eq(mailboxes.type, "shared")));

	return NextResponse.json({ mailboxes: rows.map((row) => ({ ...row, permission: row.permission ?? undefined })) });
}

export async function POST(request: Request, { params }: AccountRouteParams) {
	const ctx = await requireManagedAccount(request, params);
	if (ctx.error) return ctx.error;
	const parsed = accountMailboxAccessSchema.safeParse(await request.json());
	if (!parsed.success) return NextResponse.json({ error: "Choose a valid inbox and permission" }, { status: 400 });

	const mailbox = await selectSharedMailbox(ctx.db, parsed.data.mailboxId, ctx.adminId);
	if (!mailbox) return NextResponse.json({ error: "Shared inbox not found" }, { status: 404 });

	await ctx.db
		.insert(mailboxAccess)
		.values({
			id: newId("mac"),
			mailboxId: parsed.data.mailboxId,
			userId: ctx.accountId,
			permission: parsed.data.permission,
			createdByUserId: ctx.adminId,
		})
		.onConflictDoUpdate({
			target: [mailboxAccess.mailboxId, mailboxAccess.userId],
			set: { permission: parsed.data.permission, createdByUserId: ctx.adminId },
		});
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: AccountRouteParams) {
	const ctx = await requireManagedAccount(request, params);
	if (ctx.error) return ctx.error;
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) return NextResponse.json({ error: "Inbox is required" }, { status: 400 });

	const mailbox = await selectSharedMailbox(ctx.db, mailboxId, ctx.adminId);
	if (!mailbox) return NextResponse.json({ error: "Shared inbox not found" }, { status: 404 });

	await ctx.db
		.delete(mailboxAccess)
		.where(and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.userId, ctx.accountId)));
	return NextResponse.json({ ok: true });
}
