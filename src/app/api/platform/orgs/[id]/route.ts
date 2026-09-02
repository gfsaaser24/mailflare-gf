/**
 * `GET /api/platform/orgs/[id]` — one organisation with its counts.
 * `PATCH /api/platform/orgs/[id]` — rename, re-note, suspend or restore.
 *
 * Platform plane (T3.3): guarded by `requirePlatformOperator`, never `withOrg`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformOperator } from "@/lib/platform/guard";
import {
	getOrganizationQuotaLimits,
	getOrganizationSummary,
	QUOTA_TEMPLATES,
	setOrganizationQuota,
	updateOrganization,
} from "@/lib/platform/service";

type RouteContext = { params: Promise<{ id: string }> };

/** A limit is a non-negative whole number, or `null` for "no limit". */
const limit = z.number().int().min(0).nullable().optional();

const patchOrgSchema = z
	.object({
		name: z.string().min(1).max(120).optional(),
		notes: z.string().max(10_000).nullable().optional(),
		status: z.enum(["active", "suspended"]).optional(),
		// Quota fields (T5.1): a template, explicit limits, or a template plus
		// overrides. Anything left out keeps its current value.
		quotaTemplate: z.enum(QUOTA_TEMPLATES).optional(),
		maxMailboxes: limit,
		maxSharedMailboxes: limit,
		maxAccounts: limit,
		maxDomains: limit,
		maxStorageBytes: limit,
		maxDailySends: limit,
		maxAttachmentBytes: limit,
	})
	.refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

const QUOTA_FIELDS = [
	"maxMailboxes",
	"maxSharedMailboxes",
	"maxAccounts",
	"maxDomains",
	"maxStorageBytes",
	"maxDailySends",
	"maxAttachmentBytes",
] as const;

export async function GET(request: Request, context: RouteContext) {
	const guard = await requirePlatformOperator(request);
	if (guard instanceof Response) return guard;

	const { id } = await context.params;
	const organization = await getOrganizationSummary(guard.db, id);
	if (!organization) {
		return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
	}
	const quota = await getOrganizationQuotaLimits(guard.db, id);
	return NextResponse.json({ organization, quota });
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

	const { quotaTemplate, ...rest } = parsed.data;
	const quotaPatch: Record<string, number | null> = {};
	for (const field of QUOTA_FIELDS) {
		if (rest[field] !== undefined) quotaPatch[field] = rest[field] as number | null;
	}

	const organization = await updateOrganization(
		guard.db,
		id,
		{ name: rest.name, notes: rest.notes, status: rest.status },
		guard.user.id,
	);
	if (!organization) {
		return NextResponse.json({ error: "Organisation not found" }, { status: 404 });
	}

	if (quotaTemplate || Object.keys(quotaPatch).length > 0) {
		await setOrganizationQuota(
			guard.db,
			id,
			{ ...(quotaTemplate ? { template: quotaTemplate } : {}), ...quotaPatch },
			guard.user.id,
		);
	}

	const quota = await getOrganizationQuotaLimits(guard.db, id);
	return NextResponse.json({ organization, quota });
}
