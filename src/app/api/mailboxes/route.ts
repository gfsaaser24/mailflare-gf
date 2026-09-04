import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { domains, mailboxes, users } from "@/db/schema";
import { requireTeamAdmin } from "@/app/api/accounts/utils";
import { withOrg } from "@/lib/api/with-org";
import { isAdmin } from "@/lib/auth/admin";
import { newId } from "@/lib/ids";
import { mailboxSchema } from "@/lib/validators";
import { listOrganizationMailboxes } from "@/lib/mailboxes/access";
import { ensureMailboxDomainRouting, getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { isQuotaExceededError, quotaErrorBody } from "@/lib/quotas/errors";
import { releaseQuota, reserveQuota } from "@/lib/quotas/service";
import { ensurePersonalMailbox, describeMailboxConflict } from "./utils";

/**
 * `?scope=organization` (admin only) lists every mailbox of the organisation for
 * management, because the create rule rejects duplicates org-wide while the default
 * listing only shows what the caller may open — so an address can be taken by a row
 * the admin cannot see. It grants no access to anyone's mail; opening or editing a
 * mailbox still goes through `getMailboxAccessLevel`.
 *
 * The default (`scope` absent or `accessible`) is unchanged, side effect included.
 */
export const GET = withOrg(async (ctx, request) => {
	if (new URL(request.url).searchParams.get("scope") === "organization") {
		const forbidden = requireTeamAdmin(ctx);
		if (forbidden) return forbidden;
		const rows = await listOrganizationMailboxes(ctx.db, ctx.orgId);
		return NextResponse.json({
			mailboxes: rows.map((mailbox) => ({
				...mailbox,
				isOwn: mailbox.ownerUserId === ctx.user.id,
			})),
			canCreateShared: ctx.user.role === "admin",
		});
	}

	const rows = await ensurePersonalMailbox(ctx);
	return NextResponse.json({
		mailboxes: await Promise.all(rows.map(async (mailbox) => ({
			...mailbox,
			senderAddresses: await getMailboxDomainAddresses(ctx.db, mailbox, ctx.orgId),
		}))),
		canCreateShared: ctx.user.role === "admin",
	});
});

export const POST = withOrg(async (ctx, request) => {
	const { db, env, user, orgId, scoped, insertValues } = ctx;
	const parsed = mailboxSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const mailboxType = parsed.data.type ?? "personal";
	if (mailboxType === "shared" && user.role !== "admin") {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
	const ownerUserId = mailboxType === "shared" ? user.id : parsed.data.ownerUserId ?? user.id;
	if (ownerUserId !== user.id) {
		if (user.role !== "admin") {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}
		const [owner] = await db
			.select({ id: users.id })
			.from(users)
			.where(and(scoped(users), eq(users.id, ownerUserId), eq(users.createdByUserId, user.id)))
			.limit(1);
		if (!owner) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	const [domain] = await db
		.select()
		.from(domains)
		.where(and(scoped(domains), eq(domains.id, parsed.data.domainId)))
		.limit(1);
	const canUseDomain = domain && (
		domain.userId === user.id ||
		(user.canManageMailboxes && !!user.createdByUserId && domain.userId === user.createdByUserId)
	);
	if (!canUseDomain) {
		return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	}

	const localPart = parsed.data.localPart.toLowerCase();
	const [existing] = await db
		.select()
		.from(mailboxes)
		.where(
			and(scoped(mailboxes), eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, localPart)),
		)
		.limit(1);
	if (existing) {
		// The uniqueness rule is org-wide but the default listing only shows what the
		// caller may open, so an admin can collide with a row they cannot see. Name the
		// owner for them; everyone else keeps the generic message.
		const error = isAdmin(user)
			? await describeMailboxConflict(ctx, existing, `${localPart}@${domain.hostname}`)
			: "Mailbox already exists";
		return NextResponse.json({ error }, { status: 409 });
	}

	// Quota (T5.1): booked under the org usage lock before the row exists, so two
	// concurrent creates can never both pass the last slot.
	const quotaIncrement = {
		mailboxes: 1,
		...(mailboxType === "shared" ? { sharedMailboxes: 1 } : {}),
	};
	try {
		await reserveQuota(db, orgId, quotaIncrement);
	} catch (error) {
		if (isQuotaExceededError(error)) {
			return NextResponse.json(quotaErrorBody(error), { status: error.status });
		}
		throw error;
	}

	const id = newId("mbx");
	await db.insert(mailboxes).values(
		insertValues(mailboxes, {
			id,
			userId: ownerUserId,
			domainId: domain.id,
			localPart,
			displayName: parsed.data.displayName,
			type: mailboxType,
		}),
	);
	try {
		await ensureMailboxDomainRouting(
			env,
			db,
			{ id, domainId: domain.id, localPart, useAllDomains: true },
			orgId,
		);
	} catch (err) {
		await db.delete(mailboxes).where(and(scoped(mailboxes), eq(mailboxes.id, id)));
		await releaseQuota(db, orgId, quotaIncrement);
		const message = err instanceof Error ? err.message : "Failed to create Cloudflare routing rule";
		return NextResponse.json({ error: message }, { status: 502 });
	}

	const address = `${localPart}@${domain.hostname}`;

	return NextResponse.json({
		id,
		address,
		type: mailboxType,
	});
});
