import { persistAuthSession } from "@/lib/auth/client";
import type { MagicLinkConsumeResult } from "./types";

type ConsumePayload = { ok?: boolean; redirect?: string; error?: unknown };

/**
 * Spends the link. Called from a click, never on page load: mail scanners GET
 * every URL in a message, and a link spent by a scanner is a link the real user
 * can no longer use.
 */
export async function consumeMagicLink(token: string): Promise<MagicLinkConsumeResult> {
	const response = await fetch("/api/auth/magic-link/consume", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ token }),
	});
	// Records the local "a session exists" hint; the cookie is already set.
	const data = (await persistAuthSession(response)) as ConsumePayload;
	if (response.ok) return { ok: true, redirect: data.redirect ?? "/inbox" };
	return {
		ok: false,
		invalidToken: response.status === 400,
		error:
			typeof data.error === "string" && data.error
				? data.error
				: "Unable to sign in with this link.",
	};
}
