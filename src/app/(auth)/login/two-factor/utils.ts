import { persistAuthSession } from "@/lib/auth/client";
import type { TwoFactorVerifyResult } from "./types";

/**
 * Posts the second-step code. The pending session cookie is sent with it, so
 * nothing about the user has to travel in the body.
 */
export async function submitTwoFactorCode(
	code: string,
): Promise<{ ok: boolean; data: TwoFactorVerifyResult }> {
	const res = await fetch("/api/auth/two-factor/verify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		credentials: "include",
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ code }),
	});

	return {
		ok: res.ok,
		data: (await persistAuthSession(res)) as TwoFactorVerifyResult,
	};
}
