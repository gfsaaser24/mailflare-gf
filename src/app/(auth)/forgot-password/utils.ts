import type { RecoveryRequestResult } from "./types";

/**
 * The neutral line both recovery forms show on success. It must never vary with
 * the outcome: the API deliberately answers the same way for an unknown address
 * as for a real one, and a chattier UI would undo that.
 */
export const RECOVERY_SENT_MESSAGE =
	"If that account exists, we sent a link to its recovery email.";

type ErrorPayload = { error?: unknown };

function errorMessage(payload: unknown, fallback: string): string {
	const value = (payload as ErrorPayload | null)?.error;
	return typeof value === "string" && value ? value : fallback;
}

/** Posts an email + Turnstile token to a recovery endpoint. */
export async function submitRecoveryRequest(
	endpoint: string,
	form: FormData,
): Promise<RecoveryRequestResult> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({
			email: form.get("email"),
			turnstileToken: form.get("turnstileToken"),
		}),
	});
	if (response.ok) return { ok: true };
	const data = (await response.json().catch(() => null)) as unknown;
	return { ok: false, error: errorMessage(data, "Unable to send the link. Please try again.") };
}
