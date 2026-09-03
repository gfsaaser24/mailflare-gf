"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { mustEnrolTwoFactor, type AuthMeResult } from "@/components/platform/use-auth-me";
import type { AuthGuardProps } from "./auth-guard-types";
import { LoadingTransition } from "@/components/loading-transition";

/** Where `TwoFactorPanel` lives; `/settings` redirects here too. */
const TWO_FACTOR_SETUP_PATH = "/settings/account";

export function AuthGuard({ children, mode = "protected", requireMailbox, requireRole }: AuthGuardProps) {
	const pathname = usePathname();
	const router = useRouter();
	const [authorized, setAuthorized] = useState(mode === "public");

	useEffect(() => {
		let cancelled = false;

		async function checkSession() {
			try {
				const cookieResponse = await fetch("/api/auth/me", {
					cache: "no-store",
					signal: AbortSignal.timeout(5_000),
				});
				const response = cookieResponse.ok || cookieResponse.status !== 401
					? cookieResponse
					: await authFetch("/api/auth/me", {
						redirectOnUnauthorized: false,
						signal: AbortSignal.timeout(5_000),
					});
				if (cancelled) return;

				if (!response.ok) {
					if (mode === "protected" && response.status === 401) router.replace("/login");
					else setAuthorized(true);
					return;
				}

				const data = (await response.json()) as AuthMeResult;
				if (mode === "public") {
					router.replace("/inbox");
					return;
				}

				// The organisation requires two-factor and this user has not enrolled:
				// `withOrg()` is already answering 403 for everything else, so the only
				// useful place to be is the panel that sets it up.
				if (mustEnrolTwoFactor(data) && !pathname.startsWith(TWO_FACTOR_SETUP_PATH)) {
					router.replace(TWO_FACTOR_SETUP_PATH);
					return;
				}

				if (requireMailbox && data.hasMailboxes === false && data.user?.role === "admin" && data.isSetup === false && pathname !== "/setup") {
					router.replace("/setup");
					return;
				}

				if (pathname === "/setup" && data.isSetup === true) {
					router.replace("/inbox");
					return;
				}

				if (requireRole && data.user?.role !== requireRole) {
					router.replace("/inbox");
					return;
				}

				setAuthorized(true);
			} catch {
				if (!cancelled) setAuthorized(true);
			}
		}

		void checkSession();

		return () => {
			cancelled = true;
		};
	}, [mode, pathname, requireMailbox, requireRole, router]);

	if (mode === "public") return <>{children}</>;
	return <LoadingTransition ready={authorized}>{children}</LoadingTransition>;
}
