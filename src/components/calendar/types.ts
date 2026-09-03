/** What `GET /api/calendar/events` returns: one entry per occurrence. */
export type CalendarOccurrence = {
	/** Unique per occurrence, safe as a React key. */
	id: string;
	eventId: string;
	uid: string;
	title: string;
	description: string;
	location: string;
	attendees: string[];
	/** ISO instant of this occurrence. */
	startsAt: string;
	endsAt: string;
	allDay: boolean;
	timezone: string;
	rrule: string | null;
	visibility: "private" | "organization";
	color: string | null;
	mailboxId: string | null;
	/** First instant of the series, which is what a series edit writes back. */
	seriesStartsAt: string;
	seriesEndsAt: string;
	isRecurring: boolean;
	/** True for an organisation event owned by somebody else. */
	readOnly: boolean;
	ownerUserId: string;
	ownerName: string | null;
};

export type CalendarViewMode = "month" | "week" | "agenda";

export type CalendarScope = "mine" | "organization";
