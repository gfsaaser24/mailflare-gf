/**
 * Mailbox-access checks for the v1 surface.
 *
 * Same rules as the internal routes (`src/app/api/conversations/access.ts`):
 * anything outside the request's organisation, or in a mailbox the caller
 * cannot read, is a 404; a mailbox they can read but lack the rank for is a
 * 403. Only the error shape differs — v1 answers `{ error, code }`.
 */
import { and, eq } from "drizzle-orm";
import type { NextResponse } from "next/server";
import { domains, mailboxes } from "@/db/schema";
import type { OrgContext } from "@/lib/api/with-org";
import { getConversation, type ConversationRow } from "@/lib/conversations/service";
import { getMailboxAccessLevel, hasMailboxPermission } from "@/lib/mailboxes/access";
import type { MailboxPermission } from "@/lib/mailboxes/types";
import { v1Error } from "./route-helpers";

export async function requireConversation(
	ctx: OrgContext,
	conversationId: string,
	required: MailboxPermission,
): Promise<{ conversation: ConversationRow } | { response: NextResponse }> {
	const conversation = await getConversation(ctx.db, conversationId, ctx.orgId);
	if (!conversation) {
		return { response: v1Error("Conversation not found", 404, "not_found") };
	}
	const access = await getMailboxAccessLevel(ctx.db, ctx.user, conversation.mailboxId, ctx.orgId);
	if (!access?.canRead) {
		return { response: v1Error("Conversation not found", 404, "not_found") };
	}
	if (!hasMailboxPermission(access.permission, required)) {
		return { response: v1Error("Forbidden", 403, "forbidden") };
	}
	return { conversation };
}

/** `local@hostname` for a mailbox in the caller's organisation, or null. */
export async function getMailboxAddress(
	ctx: OrgContext,
	mailboxId: string,
): Promise<string | null> {
	const [row] = await ctx.db
		.select({ localPart: mailboxes.localPart, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(domains.id, mailboxes.domainId))
		.where(and(ctx.scoped(mailboxes), eq(mailboxes.id, mailboxId)))
		.limit(1);
	return row ? `${row.localPart}@${row.hostname}` : null;
}
