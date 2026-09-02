import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { APP_SETTINGS_ID } from "@/lib/branding/service";
import { getEnvAsync } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

async function getDefaultIcon(): Promise<Response> {
	const filePath = path.join(process.cwd(), "public", "icon-96.png");
	const bytes = await readFile(filePath);
	return new Response(new Uint8Array(bytes), {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "no-cache",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export async function GET(request: Request) {
	const env = await getEnvAsync();
	try {
		const [settings] = await getDb(env)
			.select({ iconKey: appSettings.iconKey })
			.from(appSettings)
			.where(eq(appSettings.id, APP_SETTINGS_ID))
			.limit(1);
		if (settings?.iconKey) {
			const object = await env.BUCKET.get(settings.iconKey);
			if (object) {
				return new Response(object.body, {
					headers: {
						"Content-Type": object.httpMetadata?.contentType ?? "image/png",
						"Cache-Control": "no-cache",
						"X-Content-Type-Options": "nosniff",
					},
				});
			}
		}
	} catch {
		// Use the packaged icon until the branding migration is available.
	}
	return getDefaultIcon();
}
