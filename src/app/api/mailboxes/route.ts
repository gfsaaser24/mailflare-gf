import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { domains, mailboxes, users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { newId } from "@/lib/ids";
import { mailboxSchema } from "@/lib/validators";
import { ensureMailboxDomainRouting, getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import { ensurePersonalMailbox } from "./utils";

export const GET = withOrg(async (ctx) => {
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
		return NextResponse.json({ error: "Mailbox already exists" }, { status: 409 });
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
