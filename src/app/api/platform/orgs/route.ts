/**
 * `GET /api/platform/orgs` — every organisation with live counts.
 * `POST /api/platform/orgs` — create an organisation plus its first admin.
 *
 * Platform plane (T3.3): guarded by `requirePlatformOperator`, never `withOrg`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformOperator } from "@/lib/platform/guard";
import {
	createOrganizationWithAdmin,
	EmailTakenError,
	listOrganizationsWithCounts,
	QUOTA_TEMPLATES,
	SlugTakenError,
} from "@/lib/platform/service";

const createOrgSchema = z.object({
	name: z.string().min(1).max(120),
	slug: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9-]*$/i, "Slug must be alphanumeric with dashes"),
	quotaTemplate: z.enum(QUOTA_TEMPLATES).optional(),
	adminEmail: z.string().email(),
	adminName: z.string().min(1).max(120),
});

export async function GET(request: Request) {
	const guard = await requirePlatformOperator(request);
	if (guard instanceof Response) return guard;

	const organizations = await listOrganizationsWithCounts(guard.db);
	return NextResponse.json({ organizations });
}

export async function POST(request: Request) {
	const guard = await requirePlatformOperator(request);
	if (guard instanceof Response) return guard;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = createOrgSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	try {
		const result = await createOrganizationWithAdmin(guard.db, parsed.data, guard.user.id);
		const response = NextResponse.json({
			...result,
			// No invite/reset mechanism exists yet (T3.5); this is the only time the
			// password is ever shown.
			passwordDeliveryNote:
				"There is no password-reset flow yet, so this password is shown once. Give it to the new admin out of band; they can change it at /api/settings/password.",
		});
		response.headers.set("Cache-Control", "no-store");
		return response;
	} catch (error) {
		if (error instanceof SlugTakenError) {
			return NextResponse.json({ error: error.message }, { status: 409 });
		}
		if (error instanceof EmailTakenError) {
			return NextResponse.json({ error: error.message }, { status: 409 });
		}
		throw error;
	}
}
