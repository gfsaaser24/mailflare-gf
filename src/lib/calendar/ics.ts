/**
 * iCalendar (RFC 5545) in and out.
 *
 * `buildIcsCalendar` writes the text by hand: a VEVENT is small, and writing it
 * here keeps the exact property set under our control. `parseIcs` uses
 * `ical.js` for the grammar but does its own time conversion, because leaning
 * on the ical.js zone registry would make a TZID we never registered fall back
 * to the *server* local zone. Wall clock plus TZID is converted through
 * `src/lib/calendar/zones.ts` instead.
 *
 * Known limit: a TZID is emitted without a matching VTIMEZONE component. Every
 * client we care about resolves IANA names itself; strict validators will warn.
 */
import ICAL from "ical.js";
import { normalizeRrule } from "./recurrence";
import {
	DEFAULT_TIMEZONE,
	getWallClock,
	isValidTimeZone,
	normalizeTimeZone,
	wallClockToUtc,
} from "./zones";

export const ICS_PRODUCT_ID = "-//Mailflare//Calendar//EN";

export type IcsMethod = "PUBLISH" | "REQUEST" | "CANCEL";

export type IcsEvent = {
	uid: string;
	title: string;
	description?: string | null;
	location?: string | null;
	startsAt: Date;
	endsAt: Date;
	allDay?: boolean | null;
	timezone?: string | null;
	rrule?: string | null;
	attendees?: string[];
	organizer?: string | null;
	sequence?: number | null;
};

export type ParsedIcsEvent = {
	uid: string | null;
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	allDay: boolean;
	timezone: string;
	rrule: string | null;
	attendees: string[];
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

/** TEXT value escaping: backslash, semicolon, comma and newlines. */
export function escapeIcsText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r\n|\r|\n/g, "\\n");
}

/** Content lines fold at 75 octets; continuations start with one space. */
function foldLine(line: string): string[] {
	if (line.length <= 75) return [line];
	const out: string[] = [line.slice(0, 75)];
	let rest = line.slice(75);
	while (rest.length > 74) {
		out.push(` ${rest.slice(0, 74)}`);
		rest = rest.slice(74);
	}
	if (rest.length) out.push(` ${rest}`);
	return out;
}

function formatUtcStamp(date: Date): string {
	const wall = getWallClock(date, DEFAULT_TIMEZONE);
	return `${wall.year}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}Z`;
}

function formatDateValue(date: Date): string {
	const wall = getWallClock(date, DEFAULT_TIMEZONE);
	return `${wall.year}${pad(wall.month)}${pad(wall.day)}`;
}

function formatLocalValue(date: Date, timeZone: string): string {
	const wall = getWallClock(date, timeZone);
	return `${wall.year}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}`;
}

/** DTSTART / DTEND for one event, already zone-aware. */
function timeProperty(name: "DTSTART" | "DTEND", date: Date, event: IcsEvent): string {
	if (event.allDay) return `${name};VALUE=DATE:${formatDateValue(date)}`;
	const zone = normalizeTimeZone(event.timezone);
	if (zone === DEFAULT_TIMEZONE) return `${name}:${formatUtcStamp(date)}`;
	return `${name};TZID=${zone}:${formatLocalValue(date, zone)}`;
}

/**
 * DTEND is exclusive for an all-day event, so it must land at least one day
 * after DTSTART however the row happens to be stored.
 */
function allDayEnd(event: IcsEvent): Date {
	const startDay = Math.floor(event.startsAt.getTime() / DAY_MS) * DAY_MS;
	const endDay = Math.ceil(event.endsAt.getTime() / DAY_MS) * DAY_MS;
	return new Date(Math.max(endDay, startDay + DAY_MS));
}

function eventLines(event: IcsEvent, stamp: Date): string[] {
	const lines = [
		"BEGIN:VEVENT",
		`UID:${escapeIcsText(event.uid)}`,
		`DTSTAMP:${formatUtcStamp(stamp)}`,
		timeProperty("DTSTART", event.startsAt, event),
		timeProperty("DTEND", event.allDay ? allDayEnd(event) : event.endsAt, event),
		`SUMMARY:${escapeIcsText(event.title ?? "")}`,
		`DESCRIPTION:${escapeIcsText(event.description ?? "")}`,
		`LOCATION:${escapeIcsText(event.location ?? "")}`,
	];
	if (typeof event.sequence === "number") lines.push(`SEQUENCE:${Math.max(0, event.sequence)}`);
	const rule = event.rrule ? normalizeRrule(event.rrule) : "";
	if (rule) lines.push(`RRULE:${rule}`);
	if (event.organizer) lines.push(`ORGANIZER:mailto:${event.organizer}`);
	for (const attendee of event.attendees ?? []) {
		if (!attendee) continue;
		lines.push(
			`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee}`,
		);
	}
	lines.push("END:VEVENT");
	return lines;
}

