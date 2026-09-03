import { persistAuthSession } from "@/lib/auth/client";
import type { LoginResult } from "./types";

/** Where a login that still needs an authenticator code continues. */
export const TWO_FACTOR_PATH = "/login/two-factor";

export async function submitLogin(form: FormData): Promise<{ ok: boolean; data: LoginResult }> {
	const res = await fetch("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({
			email: form.get("email"),
			password: form.get("password"),
			turnstileToken: form.get("turnstileToken"),
		}),
	});

	const data = (await persistAuthSession(res)) as LoginResult;

	return {
		ok: res.ok,
		// `completeLogin()` already sends `/login/two-factor`; the fallback keeps a
		// two-factor account off `/inbox` even if the field is ever dropped.
		data: data.requiresTwoFactor
			? { ...data, redirect: data.redirect ?? TWO_FACTOR_PATH }
			: data,
	};
}
