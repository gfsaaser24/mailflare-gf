import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { reconcileAllDomains } from "@/lib/domains/status";
import { runRetention } from "@/lib/retention/service";
import { retryDueDeliveries } from "@/lib/webhooks/retry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Maintenance jobs, triggered by cron on the host with `Authorization: Bearer $CRON_SECRET`
 * (see CLAUDE.md → Scheduled jobs). The Docker image ships only the built app, so the
 * `scripts/*.ts` entry points are not available inside the container; this route is how
 * they run in production.
 */
const JOBS = {
	retention: (env: AppEnv) => runRetention(env),
	"webhook-retry": (env: AppEnv) => retryDueDeliveries(env),
	"reconcile-domains": (env: AppEnv) => reconcileAllDomains(env),
} as const;

type JobName = keyof typeof JOBS;

export async function POST(request: Request, { params }: { params: Promise<{ job: string }> }) {
	const env = getEnv();
	if (!isAuthorized(request, process.env.CRON_SECRET)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const { job } = await params;
	if (!(job in JOBS)) {
		return NextResponse.json({ error: "Unknown job", jobs: Object.keys(JOBS) }, { status: 404 });
	}
	const startedAt = Date.now();
	try {
		const result = await JOBS[job as JobName](env);
		return NextResponse.json({ ok: true, job, ms: Date.now() - startedAt, result });
	} catch (error) {
		console.error(`cron job ${job} failed`, error);
		const message = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, job, ms: Date.now() - startedAt, error: message }, { status: 500 });
	}
}

function isAuthorized(request: Request, secret: string | undefined): boolean {
	if (!secret) return false;
	const header = request.headers.get("Authorization") ?? "";
	if (!header.startsWith("Bearer ")) return false;
	const provided = Buffer.from(header.slice("Bearer ".length));
	const expected = Buffer.from(secret);
	if (provided.length !== expected.length) return false;
	return timingSafeEqual(provided, expected);
}