/** A whole VCALENDAR document, CRLF-joined and folded. */
export function buildIcsCalendar(
	events: IcsEvent[],
	options: { method?: IcsMethod; productId?: string; stamp?: Date } = {},
): string {
	const stamp = options.stamp ?? new Date();
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		`PRODID:${options.productId ?? ICS_PRODUCT_ID}`,
		"CALSCALE:GREGORIAN",
		`METHOD:${options.method ?? "PUBLISH"}`,
		...events.flatMap((event) => eventLines(event, stamp)),
		"END:VCALENDAR",
	];
	return lines.flatMap(foldLine).join("\r\n");
}

type IcalTimeLike = {
	year: number;
	month: number;
	day: number;
	hour?: number;
	minute?: number;
	second?: number;
	isDate?: boolean;
	zone?: { tzid?: string } | null;
};

type IcalPropertyLike = {
	getFirstValue: () => unknown;
	getParameter: (name: string) => unknown;
};

function parameterString(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return null;
}

/** Reads a DTSTART/DTEND-style property into a real instant. */
function readTime(
	property: IcalPropertyLike | null,
): { date: Date; allDay: boolean; timezone: string } | null {
	if (!property) return null;
	const value = property.getFirstValue() as IcalTimeLike | null;
	if (!value || typeof value.year !== "number") return null;

	if (value.isDate) {
		return {
			date: new Date(Date.UTC(value.year, value.month - 1, value.day)),
			allDay: true,
			timezone: DEFAULT_TIMEZONE,
		};
	}

	const parameterTzid = parameterString(property.getParameter("tzid"));
	const valueTzid = value.zone?.tzid ?? null;
	const candidate = parameterTzid ?? (valueTzid && valueTzid !== "floating" ? valueTzid : null);
	const timezone =
		candidate && candidate !== "Z" && isValidTimeZone(candidate)
			? normalizeTimeZone(candidate)
			: DEFAULT_TIMEZONE;

	return {
		date: wallClockToUtc(
			{
				year: value.year,
				month: value.month,
				day: value.day,
				hour: value.hour ?? 0,
				minute: value.minute ?? 0,
				second: value.second ?? 0,
			},
			timezone,
		),
		allDay: false,
		timezone,
	};
}

function readText(component: ICAL.Component, name: string): string {
	const value = component.getFirstPropertyValue(name);
	return typeof value === "string" ? value : "";
}

function readAttendees(component: ICAL.Component): string[] {
	const out: string[] = [];
	for (const property of component.getAllProperties("attendee")) {
		const raw = property.getFirstValue();
		const text = typeof raw === "string" ? raw : String(raw ?? "");
		const email = text.replace(/^mailto:/i, "").trim();
		if (/^\S+@\S+\.\S+$/.test(email) && !out.includes(email)) out.push(email);
	}
	return out;
}

/**
 * Every VEVENT in an iCalendar document, shaped like a row this app can store.
 *
 * VTODO and VJOURNAL are ignored. So are per-occurrence overrides
 * (`RECURRENCE-ID`): the schema keeps one row per series, so an override has
 * nowhere to live and is dropped rather than quietly replacing the series.
 */
export function parseIcs(text: string): ParsedIcsEvent[] {
	let root: ICAL.Component;
	try {
		root = new ICAL.Component(ICAL.parse(text) as unknown as unknown[]);
	} catch {
		return [];
	}

	const components = root.name === "vevent" ? [root] : root.getAllSubcomponents("vevent");
	const events: ParsedIcsEvent[] = [];

	for (const component of components) {
		if (component.getFirstProperty("recurrence-id")) continue;

		const start = readTime(component.getFirstProperty("dtstart") as unknown as IcalPropertyLike);
		if (!start) continue;

		let end = readTime(component.getFirstProperty("dtend") as unknown as IcalPropertyLike);
		if (!end) {
			const duration = component.getFirstPropertyValue("duration") as {
				toSeconds?: () => number;
			} | null;
			const seconds = duration?.toSeconds?.();
			const fallback =
				typeof seconds === "number" && seconds > 0
					? seconds * 1000
					: start.allDay
						? DAY_MS
						: HOUR_MS;
			end = {
				date: new Date(start.date.getTime() + fallback),
				allDay: start.allDay,
				timezone: start.timezone,
			};
		}
		if (end.date.getTime() <= start.date.getTime()) {
			end = {
				...end,
				date: new Date(start.date.getTime() + (start.allDay ? DAY_MS : HOUR_MS)),
			};
		}

		const rruleValue = component.getFirstPropertyValue("rrule") as
			| { toString: () => string }
			| string
			| null;
		const rrule = rruleValue
			? normalizeRrule(typeof rruleValue === "string" ? rruleValue : rruleValue.toString())
			: "";

		const uid = readText(component, "uid").trim();
		events.push({
			uid: uid || null,
			title: readText(component, "summary").trim() || "(no title)",
			description: readText(component, "description"),
			location: readText(component, "location"),
			startsAt: start.date,
			endsAt: end.date,
			allDay: start.allDay,
			timezone: start.timezone,
			rrule: rrule || null,
			attendees: readAttendees(component),
		});
	}

	return events;
}
