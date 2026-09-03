/**
 * Turning a stored event into the occurrences that fall inside a window.
 *
 * A row in `calendar_events` is either a single event or the *series* head of a
 * recurrence (`rrule`, an RFC 5545 RRULE body without the `RRULE:` prefix).
 * The API never stores one row per occurrence; the list a client sees is
 * computed here, per query.
 *
 * `rrule` carries no zone database, so a series is expanded in the "floating"
 * space of `src/lib/calendar/zones.ts`: the wall clock of the event's zone is
 * treated as if it were UTC, iterated, then mapped back to real instants. That
 * is what keeps "09:00 every Monday" at 09:00 across a DST change.
 */
import { RRule } from "rrule";
import { DEFAULT_TIMEZONE, floatingFromInstant, instantFromFloating } from "./zones";

/** Hard ceiling per event per query, so one pathological rule cannot hang a request. */
export const MAX_OCCURRENCES_PER_EVENT = 500;

/** Longest RRULE body accepted from a client. */
export const MAX_RRULE_LENGTH = 200;

export type RecurringEvent = {
	eventId: string;
	startsAt: Date;
	endsAt: Date;
	rrule?: string | null;
	timezone?: string | null;
	allDay?: boolean | null;
};

export type Occurrence = {
	eventId: string;
	occurrenceStart: Date;
	occurrenceEnd: Date;
	isRecurring: boolean;
};

/** Strips a leading `RRULE:` and normalises whitespace/case of the body. */
export function normalizeRrule(value: string): string {
	return value.trim().replace(/^RRULE:/i, "").trim();
}

/** The zone an event is expanded in. All-day events always run on UTC dates. */
function zoneOf(event: RecurringEvent): string {
	return event.allDay ? DEFAULT_TIMEZONE : (event.timezone || DEFAULT_TIMEZONE);
}

/**
 * Parses an RRULE body into `rrule` options anchored at `dtstart`.
 * Returns null when the body is unusable.
 */
function parseRule(body: string, dtstart: Date, timeZone: string): RRule | null {
	try {
		const options = RRule.parseString(body);
		if (!options.freq && options.freq !== 0) return null;
		options.dtstart = dtstart;
		options.tzid = null;
		// UNTIL is parsed as a real UTC instant; the iteration runs on floating
		// dates, so the bound has to move into the same space.
		if (options.until) options.until = floatingFromInstant(options.until, timeZone);
		return new RRule(options);
	} catch {
		return null;
	}
}

/** True when `body` is an RRULE this server can expand. */
export function isValidRrule(body: string): boolean {
	const normalized = normalizeRrule(body);
	if (!normalized || normalized.length > MAX_RRULE_LENGTH) return false;
	return parseRule(normalized, new Date(0), DEFAULT_TIMEZONE) !== null;
}

/**
 * Every occurrence of `event` that overlaps `[windowStart, windowEnd)`.
 *
 * A single event yields at most one occurrence. A series yields at most
 * `max` (default `MAX_OCCURRENCES_PER_EVENT`); an unparseable rule degrades to
 * the single event rather than failing the whole query.
 */
export function expandOccurrences(
	event: RecurringEvent,
	windowStart: Date,
	windowEnd: Date,
	max: number = MAX_OCCURRENCES_PER_EVENT,
): Occurrence[] {
	const durationMs = Math.max(0, event.endsAt.getTime() - event.startsAt.getTime());
	const body = event.rrule ? normalizeRrule(event.rrule) : "";

	const single = (): Occurrence[] => {
		const end = new Date(event.startsAt.getTime() + durationMs);
		const overlaps =
			event.startsAt.getTime() < windowEnd.getTime() &&
			Math.max(end.getTime(), event.startsAt.getTime() + 1) > windowStart.getTime();
		return overlaps
			? [
					{
						eventId: event.eventId,
						occurrenceStart: new Date(event.startsAt),
						occurrenceEnd: end,
						isRecurring: false,
					},
				]
			: [];
	};

	if (!body || body.length > MAX_RRULE_LENGTH) return single();

	const timeZone = zoneOf(event);
	const rule = parseRule(body, floatingFromInstant(event.startsAt, timeZone), timeZone);
	if (!rule) return single();

	// Search from one duration before the window so an occurrence that started
	// earlier but is still running is not lost.
	const searchFrom = floatingFromInstant(
		new Date(windowStart.getTime() - durationMs),
		timeZone,
	);
	const searchTo = floatingFromInstant(windowEnd, timeZone);
	if (searchTo.getTime() <= searchFrom.getTime()) return [];

	const limit = Math.max(1, Math.min(max, MAX_OCCURRENCES_PER_EVENT));
	// The callback runs *before* the date is kept and `len` is the count so far,
	// so `len < limit` keeps exactly `limit` of them and then stops the iterator.
	const floating = rule.between(searchFrom, searchTo, true, (_date, len) => len < limit);

	const occurrences: Occurrence[] = [];
	for (const point of floating) {
		const occurrenceStart = instantFromFloating(point, timeZone);
		const occurrenceEnd = new Date(occurrenceStart.getTime() + durationMs);
		if (occurrenceStart.getTime() >= windowEnd.getTime()) continue;
		if (Math.max(occurrenceEnd.getTime(), occurrenceStart.getTime() + 1) <= windowStart.getTime())
			continue;
		occurrences.push({
			eventId: event.eventId,
			occurrenceStart,
			occurrenceEnd,
			isRecurring: true,
		});
		if (occurrences.length >= limit) break;
	}
	return occurrences;
}

/** Expands many events and returns one list sorted by start time. */
export function expandAll(
	events: RecurringEvent[],
	windowStart: Date,
	windowEnd: Date,
	max: number = MAX_OCCURRENCES_PER_EVENT,
): Occurrence[] {
	return events
		.flatMap((event) => expandOccurrences(event, windowStart, windowEnd, max))
		.sort((a, b) => a.occurrenceStart.getTime() - b.occurrenceStart.getTime());
}
