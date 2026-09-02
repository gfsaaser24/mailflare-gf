/**
 * `/invite/[token]` — the set-password page an invited user lands on (T3.5).
 *
 * No session is required, so nothing here goes through `AuthGuard`: the token in
 * the URL is the only credential, and it is checked server-side before the form
 * is rendered.
 */
import Link from "next/link";
import { Mail } from "lucide-react";
import { getDb } from "@/db";
import { findUsableInvite } from "@/lib/accounts/service";
import { getEnv } from "@/lib/cloudflare";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { InviteClient } from "./invite-client";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
	const { token } = await params;
	const invite = await findUsableInvite(getDb(getEnv()), token);

	if (!invite) {
		return (
			<AuthShell
				icon={Mail}
				title="This invite has expired"
				description="The link has already been used, or it is more than seven days old. Ask an administrator to send a new one."
			>
				<Button asChild className="h-11 w-full rounded-full px-6">
					<Link href="/login">Go to sign in</Link>
				</Button>
			</AuthShell>
		);
	}

	return (
		<InviteClient
			token={token}
			invite={{
				email: invite.email,
				name: invite.name,
				organizationName: invite.organizationName,
			}}
		/>
	);
}
