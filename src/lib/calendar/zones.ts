/**
 * Time-zone helpers for the calendar.
 *
 * Everything in the database is a real instant (`timestamptz`). A calendar
 * still has to think in *wall clock* terms — "every Monday at 09:00 in
 * Europe/London" keeps saying 09:00 across a DST change — so recurrence and ICS
 * both need to move between an instant and the wall clock of a zone.
 *
 * `Intl.DateTimeFormat` is the only zone database available to us, so both
 * directions go through it. No extra dependency.
 */

export const DEFAULT_TIMEZONE = "UTC";

/** Calendar fields of a clock face. `month` is 1-12, like ICS. */
export type WallClock = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, formatter);
	}
	return formatter;
}

let supportedZones: Set<string> | null | undefined;

function knownZones(): Set<string> | null {
	if (supportedZones !== undefined) return supportedZones;
	const supportedValuesOf = (
		Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
	).supportedValuesOf;
	supportedZones = null;
	if (typeof supportedValuesOf === "function") {
		try {
			supportedZones = new Set(supportedValuesOf("timeZone").map((zone) => zone.toLowerCase()));
		} catch {
			supportedZones = null;
		}
	}
	return supportedZones;
}

/**
 * True when the runtime can resolve `timeZone` as an IANA zone.
 *
 * `Intl.supportedValuesOf` is preferred; where it is missing we fall back to
 * asking `Intl.DateTimeFormat` (which throws on an unknown zone) and, last of
 * all, to the shape of an IANA name.
 */
export function isValidTimeZone(timeZone: string): boolean {
	if (!timeZone || timeZone.length > 100) return false;
	if (timeZone.toUpperCase() === "UTC") return true;
	const zones = knownZones();
	if (zones) return zones.has(timeZone.toLowerCase());
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(timeZone);
	}
}

/** `timeZone` when the runtime knows it, otherwise UTC. Never throws. */
export function normalizeTimeZone(timeZone: string | null | undefined): string {
	if (!timeZone) return DEFAULT_TIMEZONE;
	const trimmed = timeZone.trim();
	if (!trimmed) return DEFAULT_TIMEZONE;
	if (trimmed.toUpperCase() === "UTC") return DEFAULT_TIMEZONE;
	return isValidTimeZone(trimmed) ? trimmed : DEFAULT_TIMEZONE;
}

/** The clock face an instant shows in `timeZone`. */
export function getWallClock(date: Date, timeZone: string): WallClock {
	const parts = wallFormatter(normalizeTimeZone(timeZone)).formatToParts(date);
	const read = (type: Intl.DateTimeFormatPartTypes): number => {
		const part = parts.find((candidate) => candidate.type === type);
		return part ? Number(part.value) : 0;
	};
	// Some engines format midnight as hour 24; ICS never does.
	const hour = read("hour") % 24;
	return {
		year: read("year"),
		month: read("month"),
		day: read("day"),
		hour,
		minute: read("minute"),
		second: read("second"),
	};
}

/** How far `timeZone` is ahead of UTC at `date`, in milliseconds. */
export function getZoneOffsetMs(date: Date, timeZone: string): number {
	const wall = getWallClock(date, timeZone);
	const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
	// Sub-second precision is not carried by the formatter; add it back.
	return asUtc - (date.getTime() - date.getMilliseconds());
}

/**
 * The instant at which `timeZone` shows `wall`.
 *
 * Two passes: guess with the offset at the naive instant, then re-read the
 * offset at the guess. That settles every case except the hour that does not
 * exist on a spring-forward day, where the later of the two readings wins (the
 * same choice ICS clients make).
 */
export function wallClockToUtc(wall: WallClock, timeZone: string): Date {
	const zone = normalizeTimeZone(timeZone);
	const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
	if (zone === DEFAULT_TIMEZONE) return new Date(naive);
	let guess = naive - getZoneOffsetMs(new Date(naive), zone);
	guess = naive - getZoneOffsetMs(new Date(guess), zone);
	return new Date(guess);
}

/**
 * The instant re-labelled as if its wall clock in `timeZone` were UTC.
 *
 * `rrule` has no zone database, so recurrence is expanded in this "floating"
 * space and each result is mapped back with `instantFromFloating`.
 */
export function floatingFromInstant(date: Date, timeZone: string): Date {
	const wall = getWallClock(date, timeZone);
	return new Date(
		Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second),
	);
}

/** The inverse of `floatingFromInstant`. */
export function instantFromFloating(floating: Date, timeZone: string): Date {
	return wallClockToUtc(
		{
			year: floating.getUTCFullYear(),
			month: floating.getUTCMonth() + 1,
			day: floating.getUTCDate(),
			hour: floating.getUTCHours(),
			minute: floating.getUTCMinutes(),
			second: floating.getUTCSeconds(),
		},
		timeZone,
	);
}
