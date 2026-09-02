import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { messages } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { v1MessagePatchSchema } from "../../schemas";
import { readV1Json, v1Error, v1Route, type IdRouteContext } from "../../route-helpers";

/**
 * `PATCH /api/v1/messages/[id]` — `read`, `starred`, `status` and `snoozedUntil`
 * in one call.
 *
 * Ranks match the internal routes: `read`/`starred` need `read_only` on the
 * mailbox, `status`/`snoozedUntil` need `full_access`.
 */
export const PATCH = v1Route<IdRouteContext>(
	async (ctx, request, { params }) => {
		const { id } = await params;
		const { db, user, orgId, scoped } = ctx;

		const json = await readV1Json(request, 16 * 1024);
		if ("response" in json) return json.response;
		const parsed = v1MessagePatchSchema.safeParse(json.body);
		if (!parsed.success) return v1Error("Invalid message update", 400, "invalid_body");
		const update = parsed.data;

		let snoozedUntil: Date | null | undefined;
		if (update.snoozedUntil !== undefined) {
			if (update.snoozedUntil === null) {
				snoozedUntil = null;
			} else {
				snoozedUntil = new Date(update.snoozedUntil);
				if (Number.isNaN(snoozedUntil.getTime()) || snoozedUntil <= new Date()) {
					return v1Error("Choose a future snooze time", 400, "invalid_body");
				}
			}
		}

		const [message] = await db
			.select({ id: messages.id, mailboxId: messages.mailboxId })
			.from(messages)
			.where(and(scoped(messages), eq(messages.id, id)))
			.limit(1);
		if (!message?.mailboxId) return v1Error("Message not found", 404, "not_found");

		const access = await getMailboxAccessLevel(db, user, message.mailboxId, orgId);
		if (!access?.canRead) return v1Error("Message not found", 404, "not_found");
		const needsManage = update.status !== undefined || update.snoozedUntil !== undefined;
		if (needsManage && !access.canManage) return v1Error("Forbidden", 403, "forbidden");

		const values: { read?: boolean; starred?: boolean; status?: string; snoozedUntil?: Date | null } =
			{};
		if (update.read !== undefined) values.read = update.read;
		if (update.starred !== undefined) values.starred = update.starred;
		if (update.status !== undefined) values.status = update.status;
		if (snoozedUntil !== undefined) values.snoozedUntil = snoozedUntil;

		const [updated] = await db
			.update(messages)
			.set(values)
			.where(and(scoped(messages), eq(messages.id, message.id)))
			.returning({
				id: messages.id,
				mailboxId: messages.mailboxId,
				conversationId: messages.conversationId,
				read: messages.read,
				starred: messages.starred,
				status: messages.status,
				snoozedUntil: messages.snoozedUntil,
			});
		if (!updated) return v1Error("Message not found", 404, "not_found");

		if (update.status !== undefined) {
			await createAuditLog(ctx.env, {
				actorUserId: user.id,
				mailboxId: message.mailboxId,
				messageId: message.id,
				action: "email.delete",
				metadata: { status: update.status },
			});
		}

		return NextResponse.json({ message: updated });
	},
	{ requiredScope: "messages:write" },
);
