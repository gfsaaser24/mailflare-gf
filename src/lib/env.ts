import { getSharedDb } from "@/db";
import { StorageBucket } from "@/lib/storage/bucket";
import {
	EdgeWorkerEmailSender,
	NoopEmailSender,
	UnconfiguredEmailSender,
	type EmailSender,
} from "@/lib/email/transport";
import { createMemoryRateLimit } from "@/lib/auth/memory-rate-limit";

let cached: AppEnv | undefined;

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(name + " is not set");
	return value;
}

/**
 * Configuration that a production deployment must have, and what breaks without
 * it. Warn, never throw: the setup wizard has to be able to boot an unconfigured
 * container so the operator can fix it from the browser.
 */
const PRODUCTION_REQUIRED: Array<{ name: string; consequence: string }> = [
	{ name: "TURNSTILE_SECRET_KEY", consequence: "sign-in and register refuse every request" },
	{ name: "NEXT_PUBLIC_TURNSTILE_SITE_KEY", consequence: "the sign-in widget cannot render a token" },
	{ name: "AUTH_ENCRYPTION_KEY", consequence: "TOTP secrets cannot be encrypted or read back" },
	{ name: "APP_URL", consequence: "invite, reset and magic links are built with no origin" },
];

/** One block per process, at the first `getEnv()`. */
function warnAboutMissingProductionConfig(e: NodeJS.ProcessEnv): void {
	if (e.NODE_ENV !== "production") return;
	const missing = PRODUCTION_REQUIRED.filter((entry) => !e[entry.name]?.trim());
	if (missing.length === 0) return;
	console.error("[env] Missing production configuration:");
	for (const entry of missing) console.error(`[env]   - ${entry.name}: ${entry.consequence}`);
	console.error(
		"[env] The app still starts so the setup wizard can run; set these in the deployment environment.",
	);
}

function buildEmailSender(): EmailSender {
	const url = process.env.EDGE_WORKER_URL;
	const secret = process.env.EDGE_WORKER_SECRET;
	if (url && secret) return new EdgeWorkerEmailSender(url, secret);
	if (url || secret) {
		throw new Error("EDGE_WORKER_URL and EDGE_WORKER_SECRET must be set together");
	}
	// Silently dropping mail is only acceptable in development.
	if (process.env.NODE_ENV === "production") return new UnconfiguredEmailSender();
	return new NoopEmailSender();
}

export function getEnv(): AppEnv {
	if (cached) return cached;
	const e = process.env;
	warnAboutMissingProductionConfig(e);
	// DB/BUCKET are left undefined when their config is missing so the setup
	// wizard (and the health check) can still run and report what is not set.
	const storageConfigured =
		!!e.STORAGE_S3_ENDPOINT && !!e.STORAGE_BUCKET && !!e.STORAGE_ACCESS_KEY_ID && !!e.STORAGE_SECRET_ACCESS_KEY;
	const loginLimiter = createMemoryRateLimit({ limit: 20, periodSeconds: 60 });
	cached = {
		DB: (e.DATABASE_URL ? getSharedDb() : undefined) as AppEnv["DB"],
		BUCKET: (storageConfigured
			? new StorageBucket({
					endpoint: required("STORAGE_S3_ENDPOINT"),
					region: e.STORAGE_S3_REGION ?? "auto",
					bucket: required("STORAGE_BUCKET"),
					accessKeyId: required("STORAGE_ACCESS_KEY_ID"),
					secretAccessKey: required("STORAGE_SECRET_ACCESS_KEY"),
					forcePathStyle: true,
				})
			: undefined) as AppEnv["BUCKET"],
		EMAIL: buildEmailSender(),
		NODE_ENV: e.NODE_ENV,
		APP_URL: e.APP_URL,
		EDGE_WORKER_SECRET: e.EDGE_WORKER_SECRET,
		EDGE_WORKER_URL: e.EDGE_WORKER_URL,
		CF_TOKEN: e.CF_TOKEN,
		CF_API_KEY: e.CF_API_KEY,
		CF_EMAIL: e.CF_EMAIL,
		CF_AID: e.CF_AID,
		CF_EMAIL_WORKER_NAME: e.CF_EMAIL_WORKER_NAME,
		TURNSTILE_SECRET_KEY: e.TURNSTILE_SECRET_KEY,
		NEXT_PUBLIC_TURNSTILE_SITE_KEY: e.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
		GITHUB_UPDATE_TOKEN: e.GITHUB_UPDATE_TOKEN,
		GITHUB_UPDATE_REF: e.GITHUB_UPDATE_REF,
		GITHUB_UPDATE_REPO: e.GITHUB_UPDATE_REPO,
		AUTH_ENCRYPTION_KEY: e.AUTH_ENCRYPTION_KEY,
		SYSTEM_EMAIL_FROM: e.SYSTEM_EMAIL_FROM,
		TRUST_CF_HEADERS: e.TRUST_CF_HEADERS,
		LOGIN_RATE_LIMIT: loginLimiter,
		AUTH_RATE_LIMITS: {
			// `login` is the same limiter as LOGIN_RATE_LIMIT so the two names cannot drift.
			login: loginLimiter,
			recovery: createMemoryRateLimit({ limit: 5, periodSeconds: 15 * 60 }),
			recoveryPerEmail: createMemoryRateLimit({ limit: 3, periodSeconds: 60 * 60 }),
			magicLink: createMemoryRateLimit({ limit: 5, periodSeconds: 15 * 60 }),
			magicLinkPerEmail: createMemoryRateLimit({ limit: 3, periodSeconds: 60 * 60 }),
			// Keyed on the user, not the session: every login mints a fresh
			// pending session, so a session key reset the budget on demand.
			twoFactor: createMemoryRateLimit({ limit: 5, periodSeconds: 5 * 60 }),
			// The same step, keyed on the caller's IP, so one host cannot walk
			// codes for many accounts at five tries each.
			twoFactorPerIp: createMemoryRateLimit({ limit: 20, periodSeconds: 5 * 60 }),
		},
	};
	return cached;
}

export async function getEnvAsync(): Promise<AppEnv> {
	return getEnv();
}
