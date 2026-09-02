"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/auth/client";
import { formatBytes } from "@/components/platform/format";
import type { OrganizationSummary, PlatformSearchHit } from "@/components/platform/types";

/** Cheap in-component debounce; the search endpoint runs two ILIKE scans. */
function useDebounced(value: string, delay = 250): string {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = window.setTimeout(() => setDebounced(value), delay);
		return () => window.clearTimeout(timer);
	}, [value, delay]);
	return debounced;
}

export default function PlatformOrgsPage() {
	const [query, setQuery] = useState("");
	const term = useDebounced(query.trim());

	const orgs = useQuery({
		queryKey: ["platform", "orgs"],
		queryFn: async () => {
			const response = await authFetch("/api/platform/orgs");
			const data = (await response.json()) as {
				organizations?: OrganizationSummary[];
				error?: string;
			};
			if (!response.ok) throw new Error(data.error ?? "Unable to load organisations");
			return data.organizations ?? [];
		},
	});

	const search = useQuery({
		queryKey: ["platform", "search", term],
		enabled: term.length > 0,
		queryFn: async () => {
			const response = await authFetch(`/api/platform/search?q=${encodeURIComponent(term)}`);
			const data = (await response.json()) as { results?: PlatformSearchHit[]; error?: string };
			if (!response.ok) throw new Error(data.error ?? "Search failed");
			return data.results ?? [];
		},
	});

	const organizations = orgs.data ?? [];
	const byId = new Map(organizations.map((org) => [org.id, org]));

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between gap-4">
				<div>
					<h1 className="text-3xl font-medium text-neutral-900">Organisations</h1>
					<p className="mt-2 text-sm text-neutral-500">
						Every tenant on this deployment, with live usage.
					</p>
				</div>
				<Button asChild>
					<Link href="/platform/orgs/new">
						<Plus className="h-4 w-4" />
						New organisation
					</Link>
				</Button>
			</div>

			<div className="relative">
				<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search mailboxes and domains across every organisation"
					className="h-11 rounded-2xl bg-white pl-9"
					aria-label="Global search"
				/>
			</div>

			{term.length > 0 && (
				<div className="rounded-3xl bg-white p-5">
					<p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
						Search results
					</p>
					{search.isPending && <p className="text-sm text-neutral-500">Searching...</p>}
					{search.isError && (
						<p className="text-sm text-red-600">{(search.error as Error).message}</p>
					)}
					{search.data?.length === 0 && (
						<p className="text-sm text-neutral-500">No mailbox or domain matches.</p>
					)}
					<div className="grid gap-1">
						{(search.data ?? []).map((hit) => (
							<Link
								key={`${hit.type}-${hit.id}`}
								href={`/platform/orgs/${hit.organizationId}`}
								className="flex items-center gap-3 rounded-xl px-2 py-2 text-sm transition-colors hover:bg-blue-50/60"
							>
								<Badge variant="outline">{hit.type}</Badge>
								<span className="min-w-0 flex-1 truncate text-neutral-900">{hit.label}</span>
								<span className="truncate text-xs text-neutral-500">
									{byId.get(hit.organizationId)?.name ?? hit.organizationId}
								</span>
							</Link>
						))}
					</div>
				</div>
			)}

			<div className="grid gap-3">
				{orgs.isPending && <p className="text-sm text-neutral-500">Loading...</p>}
				{orgs.isError && <p className="text-sm text-red-600">{(orgs.error as Error).message}</p>}
				{orgs.isSuccess && organizations.length === 0 && (
					<p className="text-sm text-neutral-500">No organisations yet.</p>
				)}
				{organizations.map((org) => (
					<Link
						key={org.id}
						href={`/platform/orgs/${org.id}`}
						className="rounded-3xl bg-white p-5 transition-colors hover:bg-blue-50/40"
					>
						<span className="flex items-center gap-2">
							<span className="truncate font-semibold text-neutral-900">{org.name}</span>
							<span className="truncate text-sm text-neutral-500">{org.slug}</span>
							{org.status === "suspended" && <Badge variant="destructive">Suspended</Badge>}
						</span>
						<span className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-500">
							<span>{org.counts.accounts} members</span>
							<span>{org.counts.mailboxes} mailboxes</span>
							<span>{org.counts.domains} domains</span>
							<span>{formatBytes(org.counts.storageBytes)} stored</span>
							<span>{org.counts.sendsToday} sent today</span>
						</span>
					</Link>
				))}
			</div>
		</div>
	);
}
