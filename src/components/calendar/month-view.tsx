"use client";

import { useState } from "react";
import { EventChip } from "./event-chip";
import {
	WEEKDAY_LABELS,
	byStart,
	dayKey,
	formatDayTitle,
	groupByDay,
	isSameDay,
	monthGridDays,
	utcDayKey,
} from "./date-utils";
import type { CalendarOccurrence } from "./types";

const CHIPS_PER_CELL = 3;

export type MonthViewProps = {
	anchor: Date;
	occurrences: CalendarOccurrence[];
	onSelect: (occurrence: CalendarOccurrence) => void;
	onCreateAt: (day: Date) => void;
};

/** A seven column grid of six weeks, with an overflow toggle per day. */
export function MonthView({ anchor, occurrences, onSelect, onCreateAt }: MonthViewProps) {
	const [expanded, setExpanded] = useState<string | null>(null);
	const days = monthGridDays(anchor);
	const buckets = groupByDay(occurrences);
	const today = new Date();

	return (
		<div className="overflow-hidden rounded-xl border border-neutral-200">
			<div className="grid grid-cols-7 border-b border-neutral-200 bg-neutral-50 text-xs font-medium text-neutral-600">
				{WEEKDAY_LABELS.map((label) => (
					<div key={label} className="px-2 py-2 text-center">
						{label}
					</div>
				))}
			</div>
			<div className="grid grid-cols-7">
				{days.map((day) => {
					const key = dayKey(day);
					// All-day rows are bucketed by their UTC date; look both up.
					const items = [...(buckets.get(key) ?? []), ...(buckets.get(utcDayKey(day)) ?? [])]
						.filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index)
						.sort(byStart);
					const isOtherMonth = day.getMonth() !== anchor.getMonth();
					const isToday = isSameDay(day, today);
					const showAll = expanded === key;
					const visible = showAll ? items : items.slice(0, CHIPS_PER_CELL);
					const hidden = items.length - visible.length;

					return (
						<div
							key={key}
							className={`min-h-28 border-b border-r border-neutral-100 p-1 last:border-r-0 ${
								isOtherMonth ? "bg-neutral-50/60" : ""
							}`}
						>
							<div className="flex items-center justify-between">
								<button
									type="button"
									onClick={() => onCreateAt(day)}
									aria-label={`Add an event on ${formatDayTitle(day)}`}
									className={`h-6 min-w-6 rounded-full px-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
										isToday
											? "bg-blue-600 text-white"
											: isOtherMonth
												? "text-neutral-400 hover:bg-neutral-100"
												: "text-neutral-700 hover:bg-neutral-100"
									}`}
								>
									{day.getDate()}
								</button>
							</div>
							<div className="mt-1 space-y-1">
								{visible.map((occurrence) => (
									<EventChip key={occurrence.id} occurrence={occurrence} onSelect={onSelect} />
								))}
								{hidden > 0 && (
									<button
										type="button"
										onClick={() => setExpanded(key)}
										className="w-full rounded px-1 text-left text-[11px] font-medium text-neutral-600 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
									>
										{`+${hidden} more`}
									</button>
								)}
								{showAll && items.length > CHIPS_PER_CELL && (
									<button
										type="button"
										onClick={() => setExpanded(null)}
										className="w-full rounded px-1 text-left text-[11px] font-medium text-neutral-600 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
									>
										Show less
									</button>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
