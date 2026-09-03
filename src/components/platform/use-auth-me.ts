"use client";

import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/auth/client";
import type { AuthMeResponse } from "./types";

/** Shared react-query key so the nav and the banner make one request between them. */
export const AUTH_ME_QUERY_KEY = ["auth", "me"] as const;

/**
 * `/api/auth/me` also reports the two-factor state.
 *
 * `enabled` is this user's own enrolment; `requiredByOrganization` mirrors
 * `organizations.require_two_factor`. Both true-ish means the user is blocked
 * from the rest of the API by `withOrg()` until they enrol.
 */
export type AuthMeTwoFactor = {
	enabled: boolean;
	requiredByOrganization: boolean;
};

/** `AuthMeResponse` plus the fields added after `src/components/platform/types.ts` was written. */
export type AuthMeResult = AuthMeResponse & {
	hasMailboxes?: boolean;
	isSetup?: boolean;
	twoFactor?: AuthMeTwoFactor;
};

/** True when the organisation forces two-factor and this user has not enrolled. */
export function mustEnrolTwoFactor(data: AuthMeResult | undefined): boolean {
	return !!data?.twoFactor?.requiredByOrganization && !data.twoFactor.enabled;
}

/**
 * `/api/auth/me`, which carries `isPlatformOperator` and `impersonatedByUserId`.
 * A 401 resolves to `{}` rather than throwing: the auth guard owns redirects.
 */
export function useAuthMe() {
	return useQuery<AuthMeResult>({
		queryKey: AUTH_ME_QUERY_KEY,
		queryFn: async () => {
			const response = await authFetch("/api/auth/me", { redirectOnUnauthorized: false });
			if (!response.ok) return {};
			return (await response.json()) as AuthMeResult;
		},
	});
}
