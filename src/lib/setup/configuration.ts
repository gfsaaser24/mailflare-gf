import type { SetupRequirementCheck } from "./types";
import { DEFAULT_EMAIL_WORKER_NAME } from "@/lib/cloudflare-api-utils";

export function getSetupRequirementChecks(env: CloudflareEnv): SetupRequirementCheck[] {
	const hasApiToken = !!env.CF_TOKEN?.trim();
	const hasGlobalKey = !!env.CF_API_KEY?.trim() && !!env.CF_EMAIL?.trim();

	return [
		{
			key: "Cloudflare API credentials",
			configured: hasApiToken || hasGlobalKey,
			message: "Set CF_TOKEN, or set both CF_API_KEY and CF_EMAIL.",
		},
		{
			key: "Email edge worker",
			configured: !!(env.CF_EMAIL_WORKER_NAME?.trim() || DEFAULT_EMAIL_WORKER_NAME) && !!env.EDGE_WORKER_URL?.trim() && !!env.EDGE_WORKER_SECRET?.trim(),
			message: "Deploy cloudflare-worker/ (npm run edge:deploy) and set EDGE_WORKER_URL and EDGE_WORKER_SECRET.",
		},
		{
			key: "Postgres database",
			configured: !!env.DB,
			message: "Set DATABASE_URL to the Supabase Postgres connection string.",
		},
		{
			key: "Object storage",
			configured: !!env.BUCKET,
			message: "Set STORAGE_S3_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY.",
		},
	];
}
