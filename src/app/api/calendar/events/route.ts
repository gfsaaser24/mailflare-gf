import { and, eq, gte, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { calendarEvents } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { createCalendarInvitation } from "@/lib/calendar/utils";
import { sendEmail } from "@/lib/email/send";
import { newId } from "@/lib/ids";
import type { CalendarEventInput } from "./types";
import { canUseMailbox } from "./utils";

export const GET = withOrg(async ({ db, user, scoped }, request) => {
	const url = new URL(request.url);
	const start = new Date(url.searchParams.get("start") ?? Date.now());
	const end = new Date(url.searchParams.get("end") ?? start.getTime() + 31 * 86_400_000);
	const events = await db
		.select()
		.from(calendarEvents)
		.where(
			and(
				scoped(calendarEvents),
				eq(calendarEvents.userId, user.id),
				gte(calendarEvents.startsAt, start),
				lt(calendarEvents.startsAt, end),
			),
		)
		.orderBy(calendarEvents.startsAt);
	return NextResponse.json({ events });
});

export const POST = withOrg(async (ctx, request) => {
	const { db, env, user, insertValues } = ctx;
	const input = (await request.json()) as CalendarEventInput;
	const startsAt = new Date(input.startsAt);
	const endsAt = new Date(input.endsAt);
	if (
		!input.title?.trim() ||
		Number.isNaN(startsAt.getTime()) ||
		Number.isNaN(endsAt.getTime()) ||
		endsAt <= startsAt
	) {
		return NextResponse.json({ error: "Enter a title and valid event times" }, { status: 400 });
	}

	// A mailbox from another organisation must look like it does not exist.
	if (input.mailboxId && !(await canUseMailbox(ctx, input.mailboxId))) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const attendees = (input.attendees ?? [])
		.map((email) => email.trim())
		.filter((email) => /^\S+@\S+\.\S+$/.test(email));
	const event = {
		id: newId("evt"),
		userId: user.id,
		mailboxId: input.mailboxId ?? null,
		title: input.title.trim(),
		description: input.description?.trim() ?? "",
		location: input.location?.trim() ?? "",
		attendees: JSON.stringify(attendees),
		startsAt,
		endsAt,
	};
	await db.insert(calendarEvents).values(insertValues(calendarEvents, event));

	if (attendees.length && input.mailboxId) {
		const calendarFile = createCalendarInvitation({ ...event, uid: event.id });
		const calendarBuffer = calendarFile.buffer.slice(
			calendarFile.byteOffset,
			calendarFile.byteOffset + calendarFile.byteLength,
		) as ArrayBuffer;
		await Promise.all(
			attendees.map((to) =>
				sendEmail(env, {
					userId: user.id,
					mailboxId: input.mailboxId!,
					from: input.from ?? "",
					to,
					subject: `Invitation: ${event.title}`,
					text: event.description || `You are invited to ${event.title}.`,
					attachments: [
						{
							filename: "invite.ics",
							type: "text/calendar; charset=utf-8",
							content: calendarBuffer,
						},
					],
				}),
			),
		);
	}
	return NextResponse.json({ event });
});
