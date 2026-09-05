"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Bot, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ManagedAccount, ManagedDomain, ManagedMailbox } from "../types";

/**
 * `GET /api/accounts/[id]/mailboxes` also returns the agent-mail flag. The
 * shared `ManagedMailbox` type is used by screens that do not care about it, so
 * it is widened here rather than there.
 */
type AccountMailbox = ManagedMailbox & { agentMail?: boolean };
import {
  addManagedMailbox,
  fetchManagedAccount,
  fetchManagedDomains,
  fetchManagedMailboxes,
  removeManagedMailbox,
} from "../utils";

export default function AccountMailboxesPage() {
  const { id } = useParams<{ id: string }>();
  const [account, setAccount] = useState<ManagedAccount | null>(null);
  const [mailboxes, setMailboxes] = useState<AccountMailbox[]>([]);
  const [domains, setDomains] = useState<ManagedDomain[]>([]);
  const [localPart, setLocalPart] = useState("");
  const [domainId, setDomainId] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const [nextAccount, nextMailboxes, nextDomains] = await Promise.all([
      fetchManagedAccount(id),
      fetchManagedMailboxes(id),
      fetchManagedDomains(),
    ]);
    setAccount(nextAccount);
    setMailboxes(nextMailboxes);
    setDomains(nextDomains);
    setDomainId((current) => current || nextDomains[0]?.id || "");
  }

  useEffect(() => {
    void load().catch((error) =>
      setMessage(
        error instanceof Error ? error.message : "Unable to load mailboxes",
      ),
    );
  }, [id]);

  async function addMailbox(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account) return;
    setSaving(true);
    setMessage(null);
    try {
      await addManagedMailbox(account, { domainId, localPart });
      setLocalPart("");
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to add mailbox",
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeMailbox(mailboxId: string) {
    setMessage(null);
    try {
      await removeManagedMailbox(mailboxId);
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to remove mailbox",
      );
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-medium text-neutral-900">Mailboxes</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Manage inboxes owned by {account?.name ?? "this account"}.
        </p>
      </div>
      <section className="space-y-4 rounded-3xl bg-white p-6">
        <div className="space-y-2">
          {mailboxes.map((mailbox) => (
            <div
              key={mailbox.id}
              className="flex items-center justify-between rounded-2xl bg-neutral-50 px-4 py-3"
            >
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="block truncate font-medium">
                    {mailbox.displayName || mailbox.localPart}
                  </span>
                  {mailbox.agentMail && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
                      <Bot className="h-3 w-3" />
                      Agent mail
                    </span>
                  )}
                </span>
                <span className="block truncate text-sm text-neutral-500">
                  {mailbox.localPart}@{mailbox.hostname}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => void removeMailbox(mailbox.id)}
                aria-label="Remove inbox"
              >
                <Trash2 className="h-4 w-4 text-red-600" />
              </Button>
            </div>
          ))}
          {account && mailboxes.length === 0 && (
            <p className="text-sm text-neutral-500">No mailboxes yet.</p>
          )}
        </div>
        <form onSubmit={addMailbox} className="flex gap-2">
          <Input
            value={localPart}
            onChange={(event) => setLocalPart(event.target.value)}
            placeholder="inbox"
            required
          />
          <Select
            value={domainId}
            onChange={(event) => setDomainId(event.target.value)}
            className="rounded-md border border-neutral-200 bg-white px-3 text-sm"
          >
            {domains.map((domain) => (
              <option key={domain.id} value={domain.id}>
                @{domain.hostname}
              </option>
            ))}
          </Select>
          <Button type="submit" disabled={!account || !domainId || saving}>
            <Plus className="h-4 w-4" />
            {saving ? "Adding..." : "Add inbox"}
          </Button>
        </form>
      </section>
      {message && <p className="text-sm text-neutral-500">{message}</p>}
    </div>
  );
}
