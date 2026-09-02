"use client";

/**
 * T6.3 — the delivery log of one webhook.
 *
 * Shows the last 50 attempts with their status, attempt count and last error,
 * lets an operator replay any of them, and badges dead-lettered rows so a
 * broken endpoint is obvious at a glance.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { authFetch } from "@/lib/auth/client";

export type Delivery = {
	id: string;
	eventType: string;
	status: string;
	attempts: number;
	lastError: string | null;
	responseStatus: number | null;
	nextAttemptAt: string | null;
	deliveredAt: string | null;
	createdAt: string;
};

function StatusBadge({ status }: { status: string }) {
	if (status === "delivered") return <Badge variant="success">Delivered</Badge>;
	if (status === "dead") return <Badge variant="destructive">Dead-letter</Badge>;
	return <Badge variant="secondary">Pending</Badge>;
}

function formatTime(value: string | null): string {
	if (!value) return "-";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

export function DeliveriesDrawer({
	webhookId,
	url,
	onClose,
}: {
	webhookId: string | null;
	url: string | null;
	onClose: () => void;
}) {
	const qc = useQueryClient();

	const { data, isLoading } = useQuery({
		queryKey: ["webhook-deliveries", webhookId],
		enabled: webhookId !== null,
		queryFn: async () => {
			const res = await authFetch(`/api/webhooks/${webhookId}/deliveries`);
			return (await res.json()) as { deliveries: Delivery[] };
		},
	});

	const retry = useMutation({
		mutationFn: async (deliveryId: string) => {
			const res = await authFetch(
				`/api/webhooks/${webhookId}/deliveries/${deliveryId}/retry`,
				{ method: "POST" },
			);
			if (!res.ok) throw new Error("Retry failed");
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["webhook-deliveries", webhookId] }),
	});

	const deliveries = data?.deliveries ?? [];

	return (
		<Dialog open={webhookId !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>Deliveries</DialogTitle>
					<DialogDescription className="break-all">{url ?? ""}</DialogDescription>
				</DialogHeader>

				{isLoading && <p className="text-sm text-neutral-500">Loading...</p>}
				{!isLoading && deliveries.length === 0 && (
					<p className="text-sm text-neutral-500">No deliveries yet.</p>
				)}

				{deliveries.length > 0 && (
					<div className="max-h-[60vh] overflow-auto">
						<table className="w-full text-left text-sm">
							<thead className="text-xs uppercase text-neutral-500">
								<tr>
									<th className="py-2 pr-3 font-medium">Event</th>
									<th className="py-2 pr-3 font-medium">Status</th>
									<th className="py-2 pr-3 font-medium">Attempts</th>
									<th className="py-2 pr-3 font-medium">HTTP</th>
									<th className="py-2 pr-3 font-medium">When</th>
									<th className="py-2 pr-3 font-medium">Last error</th>
									<th className="py-2" />
								</tr>
							</thead>
							<tbody>
								{deliveries.map((delivery) => (
									<tr key={delivery.id} className="border-t border-neutral-200">
										<td className="py-2 pr-3 whitespace-nowrap">{delivery.eventType}</td>
										<td className="py-2 pr-3">
											<StatusBadge status={delivery.status} />
										</td>
										<td className="py-2 pr-3">{delivery.attempts}</td>
										<td className="py-2 pr-3">{delivery.responseStatus ?? "-"}</td>
										<td className="py-2 pr-3 whitespace-nowrap text-neutral-500">
											{formatTime(delivery.deliveredAt ?? delivery.createdAt)}
										</td>
										<td className="py-2 pr-3 max-w-xs truncate text-neutral-500">
											{delivery.lastError ?? "-"}
										</td>
										<td className="py-2 text-right">
											<Button
												variant="outline"
												size="sm"
												disabled={retry.isPending}
												onClick={() => retry.mutate(delivery.id)}
											>
												Retry
											</Button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
