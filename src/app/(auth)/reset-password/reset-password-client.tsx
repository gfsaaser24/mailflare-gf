"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Mail } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH, submitResetPassword } from "./utils";

/** Shown when the link is missing, spent or expired. */
function DeadLink({ message }: { message: string }) {
	return (
		<AuthShell icon={Mail} title="This link is no longer valid" description={message}>
			<Button asChild className="h-11 w-full rounded-full px-6">
				<Link href="/forgot-password">Ask for a new link</Link>
			</Button>
		</AuthShell>
	);
}

export function ResetPasswordClient({ token }: { token: string }) {
	const router = useRouter();
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [deadLink, setDeadLink] = useState(!token);
	const [loading, setLoading] = useState(false);
	const [done, setDone] = useState(false);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (password !== confirm) {
			setError("The two passwords do not match");
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const result = await submitResetPassword(token, password);
			if (!result.ok) {
				if (result.invalidToken) setDeadLink(true);
				else setError(result.error ?? "Unable to reset the password.");
				return;
			}
			setDone(true);
			// No session is minted by a reset: the new password has to be typed.
			router.replace(result.redirect ?? "/login");
		} catch (caught) {
			setError(
				caught instanceof DOMException && caught.name === "TimeoutError"
					? "The request timed out. Please try again."
					: "Unable to reach the server. Please try again.",
			);
		} finally {
			setLoading(false);
		}
	}

	if (deadLink) {
		return (
			<DeadLink
				message={
					token
						? "The link has already been used, or it is more than 30 minutes old."
						: "This page needs a reset link. Ask for a new one and open it from your email."
				}
			/>
		);
	}

	return (
		<AuthShell
			icon={Mail}
			title="Choose a new password"
			description="Signing in again will need this password. Every device that was signed in gets signed out."
			footer={<Link href="/login">Back to sign in</Link>}
		>
			<form method="post" onSubmit={onSubmit} className="space-y-5">
				<div className="space-y-2">
					<Label htmlFor="reset-password">New password</Label>
					<Input
						id="reset-password"
						type="password"
						autoComplete="new-password"
						minLength={MIN_PASSWORD_LENGTH}
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="reset-confirm">Confirm password</Label>
					<Input
						id="reset-confirm"
						type="password"
						autoComplete="new-password"
						minLength={MIN_PASSWORD_LENGTH}
						value={confirm}
						onChange={(event) => setConfirm(event.target.value)}
						required
					/>
				</div>
				{error && (
					<p className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
						{error}
					</p>
				)}
				<Button
					type="submit"
					className="h-11 w-full rounded-full px-6 active:scale-[0.98]"
					disabled={loading || done}
				>
					{done ? "Password changed" : loading ? "Saving..." : "Set new password"}
				</Button>
			</form>
		</AuthShell>
	);
}
