import { NextResponse } from "next/server";
import type { OrgContext } from "@/lib/api/with-org";
import { getConversation } from "@/lib/conversations/service";
import type { ConversationRow } from "@/lib/conversations/service";
import { getMailboxAccessLevel, hasMailboxPermission } from "@/lib/mailboxes/access";
import type { MailboxPermission } from "@/lib/mailboxes/types";

export type ConversationRouteParams = { params: Promise<{ id: string }> };

/**
 * Loads a conversation and checks the caller's access to its mailbox.
 *
 * Everything is re-checked against the request's organisation: a conversation
 * or mailbox in another organisation is treated as missing. A mailbox the
 * caller cannot read is likewise indistinguishable from one that does not
 * exist (404); one they can read but lack the rank for is a 403.
 */
export async function requireConversationAccess(
	ctx: OrgContext,
	conversationId: string,
	required: MailboxPermission,
): Promise<{ conversation: ConversationRow } | { response: NextResponse }> {
	const conversation = await getConversation(ctx.db, conversationId, ctx.orgId);
	if (!conversation) {
		return { response: NextResponse.json({ error: "Conversation not found" }, { status: 404 }) };
	}
	const access = await getMailboxAccessLevel(ctx.db, ctx.user, conversation.mailboxId, ctx.orgId);
	if (!access?.canRead) {
		return { response: NextResponse.json({ error: "Conversation not found" }, { status: 404 }) };
	}
	if (!hasMailboxPermission(access.permission, required)) {
		return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	}
	return { conversation };
}
