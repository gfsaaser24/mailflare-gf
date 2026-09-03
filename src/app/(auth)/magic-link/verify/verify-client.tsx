"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Mail } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { consumeMagicLink } from "./utils";

function DeadLink({ message }: { message: string }) {
	return (
		<AuthShell icon={Mail} title="This link is no longer valid" description={message}>
			<Button asChild className="h-11 w-full rounded-full px-6">
				<Link href="/magic-link">Ask for a new link</Link>
			</Button>
		</AuthShell>
	);
}

export function MagicLinkVerifyClient({ token }: { token: string }) {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [deadLink, setDeadLink] = useState(!token);
	const [loading, setLoading] = useState(false);
	const [done, setDone] = useState(false);

	async function onContinue() {
		setLoading(true);
		setError(null);
		try {
			const result = await consumeMagicLink(token);
			if (!result.ok) {
				if (result.invalidToken) setDeadLink(true);
				else setError(result.error ?? "Unable to sign in with this link.");
				return;
			}
			setDone(true);
			// `completeLogin()` decides where this goes: the inbox, or the TOTP prompt.
			router.replace(result.redirect ?? "/inbox");
			router.refresh();
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
						? "The link has already been used, or it is more than 15 minutes old."
						: "This page needs a sign-in link. Ask for a new one and open it from your email."
				}
			/>
		);
	}

	return (
		<AuthShell
			icon={Mail}
			title="Continue to sign in"
			description="Your link is ready. It is spent the moment you continue, so use it on the device you want to be signed in on."
			footer={<Link href="/login">Sign in with a password instead</Link>}
		>
			<div className="space-y-5">
				{error && (
					<p className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
						{error}
					</p>
				)}
				<Button
					type="button"
					onClick={onContinue}
					className="h-11 w-full rounded-full px-6 active:scale-[0.98]"
					disabled={loading || done}
				>
					{done ? "Signed in" : loading ? "Signing in..." : "Continue to sign in"}
				</Button>
			</div>
		</AuthShell>
	);
}
