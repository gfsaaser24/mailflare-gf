/**
 * The invitation attachment that goes out with a calendar email.
 *
 * The document itself is built by `src/lib/calendar/ics.ts`; this file only
 * keeps the mail-facing shape (a `Uint8Array` ready to attach) and the historic
 * `<uid>@mailflare` UID form, so an update lands on the same event in the
 * recipient calendar as the original invitation.
 */
import { buildIcsCalendar, type IcsMethod } from "./ics";

type CalendarInvitationInput = {
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	uid: string;
	method?: IcsMethod;
	allDay?: boolean | null;
	timezone?: string | null;
	rrule?: string | null;
	attendees?: string[];
	organizer?: string | null;
	/** Bumped on every update so clients replace rather than duplicate. */
	sequence?: number | null;
};

/** The `UID` an invitation for `id` carries, in and out. */
export function invitationUid(id: string): string {
	return `${id}@mailflare`;
}

export function createCalendarInvitation(input: CalendarInvitationInput): Uint8Array {
	const text = buildIcsCalendar(
		[
			{
				uid: invitationUid(input.uid),
				title: input.title,
				description: input.description,
				location: input.location,
				startsAt: input.startsAt,
				endsAt: input.endsAt,
				allDay: input.allDay ?? false,
				timezone: input.timezone ?? "UTC",
				rrule: input.rrule ?? null,
				attendees: input.attendees ?? [],
				organizer: input.organizer ?? null,
				sequence: input.sequence ?? 0,
			},
		],
		{ method: input.method ?? "REQUEST" },
	);
	return new TextEncoder().encode(text);
}
