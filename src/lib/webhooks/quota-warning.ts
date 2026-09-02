/**
 * Turns a quota warning into a `quota.warning` webhook event.
 *
 * `src/lib/quotas/warnings.ts` imports this module lazily on the first warning,
 * so quota enforcement carries no static dependency on the webhook stack.
 */
import { getSharedDb } from "@/db";
import { onQuotaWarning } from "@/lib/quotas/warnings";
import { emitWebhookEvent } from "./dispatch";

let unregister: (() => void) | undefined;

/** Idempotent: calling it twice keeps exactly one listener. */
export function registerQuotaWarningWebhook(): void {
	if (unregister) return;
	unregister = onQuotaWarning(async (warning) => {
		// Org-wide event: no `userId`, so every endpoint in the organisation that
		// subscribed to it gets a copy.
		await emitWebhookEvent(getSharedDb(), {
			orgId: warning.organizationId,
			type: "quota.warning",
			data: {
				organizationId: warning.organizationId,
				kind: warning.kind,
				limit: warning.limit,
				current: warning.current,
				usage: warning.usage,
				threshold: warning.threshold,
			},
		});
	});
}
