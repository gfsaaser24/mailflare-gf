/**
 * `POST /api/accounts/[id]/transfer` — move everything an account owns to
 * another account of the same organisation (T3.5).
 *
 * Run this before disabling somebody, so their mailboxes, assigned
 * conversations, folders, contacts, drafts, webhooks and API keys keep an owner.
 * A `toUserId` outside the organisation reads as missing.
 */
import { NextResponse } from "next/server";
import {
	TransferSameUserError,
	TransferUserNotFoundError,
	transferOwnership,
} from "@/lib/accounts/service";
import { withOrg } from "@/lib/api/with-org";
import { transferAccountSchema } from "@/lib/validators";
import { requireTeamAdmin } from "../../utils";
import type { AccountRouteParams } from "../types";
import { getManagedAccount } from "../utils";

export const POST = withOrg<AccountRouteParams>(async (ctx, request, { params }) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;

	const { id } = await params;
	const account = await getManagedAccount(ctx, id);
	if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const parsed = transferAccountSchema.safeParse(body);
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

	try {
		const result = await transferOwnership(ctx.db, {
			organizationId: ctx.orgId,
			fromUserId: account.id,
			toUserId: parsed.data.toUserId,
			actorUserId: ctx.user.id,
		});
		return NextResponse.json({ ok: true, counts: result.counts });
	} catch (error) {
		if (error instanceof TransferSameUserError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		if (error instanceof TransferUserNotFoundError) {
			return NextResponse.json({ error: error.message }, { status: 404 });
		}
		throw error;
	}
});
