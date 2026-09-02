/**
 * `GET /api/platform/orgs/[id]` — one organisation with its counts.
 * `PATCH /api/platform/orgs/[id]` — rename, re-note, suspend or restore.
 *
 * Platform plane (T3.3): guarded by `requirePlatformOperator`, never `withOrg`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformOperator } from "@/lib/platform/guard";
import { getOrganizationSummary, updateOrganization } from "@/lib/platform/service";

type RouteContext = { params: Promise<{ id: string }> };

const patchOrgSchema = z
	.object({
		name: z.string().min(1).max(120).optional(),
		notes: z.string().max(10_000).nullable().optional(),
		status: z.enum(["active", "suspended"]).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

export async function GET(request: Request, context: RouteContext) {
	const guard = await requirePlatformOperator(request);
	if (guard instanceof Response) return guard;

	const { id } = await context.params;
	const organization = await getOrganizationSummary(guard.db, id);
	if (!organization) {
		return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
	}
	return NextResponse.json({ organization });
}

export async function PATCH(request: Request, context: RouteContext) {
	const guard = await requirePlatformOperator(request);
	if (guard instanceof Response) return guard;

	const { id } = await context.params;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = patchOrgSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const organization = await updateOrganization(guard.db, id, parsed.data, guard.user.id);
	if (!organization) {
		return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
	}
	return NextResponse.json({ organization });
}
