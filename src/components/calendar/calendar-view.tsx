"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	Download,
	Plus,
	Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { authFetch } from "@/lib/auth/client";
import { AgendaView } from "./agenda-view";
import {
	addDays,
	addMonths,
	formatMonthTitle,
	formatRangeTitle,
	startOfDay,
	viewRange,
} from "./date-utils";
import { EventDialog } from "./event-dialog";
import { MonthView } from "./month-view";
import { WeekView } from "./week-view";
import type { CalendarOccurrence, CalendarScope, CalendarViewMode } from "./types";

const VIEWS: Array<{ id: CalendarViewMode; label: string }> = [
	{ id: "month", label: "Month" },
	{ id: "week", label: "Week" },
	{ id: "agenda", label: "Agenda" },
];

const SCOPES: Array<{ id: CalendarScope; label: string }> = [
	{ id: "mine", label: "Mine" },
	{ id: "organization", label: "Organisation" },
];

/** Refuse an .ics larger than the endpoint accepts before uploading it. */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export function CalendarView() {
	const [view, setView] = useState<CalendarViewMode>("month");
	const [scope, setScope] = useState<CalendarScope>("mine");
	const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
	const [occurrences, setOccurrences] = useState<CalendarOccurrence[]>([]);
	const [message, setMessage] = useState<string | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<CalendarOccurrence | null>(null);
	const [defaultStart, setDefaultStart] = useState<Date | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);
	/** Bumped on every open so the dialog remounts with fresh form state. */
	const [dialogKey, setDialogKey] = useState(0);
	const fileInput = useRef<HTMLInputElement | null>(null);
	const { selectedMailbox } = useSelectedMailbox();

	const range = viewRange(view, anchor);
	const rangeStart = range.start.toISOString();
	const rangeEnd = range.end.toISOString();

	// "Loading" is derived rather than set at the top of the effect: the query
	// the list belongs to is recorded once its response lands.
	const queryKey = `${rangeStart}|${rangeEnd}|${scope}|${refreshKey}`;
	const [loadedKey, setLoadedKey] = useState<string | null>(null);
	const loading = loadedKey !== queryKey;

	useEffect(() => {
		let cancelled = false;
		void authFetch(`/api/calendar/events?start=${rangeStart}&end=${rangeEnd}&scope=${scope}`)
			.then(async (response) => {
				const data = (await response.json().catch(() => ({}))) as {
					occurrences?: CalendarOccurrence[];
					error?: string;
				};
				if (cancelled) return;
				if (!response.ok) {
					setMessage(data.error ?? "Could not load the calendar.");
					setOccurrences([]);
					return;
				}
				setOccurrences(data.occurrences ?? []);
			})
			.finally(() => {
				if (!cancelled) setLoadedKey(queryKey);
			});
		return () => {
			cancelled = true;
		};
	}, [rangeStart, rangeEnd, scope, queryKey]);

	const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

	function step(direction: -1 | 1): void {
		if (view === "month") setAnchor(addMonths(anchor, direction));
		else if (view === "week") setAnchor(addDays(anchor, direction * 7));
		else setAnchor(addDays(anchor, direction * 30));
	}

	function openCreate(day: Date | null): void {
		setEditing(null);
		setDefaultStart(day);
		setDialogKey((key) => key + 1);
		setDialogOpen(true);
	}

	function openEvent(occurrence: CalendarOccurrence): void {
		setEditing(occurrence);
		setDefaultStart(null);
		setDialogKey((key) => key + 1);
		setDialogOpen(true);
	}

	async function importFile(file: File): Promise<void> {
		setMessage(null);
		if (file.size > MAX_IMPORT_BYTES) {
			setMessage("That file is larger than 2 MB.");
			return;
		}
		const text = await file.text();
		const response = await authFetch("/api/calendar/import", {
			method: "POST",
			headers: { "Content-Type": "text/calendar" },
			body: text,
		});
		const data = (await response.json().catch(() => ({}))) as {
			imported?: number;
			updated?: number;
			skipped?: number;
			error?: string;
		};
		if (!response.ok) {
			setMessage(data.error ?? "Could not import that file.");
			return;
		}
		setMessage(
			`Imported ${data.imported ?? 0}, updated ${data.updated ?? 0}, skipped ${data.skipped ?? 0}.`,
		);
		refresh();
	}

	const title =
		view === "month"
			? formatMonthTitle(anchor)
			: formatRangeTitle(range.start, range.end);

	return (
		<div className="mx-auto max-w-6xl p-8">
			<div className="mb-6 flex flex-wrap items-center justify-between gap-4">
				<div>
					<h1 className="flex items-center gap-3 text-2xl font-semibold text-neutral-900">
						<CalendarDays className="h-7 w-7 text-blue-600" />
						Calendar
					</h1>
					<p className="mt-1 text-sm text-neutral-500">
						Your events and the ones your organisation shares.
					</p>
				</div>
				<Button onClick={() => openCreate(null)}>
					<Plus className="h-4 w-4" />
					New event
				</Button>
			</div>

			<div className="mb-4 flex flex-wrap items-center gap-3">
				<div className="flex items-center gap-1">
					<Button variant="outline" size="icon" aria-label="Previous period" onClick={() => step(-1)}>
						<ChevronLeft className="h-4 w-4" />
					</Button>
					<Button variant="outline" size="icon" aria-label="Next period" onClick={() => step(1)}>
						<ChevronRight className="h-4 w-4" />
					</Button>
					<Button variant="outline" size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>
						Today
					</Button>
				</div>

				<h2 className="text-lg font-medium text-neutral-900" aria-live="polite">
					{title}
				</h2>

				<div className="ml-auto flex flex-wrap items-center gap-3">
					<div
						role="group"
						aria-label="Calendar view"
						className="inline-flex rounded-lg border border-neutral-200 p-0.5"
					>
						{VIEWS.map((option) => (
							<button
								key={option.id}
								type="button"
								aria-pressed={view === option.id}
								onClick={() => setView(option.id)}
								className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
									view === option.id
										? "bg-blue-600 text-white"
										: "text-neutral-600 hover:bg-neutral-100"
								}`}
							>
								{option.label}
							</button>
						))}
					</div>

					<div
						role="group"
						aria-label="Whose events to show"
						className="inline-flex rounded-lg border border-neutral-200 p-0.5"
					>
						{SCOPES.map((option) => (
							<button
								key={option.id}
								type="button"
								aria-pressed={scope === option.id}
								onClick={() => setScope(option.id)}
								className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
									scope === option.id
										? "bg-neutral-900 text-white"
										: "text-neutral-600 hover:bg-neutral-100"
								}`}
							>
								{option.label}
							</button>
						))}
					</div>

					<Button variant="outline" size="sm" asChild>
						<a href="/api/calendar/export.ics" download>
							<Download className="h-4 w-4" />
							Export .ics
						</a>
					</Button>

					<Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
						<Upload className="h-4 w-4" />
						Import .ics
					</Button>
					<input
						ref={fileInput}
						type="file"
						accept=".ics,text/calendar"
						className="sr-only"
						aria-label="Import an .ics file"
						onChange={(event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							if (file) void importFile(file);
						}}
					/>
				</div>
			</div>

			{message && (
				<p className="mb-4 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-2 text-sm text-neutral-700">
					{message}
				</p>
			)}

			<div aria-busy={loading}>
				{view === "month" && (
					<MonthView
						anchor={anchor}
						occurrences={occurrences}
						onSelect={openEvent}
						onCreateAt={(day) => openCreate(day)}
					/>
				)}
				{view === "week" && (
					<WeekView
						anchor={anchor}
						occurrences={occurrences}
						onSelect={openEvent}
						onCreateAt={(day) => openCreate(day)}
					/>
				)}
				{view === "agenda" && <AgendaView occurrences={occurrences} onSelect={openEvent} />}
			</div>

			<EventDialog
				key={dialogKey}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				occurrence={editing}
				defaultStart={defaultStart}
				mailbox={selectedMailbox}
				onSaved={refresh}
			/>
		</div>
	);
}
