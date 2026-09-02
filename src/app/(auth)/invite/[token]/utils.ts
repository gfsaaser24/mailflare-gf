import type { AcceptInviteResponse } from "./types";

function errorMessage(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (payload && typeof payload === "object") {
		const flattened = payload as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
		const combined = [
			...(flattened.formErrors ?? []),
			...Object.values(flattened.fieldErrors ?? {}).flat(),
		].join("; ");
		if (combined) return combined;
	}
	return "Unable to set your password";
}

/** Posts the new password; resolves to an error message, or null on success. */
export async function submitInvite(token: string, password: string): Promise<string | null> {
	const response = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ password }),
	});
	const data = (await response.json()) as AcceptInviteResponse;
	return response.ok ? null : errorMessage(data.error);
}
