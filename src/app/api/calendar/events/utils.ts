import { z } from "zod";
import type { calendarEvents } from "@/db/schema";
import type { OrgContext } from "@/lib/api/with-org";
import { isValidRrule, MAX_RRULE_LENGTH, normalizeRrule, type Occurrence } from "@/lib/calendar/recurrence";
import { DEFAULT_TIMEZONE, isValidTimeZone } from "@/lib/calendar/zones";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

/**
 * Calendar events point at a mailbox to send invitations from. The mailbox is
 * reached through another table, so it is re-checked against the request
 * organisation: a mailbox in another org is treated as missing.
 */
export async function canUseMailbox(ctx: OrgContext, mailboxId: string): Promise<boolean> {
	const access = await getMailboxAccessLevel(ctx.db, ctx.user, mailboxId, ctx.orgId);
	return !!access?.canSendOnBehalf;
}

/** Longest window a single range query may ask for. */
export const MAX_RANGE_DAYS = 93;
const DAY_MS = 86_400_000;

export type CalendarScope = "mine" | "organization";
/** Which part of a series a mutation applies to. Only `all` is supported. */
export type MutationScope = "this" | "all";

export const SERIES_SCOPE_MESSAGE =
	"Editing a single occurrence is not supported. Use scope=all to change the whole series.";

const rangeQuerySchema = z.object({
	start: z.string().min(1).max(64).optional(),
	end: z.string().min(1).max(64).optional(),
	scope: z.enum(["mine", "organization"]).optional(),
});

export type RangeQuery = { start: Date; end: Date; scope: CalendarScope };

/** Validates `?start&end&scope` and clamps the window to `MAX_RANGE_DAYS`. */
export function parseRangeQuery(url: URL): { ok: true; value: RangeQuery } | { ok: false; error: string } {
	const parsed = rangeQuerySchema.safeParse({
		start: url.searchParams.get("start") ?? undefined,
		end: url.searchParams.get("end") ?? undefined,
		scope: url.searchParams.get("scope") ?? undefined,
	});
	if (!parsed.success) return { ok: false, error: "Invalid range parameters" };

	const start = parsed.data.start ? new Date(parsed.data.start) : new Date();
	if (Number.isNaN(start.getTime())) return { ok: false, error: "Invalid start date" };

	const end = parsed.data.end ? new Date(parsed.data.end) : new Date(start.getTime() + 31 * DAY_MS);
	if (Number.isNaN(end.getTime())) return { ok: false, error: "Invalid end date" };
	if (end.getTime() <= start.getTime()) return { ok: false, error: "end must be after start" };
	if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) {
		return { ok: false, error: `Range must be ${MAX_RANGE_DAYS} days or less` };
	}

	return { ok: true, value: { start, end, scope: parsed.data.scope ?? "mine" } };
}

/** `?scope=this|all` on a mutation. Defaults to the whole series. */
export function parseMutationScope(url: URL): MutationScope {
	return url.searchParams.get("scope") === "this" ? "this" : "all";
}

export const eventInputSchema = z.object({
	title: z.string().max(300),
	description: z.string().max(20_000).optional(),
	location: z.string().max(500).optional(),
	attendees: z.array(z.string().max(320)).max(200).optional(),
	startsAt: z.string().min(1).max(64),
	endsAt: z.string().min(1).max(64),
	allDay: z.boolean().optional(),
	timezone: z.string().max(100).optional(),
	rrule: z.string().max(500).nullish(),
	visibility: z.enum(["private", "organization"]).optional(),
	color: z.string().max(9).nullish(),
	mailboxId: z.string().max(64).nullish(),
	from: z.string().max(320).optional(),
	/** Explicit opt-out for invitation mail; invites are sent by default. */
	sendInvites: z.boolean().optional(),
});

export type EventInput = z.infer<typeof eventInputSchema>;

export type NormalizedEvent = {
	title: string;
	description: string;
	location: string;
	attendees: string[];
	startsAt: Date;
	endsAt: Date;
	allDay: boolean;
	timezone: string;
	rrule: string | null;
	visibility: "private" | "organization";
	color: string | null;
	mailboxId: string | null | undefined;
	from: string;
	sendInvites: boolean;
};

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Turns a raw request body into the values a row is written from, or an error
 * message that is safe to show the caller.
 */
