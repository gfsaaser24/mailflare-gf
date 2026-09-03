import { and, eq, gt, isNotNull, lt, ne, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { calendarEvents, users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { expandOccurrences } from "@/lib/calendar/recurrence";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { newId } from "@/lib/ids";
import { sendInvitations } from "./invites";
import {
	canUseMailbox,
	normalizeEventInput,
	parseRangeQuery,
	toOccurrenceDto,
	type CalendarOccurrenceDto,
} from "./utils";

const MAX_BODY_BYTES = 128 * 1024;

/**
 * GET /api/calendar/events?start&end&scope=mine|organization
 *
 * Returns *occurrences*, not rows: a recurring event is expanded inside the
 * window (see `src/lib/calendar/recurrence.ts`), a single event yields one
 * occurrence. `scope=organization` adds events other members of the org marked
 * `visibility=organization`; those come back `readOnly` with the owner name.
 */
export const GET = withOrg(async ({ db, user, orgId, scoped }, request) => {
	const range = parseRangeQuery(new URL(request.url));
	if (!range.ok) return NextResponse.json({ error: range.error }, { status: 400 });
	const { start, end, scope } = range.value;

	// A series head can start before the window and still have occurrences in
	// it, so recurring rows are kept whatever their end date.
	const overlapsWindow = and(
		lt(calendarEvents.startsAt, end),
		or(isNotNull(calendarEvents.rrule), gt(calendarEvents.endsAt, start)),
	);

	const own = await db
		.select()
		.from(calendarEvents)
		.where(and(scoped(calendarEvents), eq(calendarEvents.userId, user.id), overlapsWindow))
		.orderBy(calendarEvents.startsAt);

	const occurrences: CalendarOccurrenceDto[] = [];
	for (const row of own) {
		for (const occurrence of expandOccurrences(
			{
				eventId: row.id,
				startsAt: row.startsAt,
				endsAt: row.endsAt,
				rrule: row.rrule,
				timezone: row.timezone,
				allDay: row.allDay,
			},
			start,
			end,
		)) {
			occurrences.push(toOccurrenceDto(row, occurrence, { readOnly: false, ownerName: null }));
		}
	}

	if (scope === "organization") {
		const shared = await db
			.select({ event: calendarEvents, ownerName: users.name })
			.from(calendarEvents)
			.innerJoin(users, eq(users.id, calendarEvents.userId))
			.where(
				and(
					scoped(calendarEvents),
					eq(users.organizationId, orgId),
					eq(calendarEvents.visibility, "organization"),
					ne(calendarEvents.userId, user.id),
					overlapsWindow,
				),
			)
			.orderBy(calendarEvents.startsAt);

		for (const { event: row, ownerName } of shared) {
			for (const occurrence of expandOccurrences(
				{
					eventId: row.id,
					startsAt: row.startsAt,
					endsAt: row.endsAt,
					rrule: row.rrule,
					timezone: row.timezone,
					allDay: row.allDay,
				},
				start,
				end,
			)) {
				occurrences.push(toOccurrenceDto(row, occurrence, { readOnly: true, ownerName }));
			}
		}
	}

	occurrences.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
	return NextResponse.json({
		occurrences,
		// The pre-expansion shape, kept so older callers that read `events` (the
		// caller own rows, unexpanded) keep working.
		events: own,
		scope,
		rangeStart: start.toISOString(),
		rangeEnd: end.toISOString(),
	});
});

/** POST /api/calendar/events — create one event (single or series). */
export const POST = withOrg(async (ctx, request) => {
	const { db, env, user, insertValues } = ctx;

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

	// A mailbox from another organisation must look like it does not exist.
	const mailboxId = input.mailboxId ?? null;
	if (mailboxId && !(await canUseMailbox(ctx, mailboxId))) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const id = newId("evt");
	const event = {
		id,
		userId: user.id,
		mailboxId,
		title: input.title,
		description: input.description,
		location: input.location,
		attendees: JSON.stringify(input.attendees),
		startsAt: input.startsAt,
		endsAt: input.endsAt,
		allDay: input.allDay,
		timezone: input.timezone,
		rrule: input.rrule,
		uid: id,
		visibility: input.visibility,
		color: input.color,
	};
	await db.insert(calendarEvents).values(insertValues(calendarEvents, event));

	if (input.sendInvites && input.attendees.length && mailboxId) {
		await sendInvitations({
			env,
			userId: user.id,
			mailboxId,
			from: input.from,
			attendees: input.attendees,
			event: {
				id,
				title: input.title,
				description: input.description,
				location: input.location,
				startsAt: input.startsAt,
				endsAt: input.endsAt,
				allDay: input.allDay,
				timezone: input.timezone,
				rrule: input.rrule,
			},
			kind: "created",
		});
	}

	return NextResponse.json({ event });
});
