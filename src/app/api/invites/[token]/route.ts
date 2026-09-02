/**
 * `GET /api/invites/[token]` — is this set-password link still usable? (T3.5)
 *
 * Public on purpose: the invited user has no session yet. It reveals only what
 * the set-password page must show — the address the invite was issued to and the
 * organisation's name — and answers 404 for anything unknown, expired, already
 * accepted, or belonging to a disabled account.
 */
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { findUsableInvite } from "@/lib/accounts/service";
import { getEnv } from "@/lib/cloudflare";

type InviteRouteParams = { params: Promise<{ token: string }> };

export async function GET(_request: Request, { params }: InviteRouteParams) {
	const { token } = await params;
	const db = getDb(getEnv());
	const invite = await findUsableInvite(db, token);
	if (!invite) {
		return NextResponse.json(
			{ error: "This invite link is no longer valid" },
			{ status: 404, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.json(
		{
			invite: {
				email: invite.email,
				name: invite.name,
				organizationName: invite.organizationName,
				expiresAt: invite.expiresAt,
			},
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
