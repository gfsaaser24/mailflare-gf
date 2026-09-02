/**
 * Ownership transfer (T3.5).
 *
 * Moves everything one account owns to another account **of the same
 * organisation**, in one transaction, before the first account is disabled.
 * A target in another organisation is refused: that would move rows across the
 * tenant boundary, which nothing in this codebase is allowed to do.
 */
import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import {
	apiKeys,
	auditLogs,
	contacts,
	conversations,
	folders,
	mailboxes,
	messages,
	users,
	webhooks,
} from "@/db/schema";
import { newId } from "@/lib/ids";

export class TransferUserNotFoundError extends Error {
	constructor(public readonly which: "from" | "to") {
		super(which === "from" ? "Account not found" : "Target account not found");
		this.name = "TransferUserNotFoundError";
	}
}

export class TransferSameUserError extends Error {
	constructor() {
		super("Cannot transfer an account to itself");
		this.name = "TransferSameUserError";
	}
}

export type TransferCounts = {
	mailboxes: number;
	conversations: number;
	folders: number;
	contacts: number;
	drafts: number;
	webhooks: number;
	apiKeys: number;
};

export type TransferResult = {
	fromUserId: string;
	toUserId: string;
	counts: TransferCounts;
};

/**
 * Moves mailboxes, assigned conversations, folders, contacts, draft messages,
 * webhooks and API keys from one account to another inside `organizationId`,
 * and writes the `account.transfer` audit row.
 */
export async function transferOwnership(
	db: AppDatabase,
	input: {
		organizationId: string;
		fromUserId: string;
		toUserId: string;
		actorUserId?: string | null;
	},
): Promise<TransferResult> {
	const { organizationId, fromUserId, toUserId } = input;
	if (fromUserId === toUserId) throw new TransferSameUserError();

	return db.transaction(async (tx) => {
		const inOrg = async (id: string) => {
			const [row] = await tx
				.select({ id: users.id })
				.from(users)
				.where(and(eq(users.organizationId, organizationId), eq(users.id, id)))
				.limit(1);
			return !!row;
		};
		if (!(await inOrg(fromUserId))) throw new TransferUserNotFoundError("from");
		// A target of another organisation reads as missing, exactly like every
		// other cross-org lookup in the app.
		if (!(await inOrg(toUserId))) throw new TransferUserNotFoundError("to");

		const movedMailboxes = await tx
			.update(mailboxes)
			.set({ userId: toUserId })
			.where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.userId, fromUserId)))
			.returning({ id: mailboxes.id });

		const movedConversations = await tx
			.update(conversations)
			.set({ assignedUserId: toUserId })
			.where(
				and(
					eq(conversations.organizationId, organizationId),
					eq(conversations.assignedUserId, fromUserId),
				),
			)
			.returning({ id: conversations.id });

		const movedFolders = await tx
			.update(folders)
			.set({ userId: toUserId })
			.where(and(eq(folders.organizationId, organizationId), eq(folders.userId, fromUserId)))
			.returning({ id: folders.id });

		// `contacts` is unique on (user_id, email): drop the duplicates the target
		// already has rather than crashing the whole transfer on one address.
		await tx.execute(sql`
			DELETE FROM ${contacts} AS "src"
			WHERE "src"."user_id" = ${fromUserId}
			  AND "src"."organization_id" = ${organizationId}
			  AND EXISTS (
				SELECT 1 FROM ${contacts} AS "dst"
				WHERE "dst"."user_id" = ${toUserId} AND "dst"."email" = "src"."email"
			  )
		`);
		const movedContacts = await tx
			.update(contacts)
			.set({ userId: toUserId })
			.where(and(eq(contacts.organizationId, organizationId), eq(contacts.userId, fromUserId)))
			.returning({ id: contacts.id });

		const movedDrafts = await tx
			.update(messages)
			.set({ userId: toUserId })
			.where(
				and(
					eq(messages.organizationId, organizationId),
					eq(messages.userId, fromUserId),
					eq(messages.direction, "outbound"),
					eq(messages.status, "draft"),
				),
			)
			.returning({ id: messages.id });

		const movedWebhooks = await tx
			.update(webhooks)
			.set({ userId: toUserId })
			.where(and(eq(webhooks.organizationId, organizationId), eq(webhooks.userId, fromUserId)))
			.returning({ id: webhooks.id });

		const movedApiKeys = await tx
			.update(apiKeys)
			.set({ userId: toUserId })
			.where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.userId, fromUserId)))
			.returning({ id: apiKeys.id });

		const counts: TransferCounts = {
			mailboxes: movedMailboxes.length,
			conversations: movedConversations.length,
			folders: movedFolders.length,
			contacts: movedContacts.length,
			drafts: movedDrafts.length,
			webhooks: movedWebhooks.length,
			apiKeys: movedApiKeys.length,
		};

		await tx.insert(auditLogs).values({
			id: newId("aud"),
			organizationId,
			actorUserId: input.actorUserId ?? null,
			targetUserId: fromUserId,
			action: "account.transfer",
			metadata: JSON.stringify({ fromUserId, toUserId, counts }),
		});

		return { fromUserId, toUserId, counts };
	});
}
