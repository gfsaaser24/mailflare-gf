"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { submitTwoFactorCode } from "./utils";

export function TwoFactorClient() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { ok, data } = await submitTwoFactorCode(code.trim());
      if (!ok) {
        // The pending session is gone: only the password step can mint a new one.
        if (data.error && data.error.includes("expired")) {
          router.replace("/login");
          return;
        }
        setError(data.error ?? "That code is not right. Try again.");
        setCode("");
        return;
      }
      router.replace(data.redirect ?? "/inbox");
      router.refresh();
    } catch (err) {
      setError(
        err instanceof DOMException && err.name === "TimeoutError"
          ? "The check timed out. Please try again."
          : "Unable to reach the sign-in service. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      icon={ShieldCheck}
      title="Two-step check"
      description="Open your authenticator app and type the six-digit code for this account."
    >
      <form method="post" onSubmit={onSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="code">Authentication code</Label>
          <Input
            id="code"
            name="code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoFocus
            // Long enough for a 6-digit code or an `xxxx-xxxx` backup code.
            maxLength={12}
            placeholder="123456"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
          <p className="text-sm text-neutral-500">
            Lost your phone? Type one of your backup codes instead.
          </p>
        </div>
        {error && (
          <p className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {error}
          </p>
        )}
        <Button
          type="submit"
          className="h-11 w-full rounded-full px-6 active:scale-[0.98]"
          disabled={loading || code.trim().length === 0}
        >
          {loading ? "Checking..." : "Continue"}
        </Button>
        <p className="text-sm text-neutral-500">
          <a href="/login" className="font-medium text-blue-700 hover:underline">
            Back to sign in
          </a>
        </p>
      </form>
    </AuthShell>
  );
}
