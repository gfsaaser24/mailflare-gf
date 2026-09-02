"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { CardGridSkeleton } from "@/components/page-skeletons";
import { authFetch } from "@/lib/auth/client";
import { SCOPES } from "@/lib/api/scopes";
import type { ApiKey } from "./types";
import { parseApiKeyScopes } from "./utils";

/** The expiry choices offered in the create dialog; "" means never. */
const EXPIRY_OPTIONS = [
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
	{ value: "365", label: "365 days" },
	{ value: "", label: "Never" },
] as const;

function isExpired(key: ApiKey): boolean {
	return !!key.expiresAt && new Date(key.expiresAt).getTime() < Date.now();
}

export default function ApiKeysPage() {
	const qc = useQueryClient();
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<string[]>([]);
	const [expiresIn, setExpiresIn] = useState<string>("90");
	const [newKey, setNewKey] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);

	const { data, isLoading } = useQuery({
		queryKey: ["api-keys"],
		queryFn: async () => {
			const res = await authFetch("/api/api-keys");
			return (await res.json()) as { apiKeys: ApiKey[] };
		},
	});

	const toggleScope = (scope: string) => {
		setScopes((current) =>
			current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
		);
	};

	const create = useMutation({
		mutationFn: async () => {
			const res = await authFetch("/api/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					scopes,
					...(expiresIn ? { expiresInDays: Number(expiresIn) } : {}),
				}),
			});
			const json = (await res.json()) as { key?: string };
			if (!res.ok) throw new Error("Failed");
			setNewKey(json.key ?? null);
			setName("");
			setScopes([]);
		},
		onSuccess: () => {
			setCreateOpen(false);
			qc.invalidateQueries({ queryKey: ["api-keys"] });
		},
	});

	const revoke = useMutation({
		mutationFn: async (id: string) => {
			const res = await authFetch(`/api/api-keys/${id}`, { method: "DELETE" });
			if (!res.ok) throw new Error("Failed to revoke key");
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
	});

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between gap-4">
				<h1 className="text-2xl font-semibold">API Keys</h1>
				<Dialog open={createOpen} onOpenChange={setCreateOpen}>
					<DialogTrigger asChild>
						<Button>
							<Plus className="h-4 w-4" />
							New API key
						</Button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Create API key</DialogTitle>
							<DialogDescription>
								Pick only the permissions the key needs. The key is shown once.
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-4">
							<div className="space-y-2">
								<Label>Name</Label>
								<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production app" />
							</div>
							<div className="space-y-2">
								<Label>Permissions</Label>
								<div className="space-y-2">
									{SCOPES.map((scope) => (
										<label key={scope.name} className="flex items-start gap-2 text-sm">
											<Checkbox
												className="mt-0.5"
												checked={scopes.includes(scope.name)}
												onChange={() => toggleScope(scope.name)}
											/>
											<span>
												<span className="block font-medium text-neutral-900">{scope.name}</span>
												<span className="block text-neutral-500">{scope.description}</span>
											</span>
										</label>
									))}
								</div>
							</div>
							<div className="space-y-2">
								<Label>Expires</Label>
								<Select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)}>
									{EXPIRY_OPTIONS.map((option) => (
										<option key={option.label} value={option.value}>
											{option.label}
										</option>
									))}
								</Select>
							</div>
							{create.isError && (
								<p className="text-sm text-red-600">{(create.error as Error).message}</p>
							)}
							<Button
								onClick={() => create.mutate()}
								disabled={!name || scopes.length === 0 || create.isPending}
							>
								{create.isPending ? "Creating..." : "Create key"}
							</Button>
						</div>
					</DialogContent>
				</Dialog>
			</div>
			{newKey && (
				<Card className="border-blue-600/10 bg-blue-400/10">
					<CardContent className="pt-6">
						<p className="text-sm font-medium text-blue-600">Copy your key now:</p>
						<code className="block mt-2 text-xs break-all font-bold">{newKey}</code>
					</CardContent>
				</Card>
			)}
			<section className="space-y-3">
				<div className="flex items-center justify-between">
					<span className="text-sm text-neutral-500">{(data?.apiKeys ?? []).length} total</span>
				</div>
				{isLoading && (
					<CardGridSkeleton />
				)}
				{!isLoading && (data?.apiKeys ?? []).length === 0 && (
					<p className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-500">
						No API keys yet
					</p>
				)}
				<div className="grid gap-3">
					{(data?.apiKeys ?? []).map((key) => (
						<div
							key={key.id}
							className="flex min-h-24 items-start gap-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm shadow-neutral-100"
						>
							<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600">
								<KeyRound className="h-5 w-5" />
							</span>
							<span className="min-w-0 flex-1 space-y-2">
								<span className="flex flex-wrap items-center gap-2">
									<span className="truncate text-sm font-semibold text-neutral-900">{key.name}</span>
									{key.revokedAt && <Badge variant="destructive">Revoked</Badge>}
									{!key.revokedAt && isExpired(key) && <Badge variant="destructive">Expired</Badge>}
								</span>
								<span className="block truncate no-font-mono text-sm text-neutral-500">{key.prefix}...</span>
								<span className="flex flex-wrap gap-1">
									{parseApiKeyScopes(key.scopes).map((scope) => (
										<Badge key={scope} variant="outline">
											{scope}
										</Badge>
									))}
								</span>
								<span className="block text-xs text-neutral-500">
									{key.expiresAt
										? `Expires ${new Date(key.expiresAt).toLocaleDateString()}`
										: "Never expires"}
								</span>
							</span>
							{!key.revokedAt && (
								<Button
									variant="ghost"
									size="sm"
									disabled={revoke.isPending}
									onClick={() => {
										if (!window.confirm(`Revoke "${key.name}"? This cannot be undone.`)) return;
										revoke.mutate(key.id);
									}}
								>
									<Trash2 className="h-4 w-4" />
									Revoke
								</Button>
							)}
						</div>
					))}
				</div>
			</section>
		</div>
	);
}
