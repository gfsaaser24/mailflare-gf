"use client";

import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/auth/client";
import type { AuthMeResponse } from "./types";

/** Shared react-query key so the nav and the banner make one request between them. */
export const AUTH_ME_QUERY_KEY = ["auth", "me"] as const;

/**
 * `/api/auth/me`, which carries `isPlatformOperator` and `impersonatedByUserId`.
 * A 401 resolves to `{}` rather than throwing: the auth guard owns redirects.
 */
export function useAuthMe() {
	return useQuery<AuthMeResponse>({
		queryKey: AUTH_ME_QUERY_KEY,
		queryFn: async () => {
			const response = await authFetch("/api/auth/me", { redirectOnUnauthorized: false });
			if (!response.ok) return {};
			return (await response.json()) as AuthMeResponse;
		},
	});
}
