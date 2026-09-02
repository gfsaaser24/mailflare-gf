"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Mail } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { InviteDetails } from "./types";
import { submitInvite } from "./utils";

export function InviteClient({ token, invite }: { token: string; invite: InviteDetails }) {
	const router = useRouter();
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
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
			const failure = await submitInvite(token, password);
			if (failure) {
				setError(failure);
				return;
			}
			setDone(true);
			router.replace("/login");
		} catch {
			setError("Unable to reach the server. Please try again.");
		} finally {
			setLoading(false);
		}
	}

	return (
		<AuthShell
			icon={Mail}
			title="Set your password"
			description={`${invite.organizationName} created an account for ${invite.email}. Choose a password to finish.`}
		>
			<form method="post" onSubmit={onSubmit} className="space-y-5">
				<div className="space-y-2">
					<Label htmlFor="invite-email">Email</Label>
					<Input
						id="invite-email"
						value={invite.email}
						readOnly
						className="bg-neutral-50 text-neutral-500"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="invite-password">New password</Label>
					<Input
						id="invite-password"
						type="password"
						autoComplete="new-password"
						minLength={8}
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="invite-confirm">Confirm password</Label>
					<Input
						id="invite-confirm"
						type="password"
						autoComplete="new-password"
						minLength={8}
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
					{done ? "Password set" : loading ? "Saving..." : "Set password and sign in"}
				</Button>
			</form>
		</AuthShell>
	);
}
