import { getSharedDb } from "@/db";
import { StorageBucket } from "@/lib/storage/bucket";
import { EdgeWorkerEmailSender, NoopEmailSender, type EmailSender } from "@/lib/email/transport";
import { createMemoryRateLimit } from "@/lib/auth/memory-rate-limit";

let cached: AppEnv | undefined;

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(name + " is not set");
	return value;
}

function buildEmailSender(): EmailSender {
	const url = process.env.EDGE_WORKER_URL;
	const secret = process.env.EDGE_WORKER_SECRET;
	if (url && secret) return new EdgeWorkerEmailSender(url, secret);
	return new NoopEmailSender();
}

export function getEnv(): AppEnv {
	if (cached) return cached;
	const e = process.env;
	// DB/BUCKET are left undefined when their config is missing so the setup
	// wizard (and the health check) can still run and report what is not set.
	const storageConfigured =
		!!e.STORAGE_S3_ENDPOINT && !!e.STORAGE_BUCKET && !!e.STORAGE_ACCESS_KEY_ID && !!e.STORAGE_SECRET_ACCESS_KEY;
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
		LOGIN_RATE_LIMIT: createMemoryRateLimit({ limit: 20, periodSeconds: 60 }),
	};
	return cached;
}

export async function getEnvAsync(): Promise<AppEnv> {
	return getEnv();
}
