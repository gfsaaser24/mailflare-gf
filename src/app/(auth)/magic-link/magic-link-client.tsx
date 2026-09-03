"use client";

import Link from "next/link";
import { useState } from "react";
import { Mail } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { TurnstileField } from "@/components/auth/turnstile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	RECOVERY_SENT_MESSAGE,
	submitRecoveryRequest,
} from "@/app/(auth)/forgot-password/utils";

export function MagicLinkClient() {
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);
	const [loading, setLoading] = useState(false);
	const [turnstileReset, setTurnstileReset] = useState(0);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setLoading(true);
		setError(null);

		try {
			const result = await submitRecoveryRequest(
				"/api/auth/magic-link",
				new FormData(event.currentTarget),
			);
			if (!result.ok) {
				setError(result.error ?? "Unable to send the link. Please try again.");
				setTurnstileReset((value) => value + 1);
				return;
			}
			setSent(true);
		} catch (caught) {
			setError(
				caught instanceof DOMException && caught.name === "TimeoutError"
					? "The request timed out. Please try again."
					: "Unable to reach the server. Please try again.",
			);
			setTurnstileReset((value) => value + 1);
		} finally {
			setLoading(false);
		}
	}

	return (
		<AuthShell
			icon={Mail}
			title="Sign in with a link"
			description="No password needed. Give the address you sign in with and open the link we send."
			footer={<Link href="/login">Sign in with a password instead</Link>}
		>
			{sent ? (
				<div className="space-y-5">
					<p className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-800">
						{RECOVERY_SENT_MESSAGE}
					</p>
					<p className="text-sm text-neutral-600">
						The link works once and expires in 15 minutes.
					</p>
					<Button asChild className="h-11 w-full rounded-full px-6">
						<Link href="/login">Back to sign in</Link>
					</Button>
				</div>
			) : (
				<form method="post" onSubmit={onSubmit} className="space-y-5">
					<div className="space-y-2">
						<Label htmlFor="magic-email">Email</Label>
						<Input
							id="magic-email"
							name="email"
							type="email"
							autoComplete="email"
							required
						/>
						<p className="text-sm text-neutral-600">
							The link goes to the recovery email on the account, not to this address.
						</p>
					</div>
					{error && (
						<p className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
							{error}
						</p>
					)}
					<TurnstileField resetSignal={turnstileReset} />
					<Button
						type="submit"
						className="h-11 w-full rounded-full px-6 active:scale-[0.98]"
						disabled={loading}
					>
						{loading ? "Sending..." : "Send sign-in link"}
					</Button>
				</form>
			)}
		</AuthShell>
	);
}
