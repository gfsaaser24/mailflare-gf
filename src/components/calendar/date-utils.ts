/**
 * Grid maths and formatting for the calendar views.
 *
 * Timed events are placed on the *browser* calendar: an instant belongs to the
 * day the reader sees it on. All-day events are the exception — they are stored
 * as UTC midnights and must stay on the same date in every zone, so they are
 * read with the UTC parts.
 */
import type { CalendarOccurrence, CalendarViewMode } from "./types";

export const DAY_MS = 86_400_000;
/** Weeks run Monday to Sunday. */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Chip colours. Kept to the palette the rest of the app already uses. */
export const EVENT_COLORS: Array<{ name: string; value: string }> = [
	{ name: "Blue", value: "#2563eb" },
	{ name: "Cyan", value: "#0891b2" },
	{ name: "Green", value: "#059669" },
	{ name: "Amber", value: "#ca8a04" },
	{ name: "Red", value: "#dc2626" },
	{ name: "Violet", value: "#7c3aed" },
	{ name: "Pink", value: "#db2777" },
	{ name: "Slate", value: "#475569" },
];

export const DEFAULT_EVENT_COLOR = "#2563eb";

export function startOfDay(date: Date): Date {
	const copy = new Date(date);
	copy.setHours(0, 0, 0, 0);
	return copy;
}

export function addDays(date: Date, days: number): Date {
	const copy = new Date(date);
	copy.setDate(copy.getDate() + days);
	return copy;
}

export function addMonths(date: Date, months: number): Date {
	const copy = new Date(date.getFullYear(), date.getMonth() + months, 1);
	return copy;
}

/** The Monday on or before `date`. */
export function startOfWeek(date: Date): Date {
	const copy = startOfDay(date);
	const weekday = (copy.getDay() + 6) % 7;
	return addDays(copy, -weekday);
}

/** The 42 days a month grid shows, starting on a Monday. */
export function monthGridDays(anchor: Date): Date[] {
	const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
	const start = startOfWeek(first);
	return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
	);
}

/** `YYYY-MM-DD` in the browser zone. */
export function dayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** `YYYY-MM-DD` from the UTC parts, for all-day events. */
export function utcDayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** The window a view asks the API for. Never wider than the 93-day cap. */
export function viewRange(view: CalendarViewMode, anchor: Date): { start: Date; end: Date } {
	if (view === "month") {
		const days = monthGridDays(anchor);
		return { start: days[0], end: addDays(days[days.length - 1], 1) };
	}
	if (view === "week") {
		const start = startOfWeek(anchor);
		return { start, end: addDays(start, 7) };
	}
	const start = startOfDay(anchor);
	return { start, end: addDays(start, 30) };
}

/** Every day key an occurrence should appear under. */
export function occurrenceDayKeys(occurrence: CalendarOccurrence): string[] {
	const start = new Date(occurrence.startsAt);
	const end = new Date(occurrence.endsAt);

	if (occurrence.allDay) {
		const keys: string[] = [];
		let cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
		// DTEND is exclusive, but a same-day event must still show once.
		const last = Math.max(end.getTime() - 1, cursor);
		while (cursor <= last && keys.length < 400) {
			keys.push(utcDayKey(new Date(cursor)));
			cursor += DAY_MS;
		}
		return keys;
	}

	const keys: string[] = [];
	let cursor = startOfDay(start);
	const lastDay = startOfDay(new Date(Math.max(end.getTime() - 1, start.getTime())));
	while (cursor.getTime() <= lastDay.getTime() && keys.length < 400) {
		keys.push(dayKey(cursor));
		cursor = addDays(cursor, 1);
	}
	return keys;
}

/** Occurrences bucketed by the day they show on. */
export function groupByDay(occurrences: CalendarOccurrence[]): Map<string, CalendarOccurrence[]> {
	const map = new Map<string, CalendarOccurrence[]>();
	for (const occurrence of occurrences) {
		for (const key of occurrenceDayKeys(occurrence)) {
			const bucket = map.get(key);
			if (bucket) bucket.push(occurrence);
			else map.set(key, [occurrence]);
		}
	}
	return map;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const monthTitleFormatter = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const dayTitleFormatter = new Intl.DateTimeFormat(undefined, {
	weekday: "long",
	day: "numeric",
	month: "long",
});
const shortDayFormatter = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

export function formatTime(date: Date): string {
	return timeFormatter.format(date);
}

export function formatMonthTitle(date: Date): string {
	return monthTitleFormatter.format(date);
}

export function formatDayTitle(date: Date): string {
	return dayTitleFormatter.format(date);
}

export function formatRangeTitle(start: Date, end: Date): string {
	return `${shortDayFormatter.format(start)} - ${shortDayFormatter.format(addDays(end, -1))}`;
}

/** Where a timed occurrence sits inside one day column, as percentages. */
export function dayPosition(
	occurrence: CalendarOccurrence,
	day: Date,
): { topPercent: number; heightPercent: number } {
	const dayStart = startOfDay(day).getTime();
	const dayEnd = dayStart + DAY_MS;
	const start = Math.max(new Date(occurrence.startsAt).getTime(), dayStart);
	const end = Math.min(Math.max(new Date(occurrence.endsAt).getTime(), start + 15 * 60_000), dayEnd);
	return {
		topPercent: ((start - dayStart) / DAY_MS) * 100,
		heightPercent: Math.max(((end - start) / DAY_MS) * 100, 2),
	};
}

/** `#rrggbb` plus an alpha suffix, for chip backgrounds. */
export function withAlpha(color: string, alpha: string): string {
	return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alpha}` : `${DEFAULT_EVENT_COLOR}${alpha}`;
}

export function colorOf(occurrence: CalendarOccurrence): string {
	return occurrence.color && /^#[0-9a-fA-F]{6}$/.test(occurrence.color)
		? occurrence.color
		: DEFAULT_EVENT_COLOR;
}

/** Same-instant sort, so every view lists a day in clock order. */
export function byStart(a: CalendarOccurrence, b: CalendarOccurrence): number {
	if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
	return a.startsAt.localeCompare(b.startsAt);
}
