import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { messages } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SnoozeMessagePayload } from "./types";
import { getSnoozedUntil } from "./utils";

export const POST = withOrg(
	async (
		{ db, user, orgId, scoped },
		request,
		{ params }: { params: Promise<{ messageId: string }> },
	) => {
		const { messageId } = await params;

		const payload = (await request.json()) as SnoozeMessagePayload;
		const snoozedUntil = getSnoozedUntil(payload.snoozedUntil);
		if (!snoozedUntil) {
			return NextResponse.json({ error: "Choose a future snooze time" }, { status: 400 });
		}

		const [message] = await db
			.select({ id: messages.id, mailboxId: messages.mailboxId, status: messages.status })
			.from(messages)
			.where(
				and(scoped(messages), eq(messages.id, messageId), eq(messages.direction, "inbound")),
			)
			.limit(1);
		if (!message?.mailboxId || message.status !== "received") {
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}

		const access = await getMailboxAccessLevel(db, user, message.mailboxId, orgId);
		if (!access?.canManage) {
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}

		await db
			.update(messages)
			.set({ snoozedUntil })
			.where(and(scoped(messages), eq(messages.id, message.id)));

		return NextResponse.json({ ok: true });
	},
);

export const DELETE = withOrg(
	async (
		{ db, user, orgId, scoped },
		_request,
		{ params }: { params: Promise<{ messageId: string }> },
	) => {
		const { messageId } = await params;

		const [message] = await db
			.select({ id: messages.id, mailboxId: messages.mailboxId })
			.from(messages)
			.where(
				and(scoped(messages), eq(messages.id, messageId), eq(messages.direction, "inbound")),
			)
			.limit(1);
		if (!message?.mailboxId) {
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}

		const access = await getMailboxAccessLevel(db, user, message.mailboxId, orgId);
		if (!access?.canManage) {
			return NextResponse.json({ error: "Message not found" }, { status: 404 });
		}

		await db
			.update(messages)
			.set({ snoozedUntil: null })
			.where(and(scoped(messages), eq(messages.id, message.id)));
		return NextResponse.json({ ok: true });
	},
);
