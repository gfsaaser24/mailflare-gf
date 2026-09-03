/**
 * The JSON body POST and PATCH accept. The runtime check lives in
 * `src/app/api/calendar/events/utils.ts` (`eventInputSchema`); this type is the
 * documentation-facing mirror of it.
 */
export type CalendarEventInput = {
	title: string;
	description?: string;
	location?: string;
	attendees?: string[];
	startsAt: string;
	endsAt: string;
	/** Ignores the clock part of the times. */
	allDay?: boolean;
	/** IANA zone the wall-clock times were entered in. Defaults to UTC. */
	timezone?: string;
	/** RFC 5545 RRULE body, without the `RRULE:` prefix. Null clears it. */
	rrule?: string | null;
	visibility?: "private" | "organization";
	/** `#rrggbb`, or null for the default chip colour. */
	color?: string | null;
	mailboxId?: string | null;
	from?: string;
	/** Set false to save without mailing the guests. */
	sendInvites?: boolean;
};
