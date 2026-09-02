"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { authFetch, clearClientSession } from "@/lib/auth/client";
import { useAuthMe } from "./use-auth-me";

/**
 * Shown inside an impersonation session (T3.3): `/api/auth/me` reports
 * `impersonatedByUserId` whenever the cookie was minted by
 * `/api/platform/orgs/[id]/impersonate`.
 *
 * Stopping deletes the session and clears the cookie, so the only place to land
 * is `/login`; the operator signs back in to return to the console.
 */
export function ImpersonationBanner() {
	const { data } = useAuthMe();
	const [stopping, setStopping] = useState(false);

	const user = data?.user;
	if (!user?.impersonatedByUserId) return null;

	async function stop() {
		setStopping(true);
		try {
			const response = await authFetch("/api/platform/impersonate/stop", {
				method: "POST",
				redirectOnUnauthorized: false,
			});
			if (!response.ok) {
				setStopping(false);
				return;
			}
			clearClientSession();
			// Hard navigation: every cached query belongs to the impersonated user.
			window.location.href = "/login";
		} catch {
			setStopping(false);
		}
	}

	return (
		<div className="flex flex-wrap items-center gap-3 rounded-2xl bg-amber-100 px-4 py-2 text-sm text-amber-900">
			<ShieldAlert className="h-4 w-4 shrink-0" />
			<span className="min-w-0 flex-1 truncate">
				You are impersonating <span className="font-semibold">{user.name || user.email}</span>
			</span>
			<button
				type="button"
				onClick={stop}
				disabled={stopping}
				className="rounded-full bg-amber-900 px-3 py-1 text-xs font-semibold text-amber-50 transition-colors hover:bg-amber-800 disabled:opacity-50"
			>
				{stopping ? "Stopping..." : "Stop"}
			</button>
		</div>
	);
}
