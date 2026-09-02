import { and, eq } from "drizzle-orm";
import { mailboxes } from "@/db/schema";
import type { OrgContext } from "@/lib/api/with-org";

/** A shared inbox owned by this admin, inside the request's organisation. */
export async function getSharedMailboxForAdmin(
	{ db, scoped }: OrgContext,
	mailboxId: string,
	adminUserId: string,
) {
	const [mailbox] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(
			and(
				scoped(mailboxes),
				eq(mailboxes.id, mailboxId),
				eq(mailboxes.userId, adminUserId),
				eq(mailboxes.type, "shared"),
			),
		)
		.limit(1);
	return mailbox ?? null;
}
