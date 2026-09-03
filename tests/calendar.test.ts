/**
 * The calendar: recurrence expansion, ICS round-tripping, and the
 * organisation-visibility filter on the range endpoint.
 *
 * The library half is pure and always runs. The API half needs the test
 * database and is skipped without it, in the style of the other route tests.
 */
import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarEvents, organizations, users } from "@/db/schema";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { buildIcsCalendar, parseIcs } from "@/lib/calendar/ics";
import { expandOccurrences } from "@/lib/calendar/recurrence";
import { getWallClock } from "@/lib/calendar/zones";
import { createDb, hasTestDatabase } from "./helpers/db";

/** Cookie jar backing the mocked `next/headers`. */
const cookieJar = new Map<string, string>();

vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) => {
			const value = cookieJar.get(name);
			return value === undefined ? undefined : { name, value };
		},
	}),
}));

// --------------------------------------------------------------- recurrence

describe("recurrence expansion", () => {
	it("expands a weekly rule once per week across a four week window", () => {
		const occurrences = expandOccurrences(
			{
				eventId: "evt_weekly",
				startsAt: new Date("2026-01-05T09:00:00.000Z"),
				endsAt: new Date("2026-01-05T10:00:00.000Z"),
				rrule: "FREQ=WEEKLY;BYDAY=MO",
				timezone: "UTC",
				allDay: false,
			},
			new Date("2026-01-05T00:00:00.000Z"),
			new Date("2026-02-02T00:00:00.000Z"),
		);

		expect(occurrences).toHaveLength(4);
		expect(occurrences.map((o) => o.occurrenceStart.toISOString())).toEqual([
			"2026-01-05T09:00:00.000Z",
			"2026-01-12T09:00:00.000Z",
			"2026-01-19T09:00:00.000Z",
			"2026-01-26T09:00:00.000Z",
		]);
		expect(occurrences.every((o) => o.isRecurring)).toBe(true);
		expect(occurrences[0].occurrenceEnd.toISOString()).toBe("2026-01-05T10:00:00.000Z");
	});

	it("yields exactly one occurrence for a single event that overlaps the window", () => {
		const inside = expandOccurrences(
			{
				eventId: "evt_single",
				startsAt: new Date("2026-03-10T12:00:00.000Z"),
				endsAt: new Date("2026-03-10T13:00:00.000Z"),
				rrule: null,
				timezone: "UTC",
			},
			new Date("2026-03-01T00:00:00.000Z"),
			new Date("2026-04-01T00:00:00.000Z"),
		);
		expect(inside).toHaveLength(1);
		expect(inside[0].isRecurring).toBe(false);

		const outside = expandOccurrences(
			{
				eventId: "evt_single",
				startsAt: new Date("2026-05-10T12:00:00.000Z"),
				endsAt: new Date("2026-05-10T13:00:00.000Z"),
				rrule: null,
				timezone: "UTC",
			},
			new Date("2026-03-01T00:00:00.000Z"),
			new Date("2026-04-01T00:00:00.000Z"),
		);
		expect(outside).toHaveLength(0);
	});

	it("keeps the local wall clock across a daylight-saving change", () => {
		const occurrences = expandOccurrences(
			{
				eventId: "evt_dst",
				// 09:00 in London, the week before the spring clock change.
				startsAt: new Date("2026-03-23T09:00:00.000Z"),
				endsAt: new Date("2026-03-23T10:00:00.000Z"),
				rrule: "FREQ=WEEKLY;COUNT=3",
				timezone: "Europe/London",
			},
			new Date("2026-03-01T00:00:00.000Z"),
			new Date("2026-04-30T00:00:00.000Z"),
		);

		expect(occurrences).toHaveLength(3);
		for (const occurrence of occurrences) {
			expect(getWallClock(occurrence.occurrenceStart, "Europe/London").hour).toBe(9);
		}
		// After the change London is UTC+1, so the instant moves by an hour.
		expect(occurrences[1].occurrenceStart.toISOString()).toBe("2026-03-30T08:00:00.000Z");
	});

	it("never returns more occurrences than the cap", () => {
		const occurrences = expandOccurrences(
			{
				eventId: "evt_hourly",
				startsAt: new Date("2026-01-01T00:00:00.000Z"),
				endsAt: new Date("2026-01-01T00:30:00.000Z"),
				rrule: "FREQ=HOURLY",
				timezone: "UTC",
			},
			new Date("2026-01-01T00:00:00.000Z"),
			new Date("2026-03-01T00:00:00.000Z"),
			50,
		);
		expect(occurrences).toHaveLength(50);
	});

	it("falls back to the single event when the rule cannot be parsed", () => {
		const occurrences = expandOccurrences(
			{
				eventId: "evt_bad",
				startsAt: new Date("2026-01-05T09:00:00.000Z"),
				endsAt: new Date("2026-01-05T10:00:00.000Z"),
				rrule: "NOT-A-RULE",
				timezone: "UTC",
			},
			new Date("2026-01-01T00:00:00.000Z"),
			new Date("2026-02-01T00:00:00.000Z"),
		);
		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].isRecurring).toBe(false);
	});
});

