"use client";

/**
 * Two-factor (authenticator app) controls for the account settings page.
 *
 * Self-contained: it renders a plain section, so it drops into a `CardContent`
 * or straight onto the page. Everything it needs comes from
 * `/api/auth/two-factor` and, for admins, `/api/settings/security`.
 *
 * The secret and the backup codes are shown exactly once, right after the
 * server hands them over; nothing is kept after a reload.
 */
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

type TwoFactorStatus = {
	enabled: boolean;
	enabledAt: string | null;
	backupCodesRemaining: number;
	requiredByOrganization: boolean;
};

type SetupPayload = {
	otpauthUrl: string;
	qrDataUrl: string;
	secret: string;
};

type ApiError = { error?: unknown };

function errorMessage(data: ApiError, fallback: string): string {
	return typeof data.error === "string" ? data.error : fallback;
}

async function readJson<T>(response: Response): Promise<T & ApiError> {
	return (await response.json().catch(() => ({}))) as T & ApiError;
}

export function TwoFactorPanel() {
	const [status, setStatus] = useState<TwoFactorStatus | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	const [setup, setSetup] = useState<SetupPayload | null>(null);
	const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
	const [copied, setCopied] = useState(false);

	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	/** Null until we know; false when `/api/settings/security` says 403. */
	const [isOrgAdmin, setIsOrgAdmin] = useState<boolean | null>(null);
	const [requireForOrg, setRequireForOrg] = useState(false);
	const [policyBusy, setPolicyBusy] = useState(false);
	const [policyError, setPolicyError] = useState<string | null>(null);

	const loadStatus = useCallback(async () => {
		const response = await authFetch("/api/auth/two-factor", { redirectOnUnauthorized: false });
		const data = await readJson<TwoFactorStatus>(response);
		if (!response.ok) throw new Error(errorMessage(data, "Could not load two-factor settings"));
		setStatus({
			enabled: !!data.enabled,
			enabledAt: data.enabledAt ?? null,
			backupCodesRemaining: data.backupCodesRemaining ?? 0,
			requiredByOrganization: !!data.requiredByOrganization,
		});
	}, []);

	useEffect(() => {
		let cancelled = false;

		void (async () => {
			try {
				await loadStatus();
			} catch (err) {
				if (!cancelled) {
					setLoadError(err instanceof Error ? err.message : "Could not load two-factor settings");
				}
			}
			// Admin-only endpoint: a 403 simply means this user is not an admin.
			const response = await authFetch("/api/settings/security", {
				redirectOnUnauthorized: false,
			});
			if (cancelled) return;
			if (!response.ok) {
				setIsOrgAdmin(false);
				return;
			}
			const data = await readJson<{ requireTwoFactor: boolean }>(response);
			setIsOrgAdmin(true);
			setRequireForOrg(!!data.requireTwoFactor);
		})();

		return () => {
			cancelled = true;
		};
	}, [loadStatus]);

	function resetForms(): void {
		setPassword("");
		setCode("");
	}

	async function startSetup(): Promise<void> {
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			const response = await authFetch("/api/auth/two-factor/setup", { method: "POST" });
			const data = await readJson<SetupPayload>(response);
			if (!response.ok) throw new Error(errorMessage(data, "Could not start setup"));
			setSetup({ otpauthUrl: data.otpauthUrl, qrDataUrl: data.qrDataUrl, secret: data.secret });
			setBackupCodes(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not start setup");
		} finally {
			setBusy(false);
		}
	}

	async function enable(event: React.FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await authFetch("/api/auth/two-factor/enable", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code, currentPassword: password }),
			});
			const data = await readJson<{ backupCodes: string[] }>(response);
			if (!response.ok) throw new Error(errorMessage(data, "Could not turn on two-factor"));
			setSetup(null);
			resetForms();
			setBackupCodes(data.backupCodes ?? []);
			setMessage("Two-factor authentication is on. Save these backup codes now.");
			await loadStatus();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not turn on two-factor");
		} finally {
			setBusy(false);
		}
	}

	async function regenerate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await authFetch("/api/auth/two-factor/backup-codes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ currentPassword: password }),
			});
			const data = await readJson<{ backupCodes: string[] }>(response);
			if (!response.ok) throw new Error(errorMessage(data, "Could not make new backup codes"));
			resetForms();
			setBackupCodes(data.backupCodes ?? []);
			setMessage("New backup codes. The old ones no longer work.");
			await loadStatus();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not make new backup codes");
		} finally {
			setBusy(false);
		}
	}

	async function disable(event: React.FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await authFetch("/api/auth/two-factor/disable", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ currentPassword: password, code }),
			});
			const data = await readJson<{ ok: boolean }>(response);
			if (!response.ok) {
				throw new Error(
					data.error === "two_factor_required"
						? "Your organisation requires two-factor authentication, so it cannot be turned off."
						: errorMessage(data, "Could not turn off two-factor"),
				);
			}
			resetForms();
			setBackupCodes(null);
			setMessage("Two-factor authentication is off.");
			await loadStatus();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not turn off two-factor");
		} finally {
			setBusy(false);
		}
	}

	async function togglePolicy(next: boolean): Promise<void> {
		setPolicyBusy(true);
		setPolicyError(null);
		try {
			const response = await authFetch("/api/settings/security", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requireTwoFactor: next }),
			});
			const data = await readJson<{ requireTwoFactor: boolean }>(response);
			if (!response.ok) throw new Error(errorMessage(data, "Could not change the policy"));
			setRequireForOrg(!!data.requireTwoFactor);
			await loadStatus();
		} catch (err) {
			setPolicyError(err instanceof Error ? err.message : "Could not change the policy");
		} finally {
			setPolicyBusy(false);
		}
	}

	async function copyCodes(): Promise<void> {
		if (!backupCodes) return;
		try {
			await navigator.clipboard.writeText(backupCodes.join("\n"));
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		} catch {
			setError("Could not copy. Select the codes and copy them by hand.");
		}
	}

	if (loadError) return <p className="text-sm text-red-600">{loadError}</p>;

	if (!status) {
		return (
			<div className="space-y-3">
				<Skeleton className="h-5 w-48" />
				<Skeleton className="h-10 w-40" />
			</div>
		);
	}

	const mustEnrol = status.requiredByOrganization && !status.enabled;

	return (
		<div className="space-y-6">
			{mustEnrol && (
				<p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
					Your organisation requires two-factor authentication. Set it up now to keep using your
					mailbox.
				</p>
			)}

			<div className="flex flex-wrap items-center gap-3">
				<span
					className={
						status.enabled
							? "rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-800"
							: "rounded-full bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-600"
					}
				>
					{status.enabled ? "On" : "Off"}
				</span>
				<p className="text-sm text-neutral-500">
					{status.enabled
						? `Turned on ${status.enabledAt ? new Date(status.enabledAt).toLocaleDateString() : ""}. ${status.backupCodesRemaining} backup code${status.backupCodesRemaining === 1 ? "" : "s"} left.`
						: "Add a code from an authenticator app to your sign-in."}
				</p>
			</div>

			{backupCodes && (
				<div className="space-y-3 rounded-2xl border border-blue-100 bg-blue-50/60 p-4">
					<p className="text-sm font-medium text-neutral-900">
						Save these backup codes. Each one works once and they are not shown again.
					</p>
					<ul className="grid grid-cols-2 gap-1 font-mono text-sm text-neutral-800">
						{backupCodes.map((backupCode) => (
							<li key={backupCode}>{backupCode}</li>
						))}
					</ul>
					<div className="flex items-center gap-3">
						<Button type="button" variant="outline" onClick={() => void copyCodes()}>
							{copied ? "Copied" : "Copy codes"}
						</Button>
						<Button type="button" variant="ghost" onClick={() => setBackupCodes(null)}>
							I saved them
						</Button>
					</div>
				</div>
			)}

			{!status.enabled && !setup && (
				<Button type="button" onClick={() => void startSetup()} disabled={busy}>
					{busy ? "Working..." : "Set up"}
				</Button>
			)}

			{!status.enabled && setup && (
				<form onSubmit={(event) => void enable(event)} className="space-y-4">
					<div className="flex flex-wrap items-start gap-5">
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img
							src={setup.qrDataUrl}
							alt="QR code for your authenticator app"
							className="h-40 w-40 rounded-xl border border-neutral-200 bg-white"
						/>
						<div className="space-y-2">
							<p className="text-sm text-neutral-600">
								Scan this with your authenticator app, or type the key in by hand:
							</p>
							<code className="block break-all rounded-lg bg-neutral-100 px-3 py-2 font-mono text-sm text-neutral-800">
								{setup.secret}
							</code>
						</div>
					</div>
					<div className="space-y-2">
						<Label htmlFor="twoFactorCode">Code from the app</Label>
						<Input
							id="twoFactorCode"
							inputMode="numeric"
							autoComplete="one-time-code"
							maxLength={6}
							value={code}
							onChange={(event) => setCode(event.target.value)}
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="twoFactorPassword">Current password</Label>
						<Input
							id="twoFactorPassword"
							type="password"
							autoComplete="current-password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							required
						/>
					</div>
					<div className="flex items-center gap-3">
						<Button type="submit" disabled={busy}>
							{busy ? "Turning on..." : "Turn on"}
						</Button>
						<Button
							type="button"
							variant="ghost"
							onClick={() => {
								setSetup(null);
								resetForms();
							}}
							disabled={busy}
						>
							Cancel
						</Button>
					</div>
				</form>
			)}

			{status.enabled && (
				<div className="space-y-6 border-t border-neutral-100 pt-6">
					<form onSubmit={(event) => void regenerate(event)} className="space-y-3">
						<Label htmlFor="regeneratePassword">Regenerate backup codes</Label>
						<p className="text-sm text-neutral-500">
							Your current password confirms it is you. The old codes stop working.
						</p>
						<Input
							id="regeneratePassword"
							type="password"
							autoComplete="current-password"
							placeholder="Current password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							required
						/>
						<Button type="submit" variant="outline" disabled={busy}>
							{busy ? "Working..." : "Regenerate backup codes"}
						</Button>
					</form>

					{!status.requiredByOrganization && (
						<form onSubmit={(event) => void disable(event)} className="space-y-3">
							<Label htmlFor="disableCode">Turn off two-factor</Label>
							<p className="text-sm text-neutral-500">
								Enter a code from the app or one backup code, plus your password.
							</p>
							<Input
								id="disableCode"
								placeholder="123456 or a backup code"
								autoComplete="one-time-code"
								maxLength={12}
								value={code}
								onChange={(event) => setCode(event.target.value)}
								required
							/>
							<Input
								id="disablePassword"
								type="password"
								autoComplete="current-password"
								placeholder="Current password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								required
							/>
							<Button type="submit" variant="outline" disabled={busy}>
								{busy ? "Working..." : "Turn off"}
							</Button>
						</form>
					)}
				</div>
			)}

			{(message || error) && (
				<p className={error ? "text-sm text-red-600" : "text-sm text-neutral-500"}>
					{error ?? message}
				</p>
			)}

			{isOrgAdmin && (
				<div className="space-y-3 border-t border-neutral-100 pt-6">
					<div className="flex items-start justify-between gap-4">
						<div>
							<p className="text-sm font-medium text-neutral-900">
								Require two-factor for everyone in this organisation
							</p>
							<p className="mt-1 text-sm text-neutral-500">
								Members who have not set it up must do so before they can use the app.
							</p>
						</div>
						<Switch
							checked={requireForOrg}
							disabled={policyBusy}
							onCheckedChange={(next) => void togglePolicy(next)}
						/>
					</div>
					{policyError && <p className="text-sm text-red-600">{policyError}</p>}
				</div>
			)}
		</div>
	);
}
