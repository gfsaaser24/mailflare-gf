"use client";

/**
 * T6.3 — webhook endpoints.
 *
 * Create an endpoint (url + description + the events it subscribes to), toggle
 * it on and off, delete it, and open its delivery log. The event list comes
 * from the shared catalogue, so this page never drifts from the API.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { authFetch } from "@/lib/auth/client";
import {
	WEBHOOK_EVENTS,
	WEBHOOK_EVENT_LABELS,
	parseSubscribedEvents,
	type WebhookEventType,
} from "@/lib/webhooks/events";
import { DeliveriesDrawer } from "./deliveries-drawer";

type Webhook = {
	id: string;
	url: string;
	/** JSON array, as stored. */
	events: string;
	description: string | null;
	enabled: boolean;
};

const DEFAULT_EVENTS: WebhookEventType[] = ["message.inbound", "message.outbound"];

export default function WebhooksPage() {
	const qc = useQueryClient();
	const [url, setUrl] = useState("");
	const [description, setDescription] = useState("");
	const [events, setEvents] = useState<WebhookEventType[]>(DEFAULT_EVENTS);
	const [secret, setSecret] = useState<string | null>(null);
	const [openDeliveries, setOpenDeliveries] = useState<Webhook | null>(null);

	const { data } = useQuery({
		queryKey: ["webhooks"],
		queryFn: async () => {
			const res = await authFetch("/api/webhooks");
			return (await res.json()) as { webhooks: Webhook[] };
		},
	});

	const invalidate = () => qc.invalidateQueries({ queryKey: ["webhooks"] });

	const create = useMutation({
		mutationFn: async () => {
			const res = await authFetch("/api/webhooks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					url,
					events,
					description: description.trim() === "" ? null : description.trim(),
				}),
			});
			const json = (await res.json()) as { secret?: string };
			if (!res.ok) throw new Error("Failed");
			setSecret(json.secret ?? null);
			setUrl("");
			setDescription("");
			setEvents(DEFAULT_EVENTS);
		},
		onSuccess: invalidate,
	});

	const update = useMutation({
		mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
			const res = await authFetch(`/api/webhooks/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!res.ok) throw new Error("Failed");
		},
		onSuccess: invalidate,
	});

	const remove = useMutation({
		mutationFn: async (id: string) => {
			const res = await authFetch(`/api/webhooks/${id}`, { method: "DELETE" });
			if (!res.ok) throw new Error("Failed");
		},
		onSuccess: invalidate,
	});

	const toggleEvent = (event: WebhookEventType) => {
		setEvents((current) =>
			current.includes(event) ? current.filter((e) => e !== event) : [...current, event],
		);
	};

	return (
		<div className="space-y-6 max-w-3xl">
			<h1 className="text-2xl font-semibold">Webhooks</h1>

			{secret && (
				<Card>
					<CardContent className="pt-6 text-sm">
						<p>Signing secret (shown once, store it now):</p>
						<code className="block mt-1 text-xs break-all">{secret}</code>
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<CardTitle>Add webhook</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="webhook-url">URL</Label>
						<Input
							id="webhook-url"
							value={url}
							placeholder="https://example.com/hooks/mailflare"
							onChange={(e) => setUrl(e.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="webhook-description">Description</Label>
						<Input
							id="webhook-description"
							value={description}
							placeholder="What this endpoint is for"
							onChange={(e) => setDescription(e.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label>Events</Label>
						<div className="space-y-2">
							{WEBHOOK_EVENTS.map((event) => (
								<label key={event} className="flex items-start gap-2 text-sm">
									<Checkbox
										className="mt-0.5"
										checked={events.includes(event)}
										onChange={() => toggleEvent(event)}
									/>
									<span>
										<code className="text-xs">{event}</code>
										<span className="block text-xs text-neutral-500">
											{WEBHOOK_EVENT_LABELS[event]}
										</span>
									</span>
								</label>
							))}
						</div>
					</div>
					<Button
						onClick={() => create.mutate()}
						disabled={!url || events.length === 0 || create.isPending}
					>
						Add
					</Button>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Endpoints</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4 text-sm">
					{(data?.webhooks ?? []).length === 0 && (
						<p className="text-neutral-500">No endpoints yet.</p>
					)}
					{(data?.webhooks ?? []).map((hook) => (
						<div
							key={hook.id}
							className="flex items-start justify-between gap-4 border-t border-neutral-200 pt-4 first:border-t-0 first:pt-0"
						>
							<div className="min-w-0 space-y-1">
								<p className="truncate font-medium">{hook.url}</p>
								{hook.description && (
									<p className="truncate text-xs text-neutral-500">{hook.description}</p>
								)}
								<p className="text-xs text-neutral-500">
									{parseSubscribedEvents(hook.events).join(", ") || "no events"}
								</p>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								<Switch
									checked={hook.enabled}
									disabled={update.isPending}
									onCheckedChange={(enabled) => update.mutate({ id: hook.id, enabled })}
								/>
								<Button variant="outline" size="sm" onClick={() => setOpenDeliveries(hook)}>
									Deliveries
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={remove.isPending}
									onClick={() => remove.mutate(hook.id)}
								>
									Delete
								</Button>
							</div>
						</div>
					))}
				</CardContent>
			</Card>

			<DeliveriesDrawer
				webhookId={openDeliveries?.id ?? null}
				url={openDeliveries?.url ?? null}
				onClose={() => setOpenDeliveries(null)}
			/>
		</div>
	);
}
