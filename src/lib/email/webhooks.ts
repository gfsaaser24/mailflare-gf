/**
 * Compatibility shim. The webhook stack moved to `src/lib/webhooks/**` in T6.3:
 *
 *   - `@/lib/webhooks/events`   — the event catalogue and payload types
 *   - `@/lib/webhooks/dispatch` — fan-out, signing, attempt bookkeeping
 *   - `@/lib/webhooks/retry`    — the backoff worker
 *
 * New code should import from there. This file exists so `inbound.ts`,
 * `send.ts` and the existing tests keep working unchanged.
 */
export { dispatchWebhooks, emitWebhookEvent, signPayload, signWebhookPayload } from "@/lib/webhooks/dispatch";
export type { WebhookEventType } from "@/lib/webhooks/events";
