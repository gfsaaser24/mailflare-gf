import { getClientIp } from "@/lib/http/ip";
import { newId } from "@/lib/ids";

/** One line per process, not one per blocked request. */
let warnedMissingSecret = false;

function warnMissingSecretOnce(): void {
	if (warnedMissingSecret) return;
	warnedMissingSecret = true;
	console.error(
		"TURNSTILE_SECRET_KEY is not set: every Turnstile-protected request is refused. " +
			"Set it (and NEXT_PUBLIC_TURNSTILE_SITE_KEY) to restore sign-in.",
	);
}

type TurnstileResponse = {
	success: boolean;
	"error-codes"?: string[];
};

export async function verifyTurnstileToken(
	env: Pick<CloudflareEnv, "TURNSTILE_SECRET_KEY">,
	request: Request,
	token: unknown,
): Promise<boolean> {
	const secret = env.TURNSTILE_SECRET_KEY?.trim();
	if (!secret) {
		// Fail closed in production: a missing secret used to wave every request
		// through, which silently removed the bot gate from login and register on
		// any deployment that forgot the variable. In development the check is
		// still skipped so nobody needs Cloudflare keys to run the app locally.
		if (process.env.NODE_ENV === "production") {
			warnMissingSecretOnce();
			return false;
		}
		return true;
	}
	if (typeof token !== "string" || !token.trim() || token.length > 2048) return false;

	let response: Response;
	try {
		response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: AbortSignal.timeout(10_000),
			body: JSON.stringify({
				secret,
				response: token,
				remoteip: getClientIp(request),
				idempotency_key: newId("ts"),
			}),
		});
	} catch {
		return false;
	}

	if (!response.ok) return false;
	const result = (await response.json()) as TurnstileResponse;
	return result.success;
}
