import { and, eq } from "drizzle-orm";
import { calendarEvents } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { buildIcsCalendar } from "@/lib/calendar/ics";
import { parseAttendees } from "../events/utils";

/** Never export an unbounded calendar in one file. */
const MAX_EXPORTED_EVENTS = 5000;

/**
 * GET /api/calendar/export.ics
 *
 * The events the caller owns, as one downloadable VCALENDAR. Series are
 * exported as their RRULE, not as expanded occurrences, so re-importing them
 * anywhere gives back the same calendar.
 */
export const GET = withOrg(async ({ db, user, scoped }) => {
	const rows = await db
		.select()
		.from(calendarEvents)
		.where(and(scoped(calendarEvents), eq(calendarEvents.userId, user.id)))
		.orderBy(calendarEvents.startsAt)
		.limit(MAX_EXPORTED_EVENTS);

	const body = buildIcsCalendar(
		rows.map((row) => ({
			uid: row.uid,
			title: row.title,
			description: row.description,
			location: row.location,
			startsAt: row.startsAt,
			endsAt: row.endsAt,
			allDay: row.allDay,
			timezone: row.timezone,
			rrule: row.rrule,
			attendees: parseAttendees(row.attendees),
		})),
		{ method: "PUBLISH" },
	);

	return new Response(body, {
		headers: {
			"Content-Type": "text/calendar; charset=utf-8",
			"Content-Disposition": 'attachment; filename="mailflare-calendar.ics"',
			"Cache-Control": "no-store",
		},
	});
});
