import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Check, Globe2, RefreshCw, Trash2 } from "lucide-react";
import type { Domain } from "./types";

type MutationLike = { mutate: (id: string) => void; isPending: boolean };

type Props = {
  item: Domain;
  remove: MutationLike;
  reconcile: MutationLike;
  /** Id currently being reconciled, so only that card shows the spinner. */
  reconcilingId?: string | null;
  loadDns: (id: string) => void;
};

function formatChecked(value: string | null): string {
  if (!value) return "never checked";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "never checked";
  return `checked ${at.toLocaleString()}`;
}

export default function DomainItemCard({
  item,
  remove,
  reconcile,
  reconcilingId,
  loadDns,
}: Props) {
  const checking = reconcile.isPending && reconcilingId === item.id;

  return (
    <div className="flex flex-col gap-3 rounded-3xl bg-white p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600">
          <Globe2 className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-neutral-900">
            {item.hostname}
          </span>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge
              variant={
                item.status === "active"
                  ? "success"
                  : item.status === "error"
                    ? "destructive"
                    : "secondary"
              }
            >
              {item.status}
            </Badge>
            {item.routingEnabled && <Badge variant="outline">routing</Badge>}
            {item.sendingEnabled && <Badge variant="outline">sending</Badge>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => reconcile.mutate(item.id)}
            disabled={reconcile.isPending}
            aria-label={`Check ${item.hostname} now`}
          >
            <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
            {checking ? "Checking..." : "Check now"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => loadDns(item.id)}>
            DNS
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => remove.mutate(item.id)}
            disabled={remove.isPending}
            aria-label={`Remove ${item.hostname}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="flex items-center gap-1 text-neutral-500">
          DNS{" "}
          {item.dnsOk ? (
            <Check className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          )}
        </span>
        <span className="text-neutral-300">|</span>
        <span className="text-neutral-500">
          {formatChecked(item.lastCheckedAt)}
        </span>
      </div>
      {item.statusReason && (
        <p className="text-xs text-red-600">{item.statusReason}</p>
      )}
    </div>
  );
}
