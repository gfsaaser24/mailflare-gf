"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { authFetch } from "@/lib/auth/client";
import { QUOTA_TEMPLATES, type CreateOrganizationResponse, type QuotaTemplate } from "@/components/platform/types";

/** Same shape the API validates: lowercase alphanumerics and dashes. */
function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function errorMessage(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (payload && typeof payload === "object") {
		const flattened = payload as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
		const field = Object.entries(flattened.fieldErrors ?? {})
			.map(([key, messages]) => `${key}: ${messages.join(", ")}`)
			.join("; ");
		const form = (flattened.formErrors ?? []).join("; ");
		const combined = [form, field].filter(Boolean).join("; ");
		if (combined) return combined;
	}
	return "Unable to create organisation";
}

export default function NewOrganizationPage() {
	const qc = useQueryClient();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [slugTouched, setSlugTouched] = useState(false);
	const [quotaTemplate, setQuotaTemplate] = useState<QuotaTemplate>("standard");
	const [adminEmail, setAdminEmail] = useState("");
	const [adminName, setAdminName] = useState("");
	const [copied, setCopied] = useState(false);

	const create = useMutation<CreateOrganizationResponse>({
		mutationFn: async () => {
			const response = await authFetch("/api/platform/orgs", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, slug, quotaTemplate, adminEmail, adminName }),
			});
			const data = (await response.json()) as CreateOrganizationResponse & { error?: unknown };
			if (!response.ok) throw new Error(errorMessage(data.error));
			return data;
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["platform", "orgs"] }),
	});

	async function copyPassword() {
		if (!create.data) return;
		try {
			await navigator.clipboard.writeText(create.data.temporaryPassword);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		} catch {
			setCopied(false);
		}
	}

	if (create.isSuccess && create.data) {
		const result = create.data;
		return (
			<div className="space-y-6">
				<div>
					<h1 className="text-3xl font-medium text-neutral-900">{result.organization.name}</h1>
					<p className="mt-2 text-sm text-neutral-500">
						Organisation created with admin {result.admin.email}.
					</p>
				</div>

				<div className="rounded-3xl bg-white p-5">
					<p className="flex items-center gap-2 text-sm font-semibold text-amber-700">
						<TriangleAlert className="h-4 w-4" />
						This password is shown once
					</p>
					<p className="mt-2 text-sm text-neutral-500">
						{result.passwordDeliveryNote ??
							"There is no password-reset flow yet. Copy it now and hand it to the new admin out of band."}
					</p>
					<div className="mt-4 flex items-center gap-2">
						<code className="min-w-0 flex-1 truncate rounded-xl bg-neutral-100 px-3 py-2 text-sm">
							{result.temporaryPassword}
						</code>
						<Button type="button" variant="outline" onClick={copyPassword}>
							{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
							{copied ? "Copied" : "Copy"}
						</Button>
					</div>
					{result.quotaTemplate && (
						<p className="mt-4 text-xs text-neutral-500">
							Quota template <span className="font-medium">{result.quotaTemplate}</span> was
							recorded on the audit row; quotas are not enforced yet.
						</p>
					)}
				</div>

				<div className="flex gap-2">
					<Button asChild>
						<Link href={`/platform/orgs/${result.organization.id}`}>Open organisation</Link>
					</Button>
					<Button asChild variant="outline">
						<Link href="/platform">Back to organisations</Link>
					</Button>
				</div>
			</div>
		);
	}

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
				<h1 className="mt-2 text-3xl font-medium text-neutral-900">New organisation</h1>
				<p className="mt-2 text-sm text-neutral-500">
					Creates the organisation and its first admin account.
				</p>
			</div>

			<form
				className="space-y-4 rounded-3xl bg-white p-5"
				onSubmit={(event) => {
					event.preventDefault();
					create.mutate();
				}}
			>
				<div className="space-y-2">
					<Label htmlFor="org-name">Name</Label>
					<Input
						id="org-name"
						value={name}
						onChange={(event) => {
							setName(event.target.value);
							if (!slugTouched) setSlug(slugify(event.target.value));
						}}
						maxLength={120}
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="org-slug">Slug</Label>
					<Input
						id="org-slug"
						value={slug}
						onChange={(event) => {
							setSlugTouched(true);
							setSlug(slugify(event.target.value));
						}}
						pattern="[a-z0-9][a-z0-9-]*"
						maxLength={64}
						required
					/>
					<p className="text-xs text-neutral-500">Filled in from the name until you edit it.</p>
				</div>
				<div className="space-y-2">
					<Label htmlFor="org-quota">Quota template</Label>
					<Select
						id="org-quota"
						value={quotaTemplate}
						onChange={(event) => setQuotaTemplate(event.target.value as QuotaTemplate)}
						className="h-10 w-full bg-white text-sm"
					>
						{QUOTA_TEMPLATES.map((template) => (
							<option key={template} value={template}>
								{template}
							</option>
						))}
					</Select>
				</div>
				<div className="space-y-2">
					<Label htmlFor="org-admin-name">Admin name</Label>
					<Input
						id="org-admin-name"
						value={adminName}
						onChange={(event) => setAdminName(event.target.value)}
						maxLength={120}
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="org-admin-email">Admin email</Label>
					<Input
						id="org-admin-email"
						type="email"
						value={adminEmail}
						onChange={(event) => setAdminEmail(event.target.value)}
						required
					/>
				</div>
				{create.isError && (
					<p className="text-sm text-red-600">{(create.error as Error).message}</p>
				)}
				<Button type="submit" disabled={create.isPending}>
					{create.isPending ? "Creating..." : "Create organisation"}
				</Button>
			</form>
		</div>
	);
}
