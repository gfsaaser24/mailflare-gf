"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, UserCog } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { authFetch } from "@/lib/auth/client";
import { formatBytes, formatDate } from "@/components/platform/format";
import type { OrganizationSummary } from "@/components/platform/types";

export default function OrganizationDetailPage() {
	const params = useParams<{ id: string }>();
	const id = params.id;
	const qc = useQueryClient();

	/**
	 * `null` until the operator types: the form then owns the fields, and until
	 * then it simply shows whatever the server last returned. No effect needed to
	 * copy the query into state.
	 */
	const [draft, setDraft] = useState<{ name: string; notes: string } | null>(null);
	const [confirmStatus, setConfirmStatus] = useState<"active" | "suspended" | null>(null);
	const [impersonateError, setImpersonateError] = useState<string | null>(null);

	const org = useQuery({
		queryKey: ["platform", "orgs", id],
		queryFn: async () => {
			const response = await authFetch(`/api/platform/orgs/${id}`);
			const data = (await response.json()) as {
				organization?: OrganizationSummary;
				error?: string;
			};
			if (!response.ok || !data.organization) {
				throw new Error(data.error ?? "Unable to load organisation");
			}
			return data.organization;
		},
	});

	const patch = useMutation({
		mutationFn: async (body: Record<string, unknown>) => {
			const response = await authFetch(`/api/platform/orgs/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = (await response.json()) as {
				organization?: OrganizationSummary;
				error?: unknown;
			};
			if (!response.ok || !data.organization) {
				throw new Error(typeof data.error === "string" ? data.error : "Unable to save changes");
			}
			return data.organization;
		},
		onSuccess: (organization) => {
			setDraft(null);
			qc.setQueryData(["platform", "orgs", id], organization);
			void qc.invalidateQueries({ queryKey: ["platform", "orgs"] });
		},
	});

	const impersonate = useMutation({
		mutationFn: async () => {
			setImpersonateError(null);
			const response = await authFetch(`/api/platform/orgs/${id}/impersonate`, {
				method: "POST",
				redirectOnUnauthorized: false,
			});
			const data = (await response.json()) as { redirect?: string; error?: string };
			if (!response.ok) throw new Error(data.error ?? "Unable to impersonate");
			// Hard navigation: the session cookie now belongs to another user, so
			// every cached query and provider has to be rebuilt from scratch.
			window.location.href = data.redirect ?? "/inbox";
		},
		onError: (error) => setImpersonateError((error as Error).message),
	});

	if (org.isPending) return <p className="text-sm text-neutral-500">Loading...</p>;
	if (org.isError) {
		return (
			<div className="space-y-4">
				<p className="text-sm text-red-600">{(org.error as Error).message}</p>
				<Button asChild variant="outline">
					<Link href="/platform">Back to organisations</Link>
				</Button>
			</div>
		);
	}

	const organization = org.data;
	const suspended = organization.status === "suspended";
	const name = draft?.name ?? organization.name;
	const notes = draft?.notes ?? organization.notes ?? "";
	const dirty = draft !== null;

	return (
		<div className="space-y-6">
			<div>
				<Link
					href="/platform"
					className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900"
				>
					<ArrowLeft className="h-4 w-4" />
					Organisations
				</Link>
				<div className="mt-2 flex items-center justify-between gap-4">
					<div className="min-w-0">
						<h1 className="flex items-center gap-3 text-3xl font-medium text-neutral-900">
							<span className="truncate">{organization.name}</span>
							<Badge variant={suspended ? "destructive" : "success"}>
								{suspended ? "Suspended" : "Active"}
							</Badge>
						</h1>
						<p className="mt-2 text-sm text-neutral-500">
							{organization.slug} · created {formatDate(organization.createdAt)}
						</p>
					</div>
					<div className="flex shrink-0 gap-2">
						<Button
							variant="outline"
							onClick={() => impersonate.mutate()}
							disabled={impersonate.isPending}
						>
							<UserCog className="h-4 w-4" />
							{impersonate.isPending ? "Starting..." : "Impersonate"}
						</Button>
						<Button
							variant={suspended ? "default" : "destructive"}
							onClick={() => setConfirmStatus(suspended ? "active" : "suspended")}
						>
							{suspended ? "Restore" : "Suspend"}
						</Button>
					</div>
				</div>
				{impersonateError && <p className="mt-2 text-sm text-red-600">{impersonateError}</p>}
			</div>

			<div className="grid gap-3 sm:grid-cols-3">
				{[
					{ label: "Members", value: String(organization.counts.accounts) },
					{ label: "Mailboxes", value: String(organization.counts.mailboxes) },
					{ label: "Domains", value: String(organization.counts.domains) },
					{ label: "Stored", value: formatBytes(organization.counts.storageBytes) },
					{ label: "Sent today", value: String(organization.counts.sendsToday) },
				].map((stat) => (
					<div key={stat.label} className="rounded-3xl bg-white p-5">
						<p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
							{stat.label}
						</p>
						<p className="mt-1 text-2xl font-medium text-neutral-900">{stat.value}</p>
					</div>
				))}
			</div>

			<form
				className="space-y-4 rounded-3xl bg-white p-5"
				onSubmit={(event) => {
					event.preventDefault();
					patch.mutate({ name, notes: notes.trim() === "" ? null : notes });
				}}
			>
				<div className="space-y-2">
					<Label htmlFor="org-name">Name</Label>
					<Input
						id="org-name"
						value={name}
						onChange={(event) => setDraft({ name: event.target.value, notes })}
						maxLength={120}
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="org-notes">Notes</Label>
					<Textarea
						id="org-notes"
						value={notes}
						onChange={(event) => setDraft({ name, notes: event.target.value })}
						maxLength={10_000}
						rows={4}
					/>
				</div>
				{patch.isError && <p className="text-sm text-red-600">{(patch.error as Error).message}</p>}
				<div className="flex items-center gap-3">
					<Button type="submit" disabled={patch.isPending || !dirty}>
						{patch.isPending ? "Saving..." : "Save changes"}
					</Button>
					{patch.isSuccess && !dirty && <span className="text-sm text-neutral-500">Saved</span>}
				</div>
			</form>

			<div className="rounded-3xl bg-white p-5">
				<p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
					Audit trail
				</p>
				<p className="mt-2 text-sm text-neutral-500">
					Not available here yet. The only audit endpoint, <code>/api/audit-logs</code>, is scoped
					to the caller&apos;s own organisation (and filtered to sign-in events), so it cannot show
					another organisation&apos;s rows. Platform actions on this organisation
					(<code>platform.org_created</code>, <code>platform.org_suspended</code>,{" "}
					<code>platform.org_restored</code>, <code>platform.impersonate</code>) are written to{" "}
					<code>audit_logs</code> and will appear once a platform-plane audit endpoint exists.
				</p>
			</div>

			<Dialog open={confirmStatus !== null} onOpenChange={(open) => !open && setConfirmStatus(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{confirmStatus === "suspended" ? "Suspend organisation" : "Restore organisation"}
						</DialogTitle>
						<DialogDescription>
							{confirmStatus === "suspended"
								? `Suspend ${organization.name}? This is recorded in the audit log.`
								: `Restore ${organization.name} to active?`}
						</DialogDescription>
					</DialogHeader>
					<div className="flex justify-end gap-2">
						<Button variant="outline" onClick={() => setConfirmStatus(null)}>
							Cancel
						</Button>
						<Button
							variant={confirmStatus === "suspended" ? "destructive" : "default"}
							disabled={patch.isPending}
							onClick={() => {
								const status = confirmStatus;
								setConfirmStatus(null);
								if (status) patch.mutate({ status });
							}}
						>
							{confirmStatus === "suspended" ? "Suspend" : "Restore"}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}
