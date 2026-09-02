import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { requireTeamAdmin } from "../../utils";
import { selectAccountById } from "../utils";
import type { AccountRouteParams } from "../types";
import { newId } from "@/lib/ids";
import { accountMailboxSchema } from "@/lib/validators";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";

export async function GET(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const db = getDb(access.env);
	const account = await selectAccountById(db, id);
	if (!account || (account.id !== access.user!.id && account.createdByUserId !== access.user!.id)) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	const rows = await db.select({
		id: mailboxes.id,
		localPart: mailboxes.localPart,
		displayName: mailboxes.displayName,
		domainId: mailboxes.domainId,
		hostname: domains.hostname,
	}).from(mailboxes).innerJoin(domains, eq(mailboxes.domainId, domains.id)).where(eq(mailboxes.userId, id));
	return NextResponse.json({ mailboxes: rows });
}

// Creates a personal inbox owned by a managed account, so one person can be
// given their own address rather than only delegated access to a shared one.
export async function POST(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id: accountId } = await params;
	const db = getDb(access.env);

	const account = await selectAccountById(db, accountId);
	if (!account || (account.id !== access.user!.id && account.createdByUserId !== access.user!.id)) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}

	const parsed = accountMailboxSchema.safeParse(await request.json());
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

	const [domain] = await db.select().from(domains).where(eq(domains.id, parsed.data.domainId)).limit(1);
	if (!domain || domain.userId !== access.user!.id) {
		return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	}

	const localPart = parsed.data.localPart.toLowerCase();
	const [existing] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, localPart)))
		.limit(1);
	if (existing) return NextResponse.json({ error: "Mailbox already exists" }, { status: 409 });

	const id = newId("mbx");
	await db.insert(mailboxes).values({
		id,
		userId: accountId,
		domainId: domain.id,
		localPart,
		displayName: parsed.data.displayName,
		type: "personal",
	});

	try {
		await ensureMailboxDomainRouting(access.env, db, { id, domainId: domain.id, localPart, useAllDomains: true });
	} catch (err) {
		// Roll back so a failed Cloudflare call cannot leave an unreachable mailbox row.
		await db.delete(mailboxes).where(eq(mailboxes.id, id));
		const message = err instanceof Error ? err.message : "Failed to create Cloudflare routing rule";
		return NextResponse.json({ error: message }, { status: 502 });
	}

	return NextResponse.json({ id, address: `${localPart}@${domain.hostname}` });
}
