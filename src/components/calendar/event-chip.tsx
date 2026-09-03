"use client";

import { Lock, Repeat, Users } from "lucide-react";
import { colorOf, formatTime, withAlpha } from "./date-utils";
import type { CalendarOccurrence } from "./types";

export type EventChipProps = {
	occurrence: CalendarOccurrence;
	onSelect: (occurrence: CalendarOccurrence) => void;
	/** `block` fills a week-view column; `chip` is the one-line month pill. */
	variant?: "chip" | "block";
	className?: string;
	style?: React.CSSProperties;
};

/**
 * One event, in every view. The colour is the only per-event styling: text
 * stays on the theme foreground so it keeps its contrast in dark mode.
 */
export function EventChip({
	occurrence,
	onSelect,
	variant = "chip",
	className = "",
	style,
}: EventChipProps) {
	const color = colorOf(occurrence);
	const time = occurrence.allDay ? "All day" : formatTime(new Date(occurrence.startsAt));
	const label = `${occurrence.title}, ${time}${occurrence.ownerName ? `, shared by ${occurrence.ownerName}` : ""}`;

	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			onClick={() => onSelect(occurrence)}
			style={{ backgroundColor: withAlpha(color, "24"), borderColor: color, ...style }}
			className={`w-full overflow-hidden rounded-md border-l-[3px] px-1.5 text-left text-neutral-900 transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-neutral-100 ${
				variant === "block" ? "absolute py-1 text-xs" : "py-0.5 text-[11px] leading-tight"
			} ${className}`}
		>
			<span className="flex items-center gap-1 truncate font-medium">
				{occurrence.readOnly && <Lock aria-hidden className="h-3 w-3 shrink-0 opacity-70" />}
				{occurrence.isRecurring && <Repeat aria-hidden className="h-3 w-3 shrink-0 opacity-70" />}
				<span className="truncate">{occurrence.title}</span>
			</span>
			{variant === "block" ? (
				<span className="block truncate text-[10px] text-neutral-600 dark:text-neutral-300">
					{time}
					{occurrence.attendees.length > 0 && (
						<span className="ml-1 inline-flex items-center gap-0.5">
							<Users aria-hidden className="h-3 w-3" />
							{occurrence.attendees.length}
						</span>
					)}
				</span>
			) : (
				!occurrence.allDay && (
					<span className="ml-1 text-[10px] text-neutral-600 dark:text-neutral-300">{time}</span>
				)
			)}
		</button>
	);
}
