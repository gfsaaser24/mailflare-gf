import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { mailboxes, users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { deleteMailbox, MailboxCloudflareCleanupError } from "@/lib/mailboxes/delete";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { updateMailboxSchema } from "@/lib/validators";
import type { MailboxRouteParams } from "./types";
import { getMailboxUpdateValues, selectMailboxForOrg } from "./utils";

export const GET = withOrg<MailboxRouteParams>(async (ctx, _request, { params }) => {
	const { id } = await params;
	const { db, user, orgId } = ctx;
	const access = await getMailboxAccessLevel(db, user, id, orgId);
	if (!access?.canRead) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const [mailbox] = await selectMailboxForOrg(ctx, id);

	if (!mailbox) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const { avatarKey, ...mailboxDetails } = mailbox;

	return NextResponse.json({
		mailbox: {
			...mailboxDetails,
			hasAvatar: !!avatarKey,
			permission: access.permission,
			isPrimary: `${mailbox.localPart}@${mailbox.hostname}` === user.email,
		},
	});
});

export const PATCH = withOrg<MailboxRouteParams>(async (ctx, request, { params }) => {
	const { id } = await params;
	const { db, env, user, orgId, scoped } = ctx;
	const parsed = updateMailboxSchema.safeParse(await request.json());

	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const access = await getMailboxAccessLevel(db, user, id, orgId);
	const [existing] = await selectMailboxForOrg(ctx, id);

	if (!existing || !access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const updateValues = getMailboxUpdateValues(parsed.data);
	if (parsed.data.useAllDomains === true) {
		try {
			await ensureMailboxDomainRouting(
				env,
				db,
				{
					id: existing.id,
					domainId: existing.domainId,
					localPart: existing.localPart,
					useAllDomains: true,
				},
				orgId,
			);
		} catch (error) {
			console.error("ensureMailboxDomainRouting", error);
			return NextResponse.json(
				{ error: "Failed to configure inbound routing for all domains. Please try saving again." },
				{ status: 502 },
			);
		}
	}
	if (Object.keys(updateValues).length > 0) {
		await db
			.update(mailboxes)
			.set(updateValues)
			.where(and(scoped(mailboxes), eq(mailboxes.id, id)));
	}

	const [mailbox] = await selectMailboxForOrg(ctx, id);
	const { avatarKey, ...mailboxDetails } = mailbox!;

	return NextResponse.json({
		mailbox: {
			...mailboxDetails,
			hasAvatar: !!avatarKey,
			permission: access.permission,
			isPrimary: `${mailbox!.localPart}@${mailbox!.hostname}` === user.email,
		},
	});
});

export const DELETE = withOrg<MailboxRouteParams>(async (ctx, _request, { params }) => {
	const { id } = await params;
	const { db, env, user, orgId, scoped } = ctx;
	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(and(scoped(mailboxes), eq(mailboxes.id, id)))
		.limit(1);
	if (!mailbox) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });

	let allowed = mailbox.userId === user.id && user.canManageMailboxes;
	if (!allowed && user.role === "admin") {
		const [owner] = await db
			.select({ createdByUserId: users.createdByUserId })
			.from(users)
			.where(and(scoped(users), eq(users.id, mailbox.userId)))
			.limit(1);
		allowed = mailbox.userId === user.id || owner?.createdByUserId === user.id;
	}
	if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

	try {
		const counts = await deleteMailbox(
			env,
			db,
			{
				id: mailbox.id,
				userId: mailbox.userId,
				domainId: mailbox.domainId,
				localPart: mailbox.localPart,
				useAllDomains: mailbox.useAllDomains,
				avatarKey: mailbox.avatarKey,
			},
			{ actorUserId: user.id, orgId },
		);
		return NextResponse.json({ ok: true, deleted: counts });
	} catch (error) {
		if (error instanceof MailboxCloudflareCleanupError) {
			console.error("deleteMailbox: cloudflare cleanup failed", error);
			return NextResponse.json(
				{ error: `Cloudflare cleanup failed: ${error.message}` },
				{ status: 502 },
			);
		}
		throw error;
	}
});
