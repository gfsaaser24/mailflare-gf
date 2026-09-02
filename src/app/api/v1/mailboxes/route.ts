import { NextResponse } from "next/server";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { v1Route } from "../route-helpers";

/**
 * `GET /api/v1/mailboxes` — every mailbox the key's owner may open, inside the
 * key's organisation.
 */
export const GET = v1Route(
	async (ctx) => {
		const rows = await listAccessibleMailboxes(ctx.db, ctx.user, ctx.orgId);
		return NextResponse.json({
			mailboxes: rows.map((mailbox) => ({
				id: mailbox.id,
				address: `${mailbox.localPart}@${mailbox.hostname}`,
				displayName: mailbox.displayName,
				type: mailbox.type,
				permission: mailbox.permission,
				isPrimary: mailbox.isPrimary,
				createdAt: mailbox.createdAt,
			})),
		});
	},
	{ requiredScope: "messages:read" },
);
