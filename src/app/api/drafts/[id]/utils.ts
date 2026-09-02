import { and, eq } from "drizzle-orm";
import { messages } from "@/db/schema";
import type { OrgContext } from "@/lib/api/with-org";

/** The draft with its body, or null when it is not this user's draft in this organisation. */
export function selectDraftWithBody({ db, scoped }: OrgContext, userId: string, draftId: string) {
	return db
		.select({
			id: messages.id,
			userId: messages.userId,
			mailboxId: messages.mailboxId,
			fromAddr: messages.fromAddr,
			toAddr: messages.toAddr,
			subject: messages.subject,
			status: messages.status,
			textBody: messages.textBody,
			htmlBody: messages.htmlBody,
		})
		.from(messages)
		.where(and(scoped(messages), eq(messages.id, draftId)))
		.limit(1)
		.then(([draft]) => (draft && draft.userId === userId && draft.status === "draft" ? draft : null));
}
