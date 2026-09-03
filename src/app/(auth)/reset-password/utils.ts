import type { ResetPasswordResult } from "./types";

/** Mirrors `registerSchema.shape.password` (`src/lib/validators.ts`). */
export const MIN_PASSWORD_LENGTH = 8;

type ResetPayload = { ok?: boolean; redirect?: string; error?: unknown; invalidToken?: boolean };

/** Posts the new password. The token stays in the body, never in a query log. */
export async function submitResetPassword(
	token: string,
	password: string,
): Promise<ResetPasswordResult> {
	const response = await fetch("/api/auth/reset-password", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ token, password }),
	});
	const data = (await response.json().catch(() => null)) as ResetPayload | null;
	if (response.ok) return { ok: true, redirect: data?.redirect ?? "/login" };
	return {
		ok: false,
		invalidToken: data?.invalidToken === true,
		error:
			typeof data?.error === "string" && data.error
				? data.error
				: "Unable to reset the password. Please try again.",
	};
}
