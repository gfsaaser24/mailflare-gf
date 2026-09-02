/**
 * T6.3 — the webhook event catalogue.
 *
 * This module is the single source of truth for "which events exist". The
 * validator (`webhookSchema`), the API routes and the admin UI all read the
 * catalogue from here, so adding an event is a one-line change.
 *
 * Every delivery body has the same envelope:
 *
 *   { "type": "message.inbound", "data": { ... } }
 *
 * `data` is the payload type of that event (see `WebhookEventPayloads`). It is
 * run through `sanitizeHtmlFields` before it is signed and sent, because a
 * consumer typically renders it.
 */

/** Everything an agent can subscribe to. Order is the order shown in the UI. */
export const WEBHOOK_EVENTS = [
	"message.inbound",
	"message.outbound",
	"message.failed",
	"conversation.assigned",
	"conversation.note",
	"quota.warning",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** Human labels for the admin UI checkboxes. */
export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
	"message.inbound": "A message arrived in a mailbox",
	"message.outbound": "A message was sent",
	"message.failed": "A send failed",
	"conversation.assigned": "A conversation was assigned (or unassigned)",
	"conversation.note": "An internal note was added to a conversation",
	"quota.warning": "Usage crossed 80% of an organisation limit",
};

export function isWebhookEventType(value: unknown): value is WebhookEventType {
	return typeof value === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** Parses the JSON blob in `webhooks.events`, dropping anything unknown. */
export function parseSubscribedEvents(raw: string): WebhookEventType[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isWebhookEventType);
}

export type MessageInboundPayload = {
	messageId: string;
	mailboxId: string;
	from: string | null;
	to: string | null;
	subject: string | null;
};

export type MessageOutboundPayload = {
	messageId: string;
	mailboxId?: string;
	to?: string | string[] | null;
	subject?: string | null;
};

export type MessageFailedPayload = {
	messageId: string;
	error: string;
};

export type ConversationAssignedPayload = {
	conversationId: string;
	/** `null` when the conversation was unassigned. */
	assignedUserId: string | null;
	subject: string | null;
	status: string;
};

export type ConversationNotePayload = {
	conversationId: string;
	noteId: string;
	body: string;
	/** `null` for a note written by an API key with no user attached. */
	authorId: string | null;
};

/** One organisation limit that has just crossed the warning threshold. */
export type QuotaWarningPayload = {
	organizationId: string;
	/** `mailboxes` | `accounts` | `domains` | `storage_bytes` | `daily_sends`. */
	kind: string;
	limit: number;
	current: number;
	/** `current / limit`, rounded to two decimals (e.g. `0.83`). */
	usage: number;
	/** The fraction that triggered the event, always `0.8` today. */
	threshold: number;
};

export type WebhookEventPayloads = {
	"message.inbound": MessageInboundPayload;
	"message.outbound": MessageOutboundPayload;
	"message.failed": MessageFailedPayload;
	"conversation.assigned": ConversationAssignedPayload;
	"conversation.note": ConversationNotePayload;
	"quota.warning": QuotaWarningPayload;
};
