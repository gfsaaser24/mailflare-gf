import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxAccess, mailboxes } from "@/db/schema";
import { getRealtimeEmitter } from "./emitter";
import type { NewMessageNotification } from "./types";

export function getSessionTokenFromRequest(request: Request): string | undefined {
	const cookie = request.headers.get("Cookie");
	if (!cookie) return undefined;

	for (const part of cookie.split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (name === "ep_session") {
			const value = valueParts.join("=");
			return value ? decodeURIComponent(value) : undefined;
		}
	}

	return undefined;
}

export async function getMailboxNotificationUserIds(
	env: CloudflareEnv,
	mailboxId: string,
	ownerUserId: string,
): Promise<string[]> {
	const db = getDb(env);
	const mailboxRows = await db
		.select({ domainOwnerUserId: domains.userId, type: mailboxes.type })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	const sharedUserIds = mailboxRows[0]?.type === "shared"
		? (await db
			.select({ userId: mailboxAccess.userId })
			.from(mailboxAccess)
			.where(eq(mailboxAccess.mailboxId, mailboxId)))
			.map((access) => access.userId)
		: [];

	return [
		...new Set([
			ownerUserId,
			mailboxRows[0]?.domainOwnerUserId,
			...sharedUserIds,
		].filter((userId): userId is string => !!userId)),
	];
}

export async function notifyUsersOfNewMessage(
	_env: CloudflareEnv,
	userIds: string[],
	payload: NewMessageNotification,
): Promise<void> {
	const emitter = getRealtimeEmitter();
	for (const userId of userIds) {
		emitter.publish(userId, payload);
	}
}
