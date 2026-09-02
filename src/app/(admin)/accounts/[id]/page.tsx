"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { ManagedAccount, TransferTarget } from "./types";
import {
	fetchManagedAccount,
	fetchTransferTargets,
	resendManagedAccountInvite,
	saveManagedAccount,
	transferManagedAccount,
	uploadManagedAccountAvatar,
} from "./utils";

export default function AccountDetailsPage() {
	const { id } = useParams<{ id: string }>();
	const [account, setAccount] = useState<ManagedAccount | null>(null);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [avatarVersion, setAvatarVersion] = useState(0);
	const [targets, setTargets] = useState<TransferTarget[]>([]);
	const [transferTo, setTransferTo] = useState("");
	const [transferring, setTransferring] = useState(false);
	const [inviting, setInviting] = useState(false);
	const [inviteUrl, setInviteUrl] = useState<string | null>(null);

	useEffect(() => {
		void fetchManagedAccount(id)
			.then(setAccount)
			.catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load account"));
		void fetchTransferTargets(id)
			.then(setTargets)
			.catch(() => setTargets([]));
	}, [id]);

	async function resendInvite() {
		setInviting(true);
		setMessage(null);
		setInviteUrl(null);
		try {
			const result = await resendManagedAccountInvite(id);
			if (result.inviteSent) {
				setMessage("Invite emailed. The link works once and expires in 7 days.");
			} else {
				setInviteUrl(result.inviteUrl ?? null);
				setMessage(result.inviteMessage ?? "The invite was not emailed; copy the link below.");
			}
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Unable to send the invite");
		} finally {
			setInviting(false);
		}
	}

	async function transferOwnership() {
		if (!transferTo) return;
		setTransferring(true);
		setMessage(null);
		try {
			await transferManagedAccount(id, transferTo);
			setMessage("Ownership transferred.");
			setTransferTo("");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Unable to transfer ownership");
		} finally {
			setTransferring(false);
		}
	}

	async function saveDetails() {
		if (!account) return;
		setSaving(true);
		setMessage(null);
		try {
			await saveManagedAccount(account);
			setMessage("Account details updated");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Unable to update account");
		} finally {
			setSaving(false);
		}
	}

	async function uploadAvatar(file: File | undefined) {
		if (!file || !account) return;
		try {
			await uploadManagedAccountAvatar(account.id, file);
			setAccount({ ...account, hasAvatar: true });
			setAvatarVersion(Date.now());
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Unable to update avatar");
		}
	}

	if (!account) return <p className="text-sm text-neutral-500">{message ?? "Loading account..."}</p>;

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-3xl font-medium text-neutral-900">Details</h1>
				<p className="mt-2 text-sm text-neutral-500">Update this account&apos;s profile and status.</p>
			</div>
			<section className="space-y-5 rounded-3xl bg-white p-6">
				<div className="flex items-center gap-4">
					<span className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-blue-100 text-xl font-semibold text-blue-700">
						{account.name.charAt(0).toUpperCase()}
						{account.hasAvatar && (
							<img src={`/api/accounts/${id}/avatar?v=${avatarVersion}`} alt="" className="absolute inset-0 h-full w-full object-cover" />
						)}
					</span>
					<Label className="cursor-pointer">
						<span className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 px-3 text-sm">
							<Upload className="h-4 w-4" />
							Change avatar
						</span>
						<Input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" onChange={(event) => void uploadAvatar(event.target.files?.[0])} />
					</Label>
				</div>
				<div className="space-y-2">
					<Label htmlFor="account-email">Email</Label>
					<Input id="account-email" value={account.email} readOnly className="bg-neutral-50 text-neutral-500" />
				</div>
				<div className="space-y-2">
					<Label htmlFor="account-name">Name</Label>
					<Input id="account-name" value={account.name} onChange={(event) => setAccount({ ...account, name: event.target.value })} />
				</div>
				<div className="space-y-2">
					<Label htmlFor="forwarding-email">Forwarding email (optional)</Label>
					<Input
						id="forwarding-email"
						type="email"
						value={account.forwardingEmail ?? ""}
						onChange={(event) => setAccount({ ...account, forwardingEmail: event.target.value || null })}
						placeholder="destination@example.com"
					/>
					<p className="text-xs leading-5 text-neutral-500">
						Incoming mail will also be sent to this verified Cloudflare Email Routing destination.
					</p>
				</div>
				<label className="flex items-center gap-3 text-sm">
					<Checkbox checked={!account.disabled} onChange={(event) => setAccount({ ...account, disabled: !event.target.checked })} />
					Account enabled
				</label>
				<Button onClick={() => void saveDetails()} disabled={saving || !account.name.trim()}>
					{saving ? "Saving..." : "Save details"}
				</Button>
			</section>
			<section className="space-y-5 rounded-3xl bg-white p-6">
				<div>
					<h2 className="text-lg font-medium text-neutral-900">Access</h2>
					<p className="mt-1 text-sm text-neutral-500">
						Send a fresh set-password link, or hand this account&apos;s mailboxes and
						conversations to somebody else before you disable it.
					</p>
				</div>
				<div className="space-y-2">
					<Button variant="outline" onClick={() => void resendInvite()} disabled={inviting || account.disabled}>
						{inviting ? "Sending..." : "Resend invite"}
					</Button>
					{inviteUrl && (
						<code className="block truncate rounded-xl bg-neutral-100 px-3 py-2 text-sm">
							{inviteUrl}
						</code>
					)}
				</div>
				<div className="space-y-2">
					<Label htmlFor="transfer-to">Transfer ownership...</Label>
					<div className="flex gap-2">
						<Select
							id="transfer-to"
							value={transferTo}
							onChange={(event) => setTransferTo(event.target.value)}
							className="h-10 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm"
						>
							<option value="">Select an account</option>
							{targets.map((target) => (
								<option key={target.id} value={target.id}>
									{target.name} ({target.email})
								</option>
							))}
						</Select>
						<Button variant="outline" onClick={() => void transferOwnership()} disabled={transferring || !transferTo}>
							{transferring ? "Transferring..." : "Transfer"}
						</Button>
					</div>
				</div>
			</section>
			{message && <p className="text-sm text-neutral-500">{message}</p>}
		</div>
	);
}
