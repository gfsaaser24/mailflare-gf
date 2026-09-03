"use client";

import { Lock, MapPin, Repeat, Users } from "lucide-react";
import { byStart, colorOf, formatDayTitle, formatTime, isSameDay } from "./date-utils";
import type { CalendarOccurrence } from "./types";

export type AgendaViewProps = {
	occurrences: CalendarOccurrence[];
	onSelect: (occurrence: CalendarOccurrence) => void;
};

/** A flat list grouped by day: the accessible fallback and the quick scan view. */
export function AgendaView({ occurrences, onSelect }: AgendaViewProps) {
	const sorted = [...occurrences].sort(byStart);
	const groups: Array<{ day: Date; items: CalendarOccurrence[] }> = [];

	for (const occurrence of sorted) {
		const day = new Date(occurrence.startsAt);
		const last = groups[groups.length - 1];
		if (last && isSameDay(last.day, day)) last.items.push(occurrence);
		else groups.push({ day, items: [occurrence] });
	}

	if (groups.length === 0) {
		return (
			<p className="rounded-xl border border-neutral-200 p-8 text-center text-sm text-neutral-500">
				Nothing scheduled in this period.
			</p>
		);
	}

	return (
		<div className="overflow-hidden rounded-xl border border-neutral-200">
			{groups.map((group) => (
				<section key={group.day.toDateString()}>
					<h2 className="sticky top-0 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-600">
						{formatDayTitle(group.day)}
					</h2>
					<ul>
						{group.items.map((occurrence) => (
							<li key={occurrence.id} className="border-b border-neutral-100 last:border-b-0">
								<button
									type="button"
									onClick={() => onSelect(occurrence)}
									className="flex w-full items-start gap-4 px-4 py-3 text-left hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
								>
									<span
										aria-hidden
										className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
										style={{ backgroundColor: colorOf(occurrence) }}
									/>
									<span className="w-32 shrink-0 text-sm text-neutral-600">
										{occurrence.allDay
											? "All day"
											: `${formatTime(new Date(occurrence.startsAt))} - ${formatTime(new Date(occurrence.endsAt))}`}
									</span>
									<span className="min-w-0 flex-1">
										<span className="flex items-center gap-2 font-medium text-neutral-900">
											<span className="truncate">{occurrence.title}</span>
											{occurrence.isRecurring && (
												<Repeat aria-label="Repeats" className="h-3.5 w-3.5 text-neutral-400" />
											)}
											{occurrence.readOnly && (
												<Lock aria-label="Read only" className="h-3.5 w-3.5 text-neutral-400" />
											)}
										</span>
										<span className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-neutral-500">
											{occurrence.location && (
												<span className="inline-flex items-center gap-1">
													<MapPin aria-hidden className="h-3 w-3" />
													{occurrence.location}
												</span>
											)}
											{occurrence.attendees.length > 0 && (
												<span className="inline-flex items-center gap-1">
													<Users aria-hidden className="h-3 w-3" />
													{occurrence.attendees.length} guest
													{occurrence.attendees.length === 1 ? "" : "s"}
												</span>
											)}
											{occurrence.ownerName && <span>Shared by {occurrence.ownerName}</span>}
										</span>
									</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
