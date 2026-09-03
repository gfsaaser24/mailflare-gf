import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { calendarEvents } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { parseIcs } from "@/lib/calendar/ics";
import { isValidRrule } from "@/lib/calendar/recurrence";
import { normalizeTimeZone } from "@/lib/calendar/zones";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readFormDataBody } from "@/lib/http/request";
import { newId } from "@/lib/ids";

/** An .ics upload above this is refused outright. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** Rows written per request; anything past this counts as skipped. */
const MAX_IMPORTED_EVENTS = 1000;

async function readCalendarText(request: Request): Promise<string> {
	const contentType = request.headers.get("content-type") ?? "";
	if (contentType.includes("multipart/form-data")) {
		const form = await readFormDataBody(request, MAX_UPLOAD_BYTES);
		const file = form.get("file");
		if (file && typeof file !== "string") return file.text();
		return typeof file === "string" ? file : "";
	}

	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > MAX_UPLOAD_BYTES) throw new RequestBodyTooLargeError("Request body is too large");
	const body = await request.arrayBuffer();
	if (body.byteLength > MAX_UPLOAD_BYTES) throw new RequestBodyTooLargeError("Request body is too large");
	return new TextDecoder().decode(body);
}

/**
 * POST /api/calendar/import
 *
 * Accepts a multipart upload (field `file`) or a raw `text/calendar` body and
 * merges it into the caller own calendar, matching on the ICS `UID`. A UID that
 * already belongs to this user updates that row; anything else is inserted.
 * Occurrence overrides and non-VEVENT components are dropped by the parser.
 */
export const POST = withOrg(async ({ db, user, scoped, insertValues }, request) => {
	let text: string;
	try {
		text = await readCalendarText(request);
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) {
			return NextResponse.json({ error: error.message }, { status: 413 });
		}
		return NextResponse.json({ error: "Could not read the upload" }, { status: 400 });
	}

	if (!text.trim()) return NextResponse.json({ error: "No calendar data received" }, { status: 400 });

	const parsed = parseIcs(text);
	if (!parsed.length) {
		return NextResponse.json({ error: "No events found in that file" }, { status: 400 });
	}

	let imported = 0;
	let updated = 0;
	let skipped = 0;

	for (const event of parsed) {
		if (imported + updated >= MAX_IMPORTED_EVENTS) {
			skipped += 1;
			continue;
		}
		if (event.endsAt.getTime() <= event.startsAt.getTime()) {
			skipped += 1;
			continue;
		}

		const values = {
			title: event.title.slice(0, 300),
			description: event.description.slice(0, 20_000),
			location: event.location.slice(0, 500),
			attendees: JSON.stringify(event.attendees),
			startsAt: event.startsAt,
			endsAt: event.endsAt,
			allDay: event.allDay,
			timezone: normalizeTimeZone(event.timezone),
			rrule: event.rrule && isValidRrule(event.rrule) ? event.rrule : null,
		};

		const existing = event.uid
			? await db
					.select({ id: calendarEvents.id })
					.from(calendarEvents)
					.where(
						and(
							scoped(calendarEvents),
							eq(calendarEvents.userId, user.id),
							eq(calendarEvents.uid, event.uid),
						),
					)
					.limit(1)
			: [];

		if (existing[0]) {
			await db
				.update(calendarEvents)
				.set({ ...values, updatedAt: new Date() })
				.where(
					and(
						scoped(calendarEvents),
						eq(calendarEvents.id, existing[0].id),
						eq(calendarEvents.userId, user.id),
					),
				);
			updated += 1;
			continue;
		}

		const id = newId("evt");
		await db.insert(calendarEvents).values(
			insertValues(calendarEvents, {
				...values,
				id,
				userId: user.id,
				mailboxId: null,
				uid: event.uid ?? id,
				visibility: "private" as const,
				color: null,
			}),
		);
		imported += 1;
	}

	return NextResponse.json({ imported, updated, skipped });
});
