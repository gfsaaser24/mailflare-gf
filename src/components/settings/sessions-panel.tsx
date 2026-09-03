"use client";

/**
 * "Where you are signed in" — the user-facing half of session revocation.
 *
 * Everything here is metadata the server chose to hand over (`GET
 * /api/auth/sessions`): there is no token, and the "This device" badge comes
 * from the server comparing token hashes, not from anything this file could
 * work out on its own.
 *
 * Types and fetch helpers live in this file rather than in
 * `./types.d.ts` / `./utils.ts` so the panel is self-contained.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";

type SessionRow = {
	id: string;
	createdAt: string | null;
	lastSeenAt: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	current: boolean;
};

type SessionsResponse = { sessions?: SessionRow[]; error?: unknown };

async function loadSessions(): Promise<SessionRow[]> {
	const res = await authFetch("/api/auth/sessions");
	const data = (await res.json()) as SessionsResponse;
	if (!res.ok || !data.sessions) {
		throw new Error(typeof data.error === "string" ? data.error : "Could not load sessions");
	}
	return data.sessions;
}

async function revokeSession(id: string): Promise<void> {
	const res = await authFetch(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as SessionsResponse;
		throw new Error(typeof data.error === "string" ? data.error : "Could not sign that device out");
	}
}

async function revokeOtherSessions(): Promise<number> {
	const res = await authFetch("/api/auth/sessions/revoke-others", { method: "POST" });
	const data = (await res.json().catch(() => ({}))) as SessionsResponse & { revoked?: number };
	if (!res.ok) {
		throw new Error(typeof data.error === "string" ? data.error : "Could not sign the other devices out");
	}
	return data.revoked ?? 0;
}

/** Browser name from a user-agent string. Order matters: Chrome lies about Safari. */
function browserOf(userAgent: string): string {
	if (/edg\//i.test(userAgent)) return "Edge";
	if (/opr\/|opera/i.test(userAgent)) return "Opera";
	if (/firefox\//i.test(userAgent)) return "Firefox";
	if (/chrome\/|crios\//i.test(userAgent)) return "Chrome";
	if (/safari\//i.test(userAgent)) return "Safari";
	return "Browser";
}

function platformOf(userAgent: string): string {
	if (/windows/i.test(userAgent)) return "Windows";
	if (/iphone|ipad|ipod/i.test(userAgent)) return "iOS";
	if (/android/i.test(userAgent)) return "Android";
	if (/mac os|macintosh/i.test(userAgent)) return "macOS";
	if (/linux/i.test(userAgent)) return "Linux";
	return "Unknown device";
}

/** e.g. "Chrome on macOS". Falls back to the raw string when nothing matches. */
function describeUserAgent(userAgent: string | null): string {
	const value = userAgent?.trim();
	if (!value) return "Unknown device";
	return `${browserOf(value)} on ${platformOf(value)}`;
}

function formatDate(value: string | null): string {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString();
}

export function SessionsPanel() {
	const [sessions, setSessions] = useState<SessionRow[] | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			setSessions(await loadSessions());
		} catch (err) {
			setStatus(err instanceof Error ? err.message : "Could not load sessions");
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function onRevoke(id: string) {
		setStatus(null);
		setBusy(id);
		try {
			await revokeSession(id);
			await refresh();
			setStatus("Device signed out");
		} catch (err) {
			setStatus(err instanceof Error ? err.message : "Could not sign that device out");
		} finally {
			setBusy(null);
		}
	}

	async function onRevokeOthers() {
		setStatus(null);
		setBusy("others");
		try {
			const revoked = await revokeOtherSessions();
			await refresh();
			setStatus(revoked === 0 ? "No other devices were signed in" : `Signed out ${revoked} other device(s)`);
		} catch (err) {
			setStatus(err instanceof Error ? err.message : "Could not sign the other devices out");
		} finally {
			setBusy(null);
		}
	}

	const others = (sessions ?? []).filter((session) => !session.current).length;

	return (
		<div className="space-y-4">
			<div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
				<table className="w-full text-left text-sm">
					<thead className="text-neutral-500">
						<tr>
							<th className="px-3 py-2 font-medium">Device</th>
							<th className="px-3 py-2 font-medium">IP address</th>
							<th className="px-3 py-2 font-medium">Signed in</th>
							<th className="px-3 py-2 font-medium">Last seen</th>
							<th className="px-3 py-2" />
						</tr>
					</thead>
					<tbody>
						{sessions === null && (
							<tr>
								<td className="px-3 py-3 text-neutral-500" colSpan={5}>
									Loading...
								</td>
							</tr>
						)}
						{sessions !== null && sessions.length === 0 && (
							<tr>
								<td className="px-3 py-3 text-neutral-500" colSpan={5}>
									No active sessions
								</td>
							</tr>
						)}
						{(sessions ?? []).map((session) => (
							<tr key={session.id} className="border-t border-neutral-200 dark:border-neutral-800">
								<td className="px-3 py-2">
									<div className="flex items-center gap-2">
										<span>{describeUserAgent(session.userAgent)}</span>
										{session.current && <Badge variant="secondary">This device</Badge>}
									</div>
								</td>
								<td className="px-3 py-2 text-neutral-500">{session.ipAddress ?? "—"}</td>
								<td className="px-3 py-2 text-neutral-500">{formatDate(session.createdAt)}</td>
								<td className="px-3 py-2 text-neutral-500">{formatDate(session.lastSeenAt)}</td>
								<td className="px-3 py-2 text-right">
									{!session.current && (
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={busy !== null}
											onClick={() => void onRevoke(session.id)}
										>
											{busy === session.id ? "Signing out..." : "Sign out"}
										</Button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="flex items-center gap-3">
				<Button
					type="button"
					variant="outline"
					disabled={busy !== null || others === 0}
					onClick={() => void onRevokeOthers()}
				>
					{busy === "others" ? "Signing out..." : "Sign out everywhere else"}
				</Button>
				{status && <p className="text-sm text-neutral-500">{status}</p>}
			</div>
		</div>
	);
}