// ---------------------------------------------------------------------- ICS

describe("ICS build and parse", () => {
	it("round-trips a timed event with a zone, a rule and guests", () => {
		const text = buildIcsCalendar([
			{
				uid: "evt_round_trip",
				title: "Team sync, weekly",
				description: "Line one\nLine two",
				location: "Room 1; upstairs",
				startsAt: new Date("2026-01-05T09:00:00.000Z"),
				endsAt: new Date("2026-01-05T10:00:00.000Z"),
				allDay: false,
				timezone: "Europe/London",
				rrule: "FREQ=WEEKLY;BYDAY=MO",
				attendees: ["guest@example.com", "other@example.com"],
			},
		]);

		expect(text).toContain("BEGIN:VCALENDAR");
		expect(text).toContain("DTSTART;TZID=Europe/London:20260105T090000");
		expect(text).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");

		const [parsed] = parseIcs(text);
		expect(parsed.uid).toBe("evt_round_trip");
		expect(parsed.title).toBe("Team sync, weekly");
		expect(parsed.description).toBe("Line one\nLine two");
		expect(parsed.location).toBe("Room 1; upstairs");
		expect(parsed.startsAt.toISOString()).toBe("2026-01-05T09:00:00.000Z");
		expect(parsed.endsAt.toISOString()).toBe("2026-01-05T10:00:00.000Z");
		expect(parsed.allDay).toBe(false);
		expect(parsed.timezone).toBe("Europe/London");
		expect(parsed.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
		expect(parsed.attendees).toEqual(["guest@example.com", "other@example.com"]);
	});

	it("round-trips an all-day event as a DATE value", () => {
		const text = buildIcsCalendar([
			{
				uid: "evt_all_day",
				title: "Company holiday",
				startsAt: new Date("2026-07-01T00:00:00.000Z"),
				endsAt: new Date("2026-07-02T00:00:00.000Z"),
				allDay: true,
				timezone: "UTC",
			},
		]);

		expect(text).toContain("DTSTART;VALUE=DATE:20260701");
		expect(text).toContain("DTEND;VALUE=DATE:20260702");

		const [parsed] = parseIcs(text);
		expect(parsed.allDay).toBe(true);
		expect(parsed.startsAt.toISOString()).toBe("2026-07-01T00:00:00.000Z");
		expect(parsed.endsAt.toISOString()).toBe("2026-07-02T00:00:00.000Z");
	});

	it("ignores VTODO and VJOURNAL components", () => {
		const text = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//EN",
			"BEGIN:VTODO",
			"UID:todo-1",
			"SUMMARY:Do not import me",
			"DUE:20260101T090000Z",
			"END:VTODO",
			"BEGIN:VJOURNAL",
			"UID:journal-1",
			"SUMMARY:Nor me",
			"DTSTART:20260101T090000Z",
			"END:VJOURNAL",
			"BEGIN:VEVENT",
			"UID:event-1",
			"SUMMARY:Import me",
			"DTSTART:20260101T090000Z",
			"DTEND:20260101T100000Z",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		const parsed = parseIcs(text);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].uid).toBe("event-1");
	});

	it("returns nothing for text that is not a calendar", () => {
		expect(parseIcs("hello there")).toEqual([]);
	});
});

// ---------------------------------------------------------- API (needs a DB)

const ORG = "org_cal_test";
const OWNER = "usr_cal_owner";
const COLLEAGUE = "usr_cal_colleague";
const OWN_EVENT = "evt_cal_own";
const SHARED_EVENT = "evt_cal_shared";
const PRIVATE_EVENT = "evt_cal_private";

const RANGE_START = "2026-06-01T00:00:00.000Z";
const RANGE_END = "2026-06-08T00:00:00.000Z";

async function ensureDefaultOrganization(): Promise<void> {
	try {
		await createDb().execute(
			sql`INSERT INTO organizations (id, name, slug, status, created_at)
			    VALUES ('org_default', 'Default', 'default', 'active', now())
			    ON CONFLICT (id) DO NOTHING`,
		);
	} catch {
		// The organizations table is not part of the schema yet.
	}
}

