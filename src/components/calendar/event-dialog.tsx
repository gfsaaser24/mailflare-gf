"use client";

import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import type { MailboxOption } from "@/components/mailbox-provider";
import { authFetch } from "@/lib/auth/client";
import { getWallClock, wallClockToUtc } from "@/lib/calendar/zones";
import { DAY_MS, DEFAULT_EVENT_COLOR, EVENT_COLORS } from "./date-utils";
import type { CalendarOccurrence } from "./types";

const REPEAT_PRESETS = [
	{ id: "none", label: "Does not repeat", rule: "" },
	{ id: "daily", label: "Daily", rule: "FREQ=DAILY" },
	{ id: "weekly", label: "Weekly", rule: "FREQ=WEEKLY" },
	{ id: "monthly", label: "Monthly", rule: "FREQ=MONTHLY" },
	{ id: "yearly", label: "Yearly", rule: "FREQ=YEARLY" },
	{ id: "custom", label: "Custom rule", rule: "" },
] as const;

type RepeatPresetId = (typeof REPEAT_PRESETS)[number]["id"];

export const SERIES_ONLY_HINT =
	"A repeating event is edited and deleted as one series. Single occurrences cannot be changed on their own.";

function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** Every zone the browser knows, with UTC and `current` guaranteed present. */
function timeZoneOptions(current: string): string[] {
	const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
		.supportedValuesOf;
	let zones: string[] = [];
	if (typeof supported === "function") {
		try {
			zones = supported("timeZone");
		} catch {
			zones = [];
		}
	}
	const set = new Set(["UTC", current, browserTimeZone(), ...zones].filter(Boolean));
	return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** `YYYY-MM-DDTHH:mm` as the wall clock of `timeZone`. */
function toDateTimeInput(date: Date, timeZone: string): string {
	const wall = getWallClock(date, timeZone);
	return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

function fromDateTimeInput(value: string, timeZone: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
	if (!match) return null;
	return wallClockToUtc(
		{
			year: Number(match[1]),
			month: Number(match[2]),
			day: Number(match[3]),
			hour: Number(match[4]),
			minute: Number(match[5]),
			second: 0,
		},
		timeZone,
	);
}

/** All-day rows are UTC midnights, so the date input reads the UTC parts. */
function toDateInput(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function fromDateInput(value: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function presetFor(rule: string | null): RepeatPresetId {
	if (!rule) return "none";
	const found = REPEAT_PRESETS.find((preset) => preset.rule && preset.rule === rule.toUpperCase());
	return found ? found.id : "custom";
}

export type EventDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The occurrence being edited, or null when creating. */
	occurrence: CalendarOccurrence | null;
	/** Pre-filled start for a new event. */
	defaultStart: Date | null;
	mailbox: MailboxOption | null;
	onSaved: () => void;
};

type FormState = {
	title: string;
	allDay: boolean;
	timezone: string;
	startValue: string;
	endValue: string;
	location: string;
	description: string;
	attendees: string;
	color: string;
	visibility: "private" | "organization";
	repeat: RepeatPresetId;
	customRule: string;
	sendInvites: boolean;
};

/**
 * The form values the dialog opens with. The parent remounts this component on
 * every open (it passes a changing `key`), so this runs once per open and no
 * effect is needed to keep the fields in step with the props.
 */
function initialForm(occurrence: CalendarOccurrence | null, defaultStart: Date | null): FormState {
	if (occurrence) {
		// A series is edited as a whole, so the form loads the series head.
		const start = new Date(occurrence.seriesStartsAt);
		const end = new Date(occurrence.seriesEndsAt);
		const zone = occurrence.timezone || browserTimeZone();
		return {
			title: occurrence.title,
			allDay: occurrence.allDay,
			timezone: zone,
			startValue: occurrence.allDay ? toDateInput(start) : toDateTimeInput(start, zone),
			endValue: occurrence.allDay
				? // DTEND is exclusive; the picker shows the last day of the event.
					toDateInput(new Date(Math.max(end.getTime() - DAY_MS, start.getTime())))
				: toDateTimeInput(end, zone),
			location: occurrence.location,
			description: occurrence.description,
			attendees: occurrence.attendees.join(", "),
			color: occurrence.color ?? DEFAULT_EVENT_COLOR,
			visibility: occurrence.visibility,
			repeat: presetFor(occurrence.rrule),
			customRule: occurrence.rrule ?? "",
			// An edit does not re-mail the guests unless the user asks for it.
			sendInvites: false,
		};
	}

	const zone = browserTimeZone();
	const start = defaultStart ? new Date(defaultStart) : new Date();
	if (!defaultStart) start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0);
	else start.setHours(9, 0, 0, 0);
	const end = new Date(start.getTime() + 60 * 60_000);
	return {
		title: "",
		allDay: false,
		timezone: zone,
		startValue: toDateTimeInput(start, zone),
		endValue: toDateTimeInput(end, zone),
		location: "",
		description: "",
		attendees: "",
		color: DEFAULT_EVENT_COLOR,
		visibility: "private",
		repeat: "none",
		customRule: "",
		sendInvites: true,
	};
}

export function EventDialog({
	open,
	onOpenChange,
	occurrence,
	defaultStart,
	mailbox,
	onSaved,
}: EventDialogProps) {
	const [form] = useState<FormState>(() => initialForm(occurrence, defaultStart));
	const [title, setTitle] = useState(form.title);
	const [allDay, setAllDay] = useState(form.allDay);
	const [timezone, setTimezone] = useState(form.timezone);
	const [startValue, setStartValue] = useState(form.startValue);
	const [endValue, setEndValue] = useState(form.endValue);
	const [location, setLocation] = useState(form.location);
	const [description, setDescription] = useState(form.description);
	const [attendees, setAttendees] = useState(form.attendees);
	const [color, setColor] = useState(form.color);
	const [visibility, setVisibility] = useState(form.visibility);
	const [repeat, setRepeat] = useState<RepeatPresetId>(form.repeat);
	const [customRule, setCustomRule] = useState(form.customRule);
	const [sendInvites, setSendInvites] = useState(form.sendInvites);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<"save" | "delete" | null>(null);

	const readOnly = !!occurrence?.readOnly;
	const zones = useMemo(() => timeZoneOptions(timezone), [timezone]);

	/** Switching the all-day flag re-formats whatever is already in the fields. */
	function toggleAllDay(next: boolean): void {
		if (next) {
			// Timed to all-day: keep the calendar dates the picker is showing.
			const start = fromDateTimeInput(startValue, timezone) ?? new Date();
			const end = fromDateTimeInput(endValue, timezone) ?? start;
			const startWall = getWallClock(start, timezone);
			const endWall = getWallClock(end, timezone);
			setStartValue(`${startWall.year}-${pad(startWall.month)}-${pad(startWall.day)}`);
			setEndValue(`${endWall.year}-${pad(endWall.month)}-${pad(endWall.day)}`);
		} else {
			// All-day to timed: same date, a one-hour slot at 09:00 in the zone.
			const start = fromDateInput(startValue) ?? new Date();
			const startAt = wallClockToUtc(
				{
					year: start.getUTCFullYear(),
					month: start.getUTCMonth() + 1,
					day: start.getUTCDate(),
					hour: 9,
					minute: 0,
					second: 0,
				},
				timezone,
			);
			setStartValue(toDateTimeInput(startAt, timezone));
			setEndValue(toDateTimeInput(new Date(startAt.getTime() + 60 * 60_000), timezone));
		}
		setAllDay(next);
	}

	function resolveTimes(): { startsAt: Date; endsAt: Date } | null {
		if (allDay) {
			const start = fromDateInput(startValue);
			const inclusiveEnd = fromDateInput(endValue) ?? start;
			if (!start || !inclusiveEnd) return null;
			// DTEND is exclusive, so a one-day event ends the next midnight.
			const end = new Date(Math.max(inclusiveEnd.getTime(), start.getTime()) + DAY_MS);
			return { startsAt: start, endsAt: end };
		}
		const start = fromDateTimeInput(startValue, timezone);
		const end = fromDateTimeInput(endValue, timezone);
		if (!start || !end || end.getTime() <= start.getTime()) return null;
		return { startsAt: start, endsAt: end };
	}

	function resolveRule(): string | null {
		if (repeat === "none") return null;
		if (repeat === "custom") return customRule.trim() || null;
		return REPEAT_PRESETS.find((preset) => preset.id === repeat)?.rule || null;
	}

	async function save(): Promise<void> {
		if (readOnly) return;
		const times = resolveTimes();
		if (!title.trim() || !times) {
			setError("Enter a title and valid event times.");
			return;
		}

		setPending("save");
		setError(null);
		try {
			const guests = attendees
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			const body = {
				title: title.trim(),
				description,
				location,
				attendees: guests,
				startsAt: times.startsAt.toISOString(),
				endsAt: times.endsAt.toISOString(),
				allDay,
				timezone: allDay ? "UTC" : timezone,
				rrule: resolveRule(),
				visibility,
				color,
				mailboxId: mailbox?.id ?? null,
				from:
					mailbox?.senderAddresses?.[0] ??
					(mailbox ? `${mailbox.localPart}@${mailbox.hostname}` : ""),
				sendInvites: sendInvites && guests.length > 0 && !!mailbox,
			};

			const response = await authFetch(
				occurrence
					? `/api/calendar/events/${occurrence.eventId}?scope=all`
					: "/api/calendar/events",
				{
					method: occurrence ? "PATCH" : "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
			);
			if (!response.ok) {
				const data = (await response.json().catch(() => ({}))) as { error?: string };
				setError(data.error ?? "Could not save the event.");
				return;
			}
			onSaved();
			onOpenChange(false);
		} finally {
			setPending(null);
		}
	}

	async function remove(): Promise<void> {
		if (!occurrence || readOnly) return;
		const question = occurrence.isRecurring
			? "Delete the whole repeating series?"
			: "Delete this event?";
		if (!window.confirm(question)) return;

		setPending("delete");
		setError(null);
		try {
			const response = await authFetch(
				`/api/calendar/events/${occurrence.eventId}?scope=all`,
				{ method: "DELETE" },
			);
			if (!response.ok) {
				const data = (await response.json().catch(() => ({}))) as { error?: string };
				setError(data.error ?? "Could not delete the event.");
				return;
			}
			onSaved();
			onOpenChange(false);
		} finally {
			setPending(null);
		}
	}

	const senderAddress =
		mailbox?.senderAddresses?.[0] ??
		(mailbox ? `${mailbox.localPart}@${mailbox.hostname}` : null);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] w-[min(640px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{occurrence ? (readOnly ? "Event details" : "Edit event") : "Create event"}
					</DialogTitle>
					<DialogDescription>
						{readOnly
							? `Shared by ${occurrence?.ownerName ?? "a colleague"}. You can read this event but not change it.`
							: "Times are saved in the time zone you pick below."}
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-4">
					<div className="grid gap-1.5">
						<Label htmlFor="calendar-title">Title</Label>
						<Input
							id="calendar-title"
							value={title}
							disabled={readOnly}
							onChange={(event) => setTitle(event.target.value)}
							placeholder="Event title"
						/>
					</div>

					<div className="flex items-center gap-3">
						<Switch
							checked={allDay}
							disabled={readOnly}
							onCheckedChange={toggleAllDay}
							aria-label="All day"
							id="calendar-all-day"
						/>
						<Label htmlFor="calendar-all-day">All day</Label>
					</div>

					<div className="grid gap-3 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<Label htmlFor="calendar-start">Starts</Label>
							<Input
								id="calendar-start"
								type={allDay ? "date" : "datetime-local"}
								value={startValue}
								disabled={readOnly}
								onChange={(event) => setStartValue(event.target.value)}
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="calendar-end">{allDay ? "Ends (last day)" : "Ends"}</Label>
							<Input
								id="calendar-end"
								type={allDay ? "date" : "datetime-local"}
								value={endValue}
								disabled={readOnly}
								onChange={(event) => setEndValue(event.target.value)}
							/>
						</div>
					</div>

					{!allDay && (
						<div className="grid gap-1.5">
							<Label htmlFor="calendar-timezone">Time zone</Label>
							<Select
								id="calendar-timezone"
								className="h-10"
								value={timezone}
								disabled={readOnly}
								onChange={(event) => setTimezone(event.target.value)}
							>
								{zones.map((zone) => (
									<option key={zone} value={zone}>
										{zone}
									</option>
								))}
							</Select>
						</div>
					)}

					<div className="grid gap-1.5">
						<Label htmlFor="calendar-location">Location</Label>
						<Input
							id="calendar-location"
							value={location}
							disabled={readOnly}
							onChange={(event) => setLocation(event.target.value)}
							placeholder="Room, address or link"
						/>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor="calendar-description">Description</Label>
						<Textarea
							id="calendar-description"
							value={description}
							disabled={readOnly}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor="calendar-guests">Guests</Label>
						<Input
							id="calendar-guests"
							value={attendees}
							disabled={readOnly}
							onChange={(event) => setAttendees(event.target.value)}
							placeholder="Comma-separated email addresses"
						/>
					</div>

					<div className="grid gap-3 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<span className="text-sm font-medium leading-none">Colour</span>
							<div className="flex flex-wrap gap-2" role="group" aria-label="Event colour">
								{EVENT_COLORS.map((swatch) => (
									<button
										key={swatch.value}
										type="button"
										disabled={readOnly}
										aria-label={swatch.name}
										aria-pressed={color === swatch.value}
										onClick={() => setColor(swatch.value)}
										className={`h-7 w-7 rounded-full border-2 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:opacity-50 ${
											color === swatch.value ? "border-neutral-900 scale-110" : "border-transparent"
										}`}
										style={{ backgroundColor: swatch.value }}
									/>
								))}
							</div>
						</div>

						<div className="grid gap-1.5">
							<Label htmlFor="calendar-visibility">Visibility</Label>
							<Select
								id="calendar-visibility"
								className="h-10"
								value={visibility}
								disabled={readOnly}
								onChange={(event) =>
									setVisibility(event.target.value === "organization" ? "organization" : "private")
								}
							>
								<option value="private">Private</option>
								<option value="organization">Organisation</option>
							</Select>
						</div>
					</div>

					<div className="grid gap-1.5">
						<div className="flex items-center gap-2">
							<Label htmlFor="calendar-repeat">Repeat</Label>
							<Tooltip label={SERIES_ONLY_HINT}>
								<span
									tabIndex={0}
									aria-label={SERIES_ONLY_HINT}
									className="flex h-4 w-4 items-center justify-center rounded-full border border-neutral-300 text-[10px] text-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
								>
									i
								</span>
							</Tooltip>
						</div>
						<Select
							id="calendar-repeat"
							className="h-10"
							value={repeat}
							disabled={readOnly}
							onChange={(event) => setRepeat(event.target.value as RepeatPresetId)}
						>
							{REPEAT_PRESETS.map((preset) => (
								<option key={preset.id} value={preset.id}>
									{preset.label}
								</option>
							))}
						</Select>
						{repeat === "custom" && (
							<Input
								aria-label="Custom RRULE"
								value={customRule}
								disabled={readOnly}
								onChange={(event) => setCustomRule(event.target.value)}
								placeholder="FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"
							/>
						)}
					</div>

					{!readOnly && (
						<div className="flex items-start gap-2">
							<Checkbox
								id="calendar-send-invites"
								className="mt-1"
								checked={sendInvites}
								disabled={!mailbox}
								onChange={(event) => setSendInvites(event.target.checked)}
							/>
							<Label htmlFor="calendar-send-invites" className="leading-snug">
								Email an invitation to the guests
								<span className="mt-0.5 block text-xs font-normal text-neutral-500">
									{senderAddress ? `Sent from ${senderAddress}` : "Pick a mailbox to send invitations"}
								</span>
							</Label>
						</div>
					)}

					{error && <p className="text-sm text-red-600">{error}</p>}

					<div className="flex items-center justify-between gap-2 pt-2">
						{occurrence && !readOnly ? (
							<Button
								variant="ghost"
								disabled={pending !== null}
								onClick={() => void remove()}
								className="text-red-600 hover:bg-red-50"
							>
								<Trash2 className="h-4 w-4" />
								{pending === "delete" ? "Deleting..." : "Delete"}
							</Button>
						) : (
							<span />
						)}
						<div className="flex gap-2">
							<Button variant="ghost" disabled={pending !== null} onClick={() => onOpenChange(false)}>
								{readOnly ? "Close" : "Cancel"}
							</Button>
							{!readOnly && (
								<Button disabled={pending !== null} onClick={() => void save()}>
									{pending === "save" ? "Saving..." : occurrence ? "Save changes" : "Create event"}
								</Button>
							)}
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
