/**
 * Sending the ICS invitation that goes with a calendar event.
 *
 * Create always sends. Update only sends when something an attendee cares about
 * changed (the guest list, or the time), so a colour or description tweak does
 * not spam every guest.
 */
import { createCalendarInvitation } from "@/lib/calendar/utils";
import { sendEmail } from "@/lib/email/send";

export type InvitationEvent = {
	id: string;
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	allDay: boolean;
	timezone: string;
	rrule: string | null;
};

export type SendInvitationsInput = {
	env: AppEnv;
	userId: string;
	mailboxId: string;
	from: string;
	attendees: string[];
	event: InvitationEvent;
	kind: "created" | "updated";
	sequence?: number;
};

/** True when an update is material enough to re-send the invitation. */
export function invitationNeedsResend(
	before: { attendees: string[]; startsAt: Date; endsAt: Date },
	after: { attendees: string[]; startsAt: Date; endsAt: Date },
): boolean {
	if (before.startsAt.getTime() !== after.startsAt.getTime()) return true;
	if (before.endsAt.getTime() !== after.endsAt.getTime()) return true;
	const left = [...before.attendees].sort().join(",");
	const right = [...after.attendees].sort().join(",");
	return left !== right;
}

export async function sendInvitations({
	env,
	userId,
	mailboxId,
	from,
	attendees,
	event,
	kind,
	sequence = 0,
}: SendInvitationsInput): Promise<void> {
	if (!attendees.length || !mailboxId) return;

	const file = createCalendarInvitation({
		uid: event.id,
		title: event.title,
		description: event.description,
		location: event.location,
		startsAt: event.startsAt,
		endsAt: event.endsAt,
		allDay: event.allDay,
		timezone: event.timezone,
		rrule: event.rrule,
		attendees,
		organizer: from || null,
		sequence,
		method: "REQUEST",
	});
	const content = file.buffer.slice(
		file.byteOffset,
		file.byteOffset + file.byteLength,
	) as ArrayBuffer;

	const subject =
		kind === "created" ? `Invitation: ${event.title}` : `Updated invitation: ${event.title}`;
	const fallback =
		kind === "created"
			? `You are invited to ${event.title}.`
			: `This event has been updated: ${event.title}.`;

	await Promise.all(
		attendees.map((to) =>
			sendEmail(env, {
				userId,
				mailboxId,
				from,
				to,
				subject,
				text: event.description || fallback,
				attachments: [
					{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content },
				],
			}),
		),
	);
}
