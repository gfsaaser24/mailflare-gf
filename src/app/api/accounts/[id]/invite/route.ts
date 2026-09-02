/**
 * `POST /api/accounts/[id]/invite` — reissue a set-password invite (T3.5).
 *
 * Every previous pending invite of that account stops working. The link is
 * emailed from the organisation's own address; when there is no mailbox to send
 * from (or the send fails) it comes back in the response instead, and the admin
 * passes it on.
 */
import { NextResponse } from "next/server";
import { issueInvite } from "@/lib/accounts/service";
import { withOrg } from "@/lib/api/with-org";
import { requireTeamAdmin } from "../../utils";
import type { AccountRouteParams } from "../types";
import { getManagedAccount } from "../utils";

export const POST = withOrg<AccountRouteParams>(async (ctx, _request, { params }) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;

	const { id } = await params;
	const account = await getManagedAccount(ctx, id);
	if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	if (account.disabled) {
		return NextResponse.json({ error: "Account is disabled" }, { status: 409 });
	}

	const { delivery } = await issueInvite(ctx.env, ctx.db, {
		organizationId: ctx.orgId,
		userId: account.id,
		email: account.email,
		name: account.name,
		createdByUserId: ctx.user.id,
	});

	const response = NextResponse.json({
		ok: true,
		inviteSent: delivery.sent,
		...(delivery.sent ? {} : { inviteUrl: delivery.url, inviteMessage: delivery.reason }),
	});
	response.headers.set("Cache-Control", "no-store");
	return response;
});
