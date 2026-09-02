import { NextResponse } from "next/server";
import type { AppDatabase } from "@/db";
import { getConversation } from "@/lib/conversations/service";
import type { ConversationRow } from "@/lib/conversations/service";
import { getMailboxAccessLevel, hasMailboxPermission } from "@/lib/mailboxes/access";
import type { MailboxPermission } from "@/lib/mailboxes/types";
import type { SessionUser } from "@/lib/auth/types";

export type ConversationRouteParams = { params: Promise<{ id: string }> };

/**
 * Loads a conversation and checks the caller's access to its mailbox.
 *
 * A mailbox the caller cannot read is indistinguishable from one that does not
 * exist (404). A mailbox they can read but lack the rank for is a 403.
 */
export async function requireConversationAccess(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "role">,
	conversationId: string,
	required: MailboxPermission,
): Promise<{ conversation: ConversationRow } | { response: NextResponse }> {
	const conversation = await getConversation(db, conversationId);
	if (!conversation) {
		return { response: NextResponse.json({ error: "Conversation not found" }, { status: 404 }) };
	}
	const access = await getMailboxAccessLevel(db, user, conversation.mailboxId);
	if (!access?.canRead) {
		return { response: NextResponse.json({ error: "Conversation not found" }, { status: 404 }) };
	}
	if (!hasMailboxPermission(access.permission, required)) {
		return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	}
	return { conversation };
}
