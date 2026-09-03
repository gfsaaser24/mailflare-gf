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
	/** 32-byte key (base64 or hex) used to encrypt TOTP secrets at rest. */
	AUTH_ENCRYPTION_KEY?: string;
	/** From address for system mail (reset, magic link). Falls back to no-reply@<primary domain>. */
	SYSTEM_EMAIL_FROM?: string;
	/** "true" only when Cloudflare proxies every request; CF-Connecting-IP is spoofable otherwise. */
	TRUST_CF_HEADERS?: string;
	LOGIN_RATE_LIMIT?: RateLimiter;
	/** Named limiters for the auth surfaces. See `src/lib/auth/rate-limit.ts`. */
	AUTH_RATE_LIMITS?: AuthRateLimiters;
}

/** Minimal limiter surface; `createMemoryRateLimit` returns one of these. */
interface RateLimiter {
	limit(input: { key: string }): Promise<{ success: boolean }>;
}

interface AuthRateLimiters {
	/** 20 per minute per IP. */
	login: RateLimiter;
	/** 5 per 15 minutes per IP. */
	recovery: RateLimiter;
	/** 3 per hour per email key. */
	recoveryPerEmail: RateLimiter;
	/** 5 per 15 minutes per IP. */
	magicLink: RateLimiter;
	/** 3 per hour per email key. */
	magicLinkPerEmail: RateLimiter;
	/** 5 per 5 minutes per session key. */
	twoFactor: RateLimiter;
}

type AuthRateLimitBucket = keyof AuthRateLimiters;
type CloudflareEnv = AppEnv;
