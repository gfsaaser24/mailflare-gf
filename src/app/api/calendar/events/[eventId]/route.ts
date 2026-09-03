import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { calendarEvents } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { invitationNeedsResend, sendInvitations } from "../invites";
import {
	canUseMailbox,
	invitationSequence,
	normalizeEventInput,
	parseAttendees,
	parseMutationScope,
	SERIES_SCOPE_MESSAGE,
} from "../utils";
import type { CalendarEventRouteParams } from "./types";

const MAX_BODY_BYTES = 128 * 1024;

/**
 * PATCH /api/calendar/events/:id?scope=all
 *
 * A recurring event is only editable as a whole series: there is one row per
 * series and no exception list, so `scope=this` is refused rather than half
 * supported.
 */
export const PATCH = withOrg<CalendarEventRouteParams>(async (ctx, request, { params }) => {
	const { db, env, user, scoped } = ctx;
	const { eventId } = await params;

	let body: unknown;
	try {
		body = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) {
			return NextResponse.json({ error: error.message }, { status: 413 });
		}
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const normalized = normalizeEventInput(body);
	if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
	const input = normalized.value;

	const [existing] = await db
		.select()
		.from(calendarEvents)
		.where(
			and(scoped(calendarEvents), eq(calendarEvents.id, eventId), eq(calendarEvents.userId, user.id)),
		)
		.limit(1);
	if (!existing) return NextResponse.json({ error: "Event not found" }, { status: 404 });

	const scope = parseMutationScope(new URL(request.url));
	if (scope === "this" && (existing.rrule || input.rrule)) {
		return NextResponse.json({ error: SERIES_SCOPE_MESSAGE }, { status: 400 });
	}

	// `undefined` means "field absent": keep whatever mailbox the row has.
	const mailboxId = input.mailboxId === undefined ? existing.mailboxId : input.mailboxId;
	if (mailboxId && mailboxId !== existing.mailboxId && !(await canUseMailbox(ctx, mailboxId))) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	await db
		.update(calendarEvents)
		.set({
			title: input.title,
			description: input.description,
			location: input.location,
			attendees: JSON.stringify(input.attendees),
			startsAt: input.startsAt,
			endsAt: input.endsAt,
			allDay: input.allDay,
			timezone: input.timezone,
			rrule: input.rrule,
			visibility: input.visibility,
			color: input.color,
			mailboxId,
			updatedAt: new Date(),
		})
		.where(
			and(scoped(calendarEvents), eq(calendarEvents.id, eventId), eq(calendarEvents.userId, user.id)),
		);

	const from = input.from || "";
	const resend = invitationNeedsResend(
		{
			attendees: parseAttendees(existing.attendees),
			startsAt: existing.startsAt,
			endsAt: existing.endsAt,
		},
		{ attendees: input.attendees, startsAt: input.startsAt, endsAt: input.endsAt },
	);

	if (input.sendInvites && resend && input.attendees.length && mailboxId && from) {
		await sendInvitations({
			env,
			userId: user.id,
			mailboxId,
			from,
			attendees: input.attendees,
			event: {
				id: eventId,
				title: input.title,
				description: input.description,
				location: input.location,
				startsAt: input.startsAt,
				endsAt: input.endsAt,
				allDay: input.allDay,
				timezone: input.timezone,
				rrule: input.rrule,
			},
			kind: "updated",
			sequence: invitationSequence(existing.createdAt),
		});
	}

	return NextResponse.json({ ok: true });
});

/** DELETE /api/calendar/events/:id?scope=all — series only, same limit as PATCH. */
export const DELETE = withOrg<CalendarEventRouteParams>(
	async ({ db, user, scoped }, request, { params }) => {
		const { eventId } = await params;

		if (parseMutationScope(new URL(request.url)) === "this") {
			const [existing] = await db
				.select({ rrule: calendarEvents.rrule })
				.from(calendarEvents)
				.where(
					and(
						scoped(calendarEvents),
						eq(calendarEvents.id, eventId),
						eq(calendarEvents.userId, user.id),
					),
				)
				.limit(1);
			if (existing?.rrule) {
				return NextResponse.json({ error: SERIES_SCOPE_MESSAGE }, { status: 400 });
			}
		}

		await db
			.delete(calendarEvents)
			.where(
				and(
					scoped(calendarEvents),
					eq(calendarEvents.id, eventId),
					eq(calendarEvents.userId, user.id),
				),
			);
		return NextResponse.json({ ok: true });
	},
);
