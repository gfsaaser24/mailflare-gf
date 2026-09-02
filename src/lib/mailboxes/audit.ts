import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, mailboxes } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getUserOrganizationId } from "@/lib/organizations/service";
import type { AuditLogInput } from "./types";

/**
 * Writes an audit row stamped with the right organisation. The org is taken from
 * `input.organizationId`, else the actor, else the target user, else the mailbox.
 * Rows with none of those (e.g. system events) stay on the schema default.
 */
export async function createAuditLog(env: CloudflareEnv, input: AuditLogInput): Promise<void> {
	const db = getDb(env);
	let organizationId = input.organizationId ?? null;
	try {
		if (!organizationId && input.actorUserId) organizationId = await getUserOrganizationId(db, input.actorUserId);
		if (!organizationId && input.targetUserId) organizationId = await getUserOrganizationId(db, input.targetUserId);
		if (!organizationId && input.mailboxId) {
			const [mailbox] = await db
				.select({ organizationId: mailboxes.organizationId })
				.from(mailboxes)
				.where(eq(mailboxes.id, input.mailboxId))
				.limit(1);
			organizationId = mailbox?.organizationId ?? null;
		}
	} catch {
		organizationId = null;
	}
	await db.insert(auditLogs).values({
		id: newId("aud"),
		...(organizationId ? { organizationId } : {}),
		actorUserId: input.actorUserId ?? null,
		targetUserId: input.targetUserId ?? null,
		mailboxId: input.mailboxId ?? null,
		messageId: input.messageId ?? null,
		action: input.action,
		metadata: input.metadata ? JSON.stringify(input.metadata) : null,
	});
}
