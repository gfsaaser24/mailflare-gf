"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailWarning, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { authFetch } from "@/lib/auth/client";

type InboundFailure = {
  id: string;
  rawR2Key: string;
  mailboxId: string | null;
  fromAddr: string;
  toAddr: string;
  error: string | null;
  attempts: number;
  createdAt: string;
  resolvedAt: string | null;
};

async function fetchInboundFailures(): Promise<InboundFailure[]> {
  const response = await authFetch("/api/admin/inbound-failures?includeResolved=true");
  const data = (await response.json()) as { failures?: InboundFailure[]; error?: string };
  if (!response.ok) throw new Error(data.error ?? "Failed to load inbound failures");
  return data.failures ?? [];
}

async function retryInboundFailure(id: string): Promise<void> {
  const response = await authFetch(`/api/admin/inbound-failures/${id}/retry`, { method: "POST" });
  const data = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Retry failed");
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

export default function InboundFailuresPage() {
  const queryClient = useQueryClient();
  const failures = useQuery({ queryKey: ["inbound-failures"], queryFn: fetchInboundFailures });
  const retry = useMutation({
    mutationFn: retryInboundFailure,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["inbound-failures"] }),
  });
  const error = failures.error || retry.error;
  const rows = failures.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-medium text-neutral-900">Inbound Failures</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Messages whose raw copy was stored but could not be processed. Retry re-runs
            processing from the stored raw object.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={failures.isFetching}
          onClick={() => void failures.refetch()}
        >
          <RefreshCw className={`h-4 w-4 ${failures.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error instanceof Error ? error.message : "Inbound failure operation failed"}
        </p>
      )}

      <section className="overflow-hidden rounded-3xl bg-white">
        <div className="flex items-center gap-3 border-b border-neutral-100 px-4 py-4">
          <MailWarning className="h-5 w-5 text-neutral-500" />
          <h2 className="font-semibold text-neutral-900">Failures</h2>
        </div>
        <div className="grid grid-cols-[1fr_1fr_90px_170px_110px] gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          <span>Recipient</span>
          <span>Error</span>
          <span>Attempts</span>
          <span>Created</span>
          <span>Actions</span>
        </div>
        {failures.isLoading && <SkeletonRows count={5} />}
        {!failures.isLoading && rows.length === 0 && (
          <p className="px-4 py-6 text-sm text-neutral-500">No inbound failures.</p>
        )}
        {rows.map((failure) => (
          <div
            key={failure.id}
            className="grid grid-cols-[1fr_1fr_90px_170px_110px] items-center gap-4 border-b border-neutral-100 px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-neutral-900">{failure.toAddr}</p>
              <p className="truncate text-xs text-neutral-500">from {failure.fromAddr}</p>
              <p className="truncate text-xs text-neutral-400">{failure.rawR2Key}</p>
            </div>
            <div className="min-w-0">
              {failure.resolvedAt ? (
                <Badge variant="outline" className="border-green-200 bg-green-50 text-green-700">
                  resolved {formatDate(failure.resolvedAt)}
                </Badge>
              ) : (
                <p className="truncate text-sm text-red-700" title={failure.error ?? ""}>
                  {failure.error ?? "Unknown error"}
                </p>
              )}
            </div>
            <span className="text-sm text-neutral-600">{failure.attempts}</span>
            <span className="text-sm text-neutral-600">{formatDate(failure.createdAt)}</span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={retry.isPending || failure.resolvedAt !== null}
                onClick={() => retry.mutate(failure.id)}
              >
                Retry
              </Button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
