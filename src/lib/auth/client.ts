"use client";

import type {
	AuthFetchOptions,
	AuthSessionChangedDetail,
	AuthSessionResponse,
} from "./client-types";

/**
 * The session token lives in the httpOnly `ep_session` cookie and is never
 * readable by this code. All we keep locally is a non-sensitive hint that a
 * session was established, so the UI can skip requests it knows will 401.
 */
const SESSION_FLAG_KEY = "mailflare-session";
export const AUTH_SESSION_CHANGED_EVENT = "mailflare:auth-session-changed";

function dispatchAuthSessionChanged(authenticated: boolean): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<AuthSessionChangedDetail>(AUTH_SESSION_CHANGED_EVENT, {
			detail: { authenticated },
		}),
	);
}

/** Best-effort hint only; the server is the sole authority on the session. */
export function hasClientSession(): boolean {
	if (typeof window === "undefined") return false;
	return localStorage.getItem(SESSION_FLAG_KEY) === "1";
}

export function markClientSession(): void {
	const wasSet = hasClientSession();
	localStorage.setItem(SESSION_FLAG_KEY, "1");
	if (!wasSet) dispatchAuthSessionChanged(true);
}

export function clearClientSession(): void {
	localStorage.removeItem(SESSION_FLAG_KEY);
	// Legacy key from when the token was mirrored into localStorage.
	localStorage.removeItem("mailflare-session-token");
	dispatchAuthSessionChanged(false);
}

/**
 * No Authorization header is ever added: `Bearer` is reserved for API keys.
 * Kept so callers that must build headers by hand (XHR) stay uniform.
 */
export function getAuthHeaders(headers?: HeadersInit): Headers {
	return new Headers(headers);
}

export async function authFetch(input: RequestInfo | URL, init: AuthFetchOptions = {}): Promise<Response> {
	const { redirectOnUnauthorized = true, headers, ...requestInit } = init;
	const response = await fetch(input, {
		...requestInit,
		credentials: "include",
		headers: getAuthHeaders(headers),
	});

	if (response.status === 401 && redirectOnUnauthorized && typeof window !== "undefined") {
		clearClientSession();
		window.location.assign("/login");
	}

	return response;
}

export async function persistAuthSession(response: Response): Promise<AuthSessionResponse> {
	const data = (await response.json()) as AuthSessionResponse;
	// The cookie is already set by the response; only record the local hint.
	if (response.ok && data.ok) markClientSession();
	return data;
}