export function normalizeEventInput(
	body: unknown,
): { ok: true; value: NormalizedEvent } | { ok: false; error: string } {
	const parsed = eventInputSchema.safeParse(body);
	if (!parsed.success) return { ok: false, error: "Invalid event payload" };
	const input = parsed.data;

	const title = input.title.trim();
	const startsAt = new Date(input.startsAt);
	const endsAt = new Date(input.endsAt);
	if (!title || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
		return { ok: false, error: "Enter a title and valid event times" };
	}

	const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
	if (!isValidTimeZone(timezone)) return { ok: false, error: "Unknown time zone" };

	let rrule: string | null = null;
	if (input.rrule != null && input.rrule.trim()) {
		const normalized = normalizeRrule(input.rrule);
		if (normalized.length > MAX_RRULE_LENGTH) {
			return { ok: false, error: `Repeat rule must be ${MAX_RRULE_LENGTH} characters or less` };
		}
		if (!isValidRrule(normalized)) return { ok: false, error: "Repeat rule is not a valid RRULE" };
		rrule = normalized;
	}

	const color = input.color?.trim() ? input.color.trim() : null;
	if (color && !HEX_COLOR_RE.test(color)) return { ok: false, error: "Colour must be a #rrggbb value" };

	const attendees = Array.from(
		new Set((input.attendees ?? []).map((email) => email.trim()).filter((email) => EMAIL_RE.test(email))),
	);

	return {
		ok: true,
		value: {
			title,
			description: input.description?.trim() ?? "",
			location: input.location?.trim() ?? "",
			attendees,
			startsAt,
			endsAt,
			allDay: input.allDay ?? false,
			timezone,
			rrule,
			visibility: input.visibility ?? "private",
			color,
			mailboxId: input.mailboxId === undefined ? undefined : (input.mailboxId ?? null),
			from: input.from?.trim() ?? "",
			sendInvites: input.sendInvites !== false,
		},
	};
}

type CalendarEventRow = typeof calendarEvents.$inferSelect;

export type CalendarOccurrenceDto = {
	/** Stable per occurrence, for list keys. */
	id: string;
	eventId: string;
	uid: string;
	title: string;
	description: string;
	location: string;
	attendees: string[];
	startsAt: string;
	endsAt: string;
	allDay: boolean;
	timezone: string;
	rrule: string | null;
	visibility: "private" | "organization";
	color: string | null;
	mailboxId: string | null;
	/** First instant of the series, so an edit dialog can load the real row. */
	seriesStartsAt: string;
	seriesEndsAt: string;
	isRecurring: boolean;
	readOnly: boolean;
	ownerUserId: string;
	ownerName: string | null;
};

export function parseAttendees(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

/** One row plus one expanded occurrence, as the client sees it. */
export function toOccurrenceDto(
	row: CalendarEventRow,
	occurrence: Occurrence,
	extra: { readOnly: boolean; ownerName: string | null },
): CalendarOccurrenceDto {
	return {
		id: `${row.id}@${occurrence.occurrenceStart.toISOString()}`,
		eventId: row.id,
		uid: row.uid,
		title: row.title,
		description: row.description,
		location: row.location,
		attendees: parseAttendees(row.attendees),
		startsAt: occurrence.occurrenceStart.toISOString(),
		endsAt: occurrence.occurrenceEnd.toISOString(),
		allDay: row.allDay,
		timezone: row.timezone,
		rrule: row.rrule,
		visibility: row.visibility,
		color: row.color,
		mailboxId: row.mailboxId,
		seriesStartsAt: row.startsAt.toISOString(),
		seriesEndsAt: row.endsAt.toISOString(),
		isRecurring: occurrence.isRecurring,
		readOnly: extra.readOnly,
		ownerUserId: row.userId,
		ownerName: extra.ownerName,
	};
}

/**
 * SEQUENCE for an outgoing update. There is no counter column, so seconds since
 * the row was created stands in: it only ever grows, which is all RFC 5545 asks.
 */
export function invitationSequence(createdAt: Date, now: Date = new Date()): number {
	return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 1000));
}
