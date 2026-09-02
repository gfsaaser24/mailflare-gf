import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { getDomainForUser } from "@/lib/domains/service";
import { reconcileDomain } from "@/lib/domains/status";

type Params = { params: Promise<{ id: string }> };

/** Explicit "check now": re-reads live Cloudflare state and rewrites the row. */
export async function POST(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const owned = await getDomainForUser(env, user.id, id);
	if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

	try {
		const result = await reconcileDomain(env, owned.id);
		const domain = await getDomainForUser(env, user.id, id);
		return NextResponse.json({ domain, result });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to reconcile domain";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
