"use client";

import { EventChip } from "./event-chip";
import {
	addDays,
	byStart,
	dayKey,
	dayPosition,
	formatDayTitle,
	groupByDay,
	isSameDay,
	startOfWeek,
	utcDayKey,
} from "./date-utils";
import type { CalendarOccurrence } from "./types";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** Pixel height of one hour row; the grid is 24 of these. */
const HOUR_HEIGHT = 48;

export type WeekViewProps = {
	anchor: Date;
	occurrences: CalendarOccurrence[];
	onSelect: (occurrence: CalendarOccurrence) => void;
	onCreateAt: (day: Date) => void;
};

/** A day-per-column time grid, with all-day events on their own row above it. */
export function WeekView({ anchor, occurrences, onSelect, onCreateAt }: WeekViewProps) {
	const start = startOfWeek(anchor);
	const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
	const buckets = groupByDay(occurrences);
	const today = new Date();

	function itemsFor(day: Date): CalendarOccurrence[] {
		return [...(buckets.get(dayKey(day)) ?? []), ...(buckets.get(utcDayKey(day)) ?? [])]
			.filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index)
			.sort(byStart);
	}

	const hasAllDay = days.some((day) => itemsFor(day).some((item) => item.allDay));

	return (
		<div className="overflow-hidden rounded-xl border border-neutral-200">
			<div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-neutral-200 bg-neutral-50">
				<div className="px-2 py-2 text-[11px] text-neutral-500">Time</div>
				{days.map((day) => (
					<button
						key={day.toISOString()}
						type="button"
						onClick={() => onCreateAt(day)}
						aria-label={`Add an event on ${formatDayTitle(day)}`}
						className="border-l border-neutral-200 px-2 py-2 text-center text-xs font-medium text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
					>
						<span className="block text-[11px] text-neutral-500">
							{day.toLocaleDateString(undefined, { weekday: "short" })}
						</span>
						<span
							className={
								isSameDay(day, today)
									? "mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white"
									: "mt-0.5 inline-block"
							}
						>
							{day.getDate()}
						</span>
					</button>
				))}
			</div>

			{hasAllDay && (
				<div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-neutral-200">
					<div className="px-2 py-1 text-[11px] text-neutral-500">All day</div>
					{days.map((day) => (
						<div key={day.toISOString()} className="space-y-1 border-l border-neutral-200 p-1">
							{itemsFor(day)
								.filter((item) => item.allDay)
								.map((occurrence) => (
									<EventChip key={occurrence.id} occurrence={occurrence} onSelect={onSelect} />
								))}
						</div>
					))}
				</div>
			)}

			<div className="max-h-[70vh] overflow-y-auto">
				<div
					className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]"
					style={{ height: `${HOUR_HEIGHT * 24}px` }}
				>
					<div className="relative">
						{HOURS.map((hour) => (
							<div
								key={hour}
								className="absolute right-1 -translate-y-1/2 text-[11px] text-neutral-500"
								style={{ top: `${(hour / 24) * 100}%` }}
							>
								{hour === 0 ? "" : `${String(hour).padStart(2, "0")}:00`}
							</div>
						))}
					</div>
					{days.map((day) => (
						<div key={day.toISOString()} className="relative border-l border-neutral-200">
							{HOURS.map((hour) => (
								<div
									key={hour}
									aria-hidden
									className="absolute inset-x-0 border-t border-neutral-100"
									style={{ top: `${(hour / 24) * 100}%` }}
								/>
							))}
							{itemsFor(day)
								.filter((item) => !item.allDay)
								.map((occurrence) => {
									const position = dayPosition(occurrence, day);
									return (
										<EventChip
											key={occurrence.id}
											occurrence={occurrence}
											onSelect={onSelect}
											variant="block"
											className="left-0.5 right-0.5 w-auto"
											style={{
												top: `${position.topPercent}%`,
												height: `${position.heightPercent}%`,
											}}
										/>
									);
								})}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
