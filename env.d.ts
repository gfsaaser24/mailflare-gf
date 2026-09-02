/**
 * Runtime environment for the app. Built once from process.env by src/lib/env.ts.
 * The name `CloudflareEnv` is kept as an alias so the existing call sites keep compiling;
 * nothing in here is Cloudflare-specific anymore except the API credentials used to
 * manage Email Routing on your zones.
 */
interface AppEnv {
	/** Drizzle database bound to Supabase Postgres (via supascale). */
	DB: import("./src/db").AppDatabase;
	/** Object storage (Supabase Storage → R2) with an R2Bucket-like surface. */
	BUCKET: import("./src/lib/storage/bucket").StorageBucket;
	/** Outbound mail transport (thin Cloudflare send worker, or Maillayer). */
	EMAIL: import("./src/lib/email/transport").EmailSender;
	NODE_ENV?: string;
	APP_URL?: string;
	/** Shared secret the Cloudflare edge worker uses to POST inbound mail and that we use to call /send. */
	EDGE_WORKER_SECRET?: string;
	EDGE_WORKER_URL?: string;
	/** Cloudflare API creds (zone/email-routing management only). */
	CF_TOKEN?: string;
	CF_API_KEY?: string;
	CF_EMAIL?: string;
	CF_AID?: string;
	CF_EMAIL_WORKER_NAME?: string;
	TURNSTILE_SECRET_KEY?: string;
	NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
	GITHUB_UPDATE_TOKEN?: string;
	GITHUB_UPDATE_REF?: string;
	GITHUB_UPDATE_REPO?: string;
	LOGIN_RATE_LIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}
type CloudflareEnv = AppEnv;
