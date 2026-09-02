import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { addDomainSchema } from "@/lib/validators";
import { addDomainForUser, listUserDomains } from "@/lib/domains/service";
import { DomainProvisionError } from "@/lib/domains/provision";

/**
 * The list is served straight from the rows. DNS/routing health is no longer
 * recomputed per request: `POST /api/domains/[id]/reconcile` (and the nightly
 * `scripts/reconcile-domains.ts`) own `status`, `status_reason`, `dns_ok` and
 * `last_checked_at`.
 *
 * Scoping lives in `@/lib/domains/service`: every helper takes `ctx.orgId` and
 * filters on it, so a domain in another organisation is invisible here.
 */
export const GET = withOrg(async ({ env, user, orgId }) => {
	const domainOwnerId = user.canManageMailboxes && user.createdByUserId ? user.createdByUserId : user.id;
	const domains = await listUserDomains(env, orgId, domainOwnerId);

	return NextResponse.json({ domains });
});

export const POST = withOrg(async ({ env, user, orgId }, request) => {
	const parsed = addDomainSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	try {
		const result = await addDomainForUser(env, orgId, user.id, parsed.data.hostname, {
			enableRouting: parsed.data.enableRouting,
			enableSending: parsed.data.enableSending,
		});
		return NextResponse.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to add domain";
		if (err instanceof DomainProvisionError) {
			// Cloudflare steps failed and were rolled back; the DB step is a client error.
			const status = err.step === "db" || err.step === "zone-lookup" ? 400 : 502;
			return NextResponse.json({ error: message, step: err.step }, { status });
		}
		return NextResponse.json({ error: message }, { status: 400 });
	}
});
