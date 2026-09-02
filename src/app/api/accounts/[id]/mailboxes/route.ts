import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { domains, mailboxes } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { requireTeamAdmin } from "../../utils";
import { getManagedAccount } from "../utils";
import type { AccountRouteParams } from "../types";
import { newId } from "@/lib/ids";
import { accountMailboxSchema } from "@/lib/validators";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";

export const GET = withOrg<AccountRouteParams>(async (ctx, _request, { params }) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;
	const { id } = await params;
	const account = await getManagedAccount(ctx, id);
	if (!account) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	const rows = await ctx.db.select({
		id: mailboxes.id,
		localPart: mailboxes.localPart,
		displayName: mailboxes.displayName,
		domainId: mailboxes.domainId,
		hostname: domains.hostname,
	}).from(mailboxes).innerJoin(domains, eq(mailboxes.domainId, domains.id)).where(and(ctx.scoped(mailboxes), eq(mailboxes.userId, account.id)));
	return NextResponse.json({ mailboxes: rows });
});

// Creates a personal inbox owned by a managed account, so one person can be
// given their own address rather than only delegated access to a shared one.
export const POST = withOrg<AccountRouteParams>(async (ctx, request, { params }) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;
	const { id: accountId } = await params;
	const { db, env, scoped, insertValues } = ctx;

	const account = await getManagedAccount(ctx, accountId);
	if (!account) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}

	const parsed = accountMailboxSchema.safeParse(await request.json());
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

	const [domain] = await db
		.select()
		.from(domains)
		.where(and(scoped(domains), eq(domains.id, parsed.data.domainId)))
		.limit(1);
	if (!domain || domain.userId !== ctx.user.id) {
		return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	}

	const localPart = parsed.data.localPart.toLowerCase();
	const [existing] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(
			and(scoped(mailboxes), eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, localPart)),
		)
		.limit(1);
	if (existing) return NextResponse.json({ error: "Mailbox already exists" }, { status: 409 });

	const id = newId("mbx");
	await db.insert(mailboxes).values(
		insertValues(mailboxes, {
			id,
			userId: account.id,
			domainId: domain.id,
			localPart,
			displayName: parsed.data.displayName,
			type: "personal",
		}),
	);

	try {
		await ensureMailboxDomainRouting(
			env,
			db,
			{ id, domainId: domain.id, localPart, useAllDomains: true },
			ctx.orgId,
		);
	} catch (err) {
		// Roll back so a failed Cloudflare call cannot leave an unreachable mailbox row.
		await db.delete(mailboxes).where(and(scoped(mailboxes), eq(mailboxes.id, id)));
		const message = err instanceof Error ? err.message : "Failed to create Cloudflare routing rule";
		return NextResponse.json({ error: message }, { status: 502 });
	}

	return NextResponse.json({ id, address: `${localPart}@${domain.hostname}` });
});
