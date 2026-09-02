import type { OrgContext } from "@/lib/api/with-org";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

/**
 * Calendar events point at a mailbox to send invitations from. The mailbox is
 * reached through another table, so it is re-checked against the request's
 * organisation: a mailbox in another org is treated as missing.
 */
export async function canUseMailbox(ctx: OrgContext, mailboxId: string): Promise<boolean> {
	const access = await getMailboxAccessLevel(ctx.db, ctx.user, mailboxId, ctx.orgId);
	return !!access?.canSendOnBehalf;
}