async function seed(): Promise<void> {
	const db = createDb();

	await db
		.insert(organizations)
		.values({ id: ORG, name: "Calendar org", slug: "calendar-org", status: "active" });

	await db.insert(users).values([
		{ id: OWNER, organizationId: ORG, email: "owner@calendar.test", passwordHash: "x", name: "Owner" },
		{
			id: COLLEAGUE,
			organizationId: ORG,
			email: "colleague@calendar.test",
			passwordHash: "x",
			name: "Colleague",
		},
	]);

	await db.insert(calendarEvents).values([
		{
			id: OWN_EVENT,
			organizationId: ORG,
			userId: OWNER,
			title: "My standup",
			startsAt: new Date("2026-06-01T09:00:00.000Z"),
			endsAt: new Date("2026-06-01T09:15:00.000Z"),
			rrule: "FREQ=DAILY;COUNT=3",
			timezone: "UTC",
			uid: "uid-own",
		},
		{
			id: SHARED_EVENT,
			organizationId: ORG,
			userId: COLLEAGUE,
			title: "All hands",
			startsAt: new Date("2026-06-02T14:00:00.000Z"),
			endsAt: new Date("2026-06-02T15:00:00.000Z"),
			visibility: "organization",
			timezone: "UTC",
			uid: "uid-shared",
		},
		{
			id: PRIVATE_EVENT,
			organizationId: ORG,
			userId: COLLEAGUE,
			title: "Dentist",
			startsAt: new Date("2026-06-03T08:00:00.000Z"),
			endsAt: new Date("2026-06-03T09:00:00.000Z"),
			visibility: "private",
			timezone: "UTC",
			uid: "uid-private",
		},
	]);
}

type OccurrenceResponse = {
	occurrences: Array<{
		eventId: string;
		startsAt: string;
		readOnly: boolean;
		ownerName: string | null;
		isRecurring: boolean;
	}>;
};

describe.skipIf(!hasTestDatabase())("calendar range API", () => {
	beforeAll(() => {
		// The routes reach the database through `getEnv()`, which reads
		// DATABASE_URL; point it at the test database.
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		// `getEnv()` refuses a half-configured mail transport; nothing here sends.
		if (!!process.env.EDGE_WORKER_URL !== !!process.env.EDGE_WORKER_SECRET) {
			delete process.env.EDGE_WORKER_URL;
			delete process.env.EDGE_WORKER_SECRET;
		}
	});

	beforeEach(async () => {
		await ensureDefaultOrganization();
		cookieJar.clear();
		await seed();
	});

	async function signIn(userId: string): Promise<void> {
		const token = await createSession({ DB: createDb() } as unknown as CloudflareEnv, userId);
		cookieJar.set(SESSION_COOKIE, token);
	}

	function get(url: string): Request {
		return new Request(`http://localhost${url}`, { method: "GET" });
	}

	const routeCtx = () => ({ params: Promise.resolve({}) });

	it("expands the caller own series and hides other people events by default", async () => {
		const { GET } = await import("@/app/api/calendar/events/route");
		await signIn(OWNER);

		const response = await GET(
			get(`/api/calendar/events?start=${RANGE_START}&end=${RANGE_END}`),
			routeCtx(),
		);
		expect(response.status).toBe(200);

		const data = (await response.json()) as OccurrenceResponse;
		expect(data.occurrences).toHaveLength(3);
		expect(new Set(data.occurrences.map((o) => o.eventId))).toEqual(new Set([OWN_EVENT]));
		expect(data.occurrences.every((o) => o.isRecurring)).toBe(true);
	});

	it("adds organisation-visible events from other members, read-only", async () => {
		const { GET } = await import("@/app/api/calendar/events/route");
		await signIn(OWNER);

		const response = await GET(
			get(`/api/calendar/events?start=${RANGE_START}&end=${RANGE_END}&scope=organization`),
			routeCtx(),
		);
		const data = (await response.json()) as OccurrenceResponse;

		const ids = data.occurrences.map((o) => o.eventId);
		expect(ids).toContain(SHARED_EVENT);
		expect(ids).not.toContain(PRIVATE_EVENT);

		const shared = data.occurrences.find((o) => o.eventId === SHARED_EVENT);
		expect(shared?.readOnly).toBe(true);
		expect(shared?.ownerName).toBe("Colleague");
		expect(data.occurrences.find((o) => o.eventId === OWN_EVENT)?.readOnly).toBe(false);

		// Sorted by start time.
		const starts = data.occurrences.map((o) => o.startsAt);
		expect([...starts].sort()).toEqual(starts);
	});

	it("rejects a window longer than the cap", async () => {
		const { GET } = await import("@/app/api/calendar/events/route");
		await signIn(OWNER);

		const response = await GET(
			get("/api/calendar/events?start=2026-01-01T00:00:00.000Z&end=2026-12-31T00:00:00.000Z"),
			routeCtx(),
		);
		expect(response.status).toBe(400);
	});

	it("refuses to edit a single occurrence of a series", async () => {
		const { PATCH } = await import("@/app/api/calendar/events/[eventId]/route");
		await signIn(OWNER);

		const response = await PATCH(
			new Request(`http://localhost/api/calendar/events/${OWN_EVENT}?scope=this`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Renamed",
					startsAt: "2026-06-01T09:00:00.000Z",
					endsAt: "2026-06-01T09:15:00.000Z",
					rrule: "FREQ=DAILY;COUNT=3",
				}),
			}),
			{ params: Promise.resolve({ eventId: OWN_EVENT }) },
		);
		expect(response.status).toBe(400);

		const [row] = await createDb()
			.select()
			.from(calendarEvents)
			.where(eq(calendarEvents.id, OWN_EVENT));
		expect(row?.title).toBe("My standup");
	});
});
