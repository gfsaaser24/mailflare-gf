import { sql } from "drizzle-orm";
import { pgTable, text, integer, bigint, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { DEFAULT_ORGANIZATION_ID } from "../../lib/organizations/constants";
import { newId } from "../../lib/ids";
import { tsvector } from "../types";

export const organizations = pgTable(
	"organizations",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		status: text("status", { enum: ["active", "suspended"] })
			.notNull()
			.default("active"),
		notes: text("notes"),
		/** Members of this organisation must have TOTP enrolled to keep a full session. */
		requireTwoFactor: boolean("require_two_factor").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [uniqueIndex("organizations_slug_idx").on(t.slug)],
);

export const users = pgTable("users", {
	id: text("id").primaryKey(),
	organizationId: text("organization_id")
		.notNull()
		.default(DEFAULT_ORGANIZATION_ID)
		.references(() => organizations.id),
	email: text("email").notNull().unique(),
	resetEmail: text("reset_email"),
	forwardingEmail: text("forwarding_email"),
	passwordHash: text("password_hash").notNull(),
	name: text("name").notNull(),
	avatarKey: text("avatar_key"),
	role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
	disabled: boolean("disabled").notNull().default(false),
	canManageMailboxes: boolean("can_manage_mailboxes").notNull().default(false),
	/**
	 * TOTP shared secret, encrypted at rest with `AUTH_ENCRYPTION_KEY`
	 * (`v1.<iv>.<ct>.<tag>`, see `src/lib/auth/crypto.ts`). Never store it plain.
	 */
	totpSecretEncrypted: text("totp_secret_encrypted"),
	/** Set once the user has confirmed a code; null means TOTP is not active. */
	totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true, mode: "date" }),
	/** JSON array of bcrypt hashes; a used code is removed from the array. */
	totpBackupCodes: text("totp_backup_codes"),
	/** Last password change; sessions minted before it can be treated as stale. */
	passwordChangedAt: timestamp("password_changed_at", { withTimezone: true, mode: "date" }),
	createdByUserId: text("created_by_user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
}, (t) => [index("users_organization_idx").on(t.organizationId)]);

export const domains = pgTable(
	"domains",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.default(DEFAULT_ORGANIZATION_ID)
			.references(() => organizations.id),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		hostname: text("hostname").notNull(),
		zoneId: text("zone_id").notNull(),
		status: text("status", { enum: ["pending", "active", "error"] })
			.notNull()
			.default("pending"),
		/** Why the domain is in `error`; null while it is `pending` or `active`. */
		statusReason: text("status_reason"),
		routingStatus: text("routing_status"),
		sendingSubdomainTag: text("sending_subdomain_tag"),
		sendingEnabled: boolean("sending_enabled").notNull().default(false),
		routingEnabled: boolean("routing_enabled").notNull().default(false),
		/** Every required Email Routing (and sending) DNS record was present at the last check. */
		dnsOk: boolean("dns_ok").notNull().default(false),
		/** When `reconcileDomain` last compared this row to live Cloudflare state. */
		lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("domains_hostname_idx").on(t.hostname),
		index("domains_user_idx").on(t.userId),
		index("domains_organization_idx").on(t.organizationId),
	],
);

export const mailboxes = pgTable(
	"mailboxes",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.default(DEFAULT_ORGANIZATION_ID)
			.references(() => organizations.id),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		domainId: text("domain_id")
			.notNull()
			.references(() => domains.id, { onDelete: "cascade" }),
		localPart: text("local_part").notNull(),
		displayName: text("display_name"),
		signature: text("signature"),
		autoReplyEnabled: boolean("auto_reply_enabled").notNull().default(false),
		autoReplySubject: text("auto_reply_subject").notNull().default("Out of office"),
		autoReplyBody: text("auto_reply_body").notNull().default(""),
		avatarKey: text("avatar_key"),
		type: text("type", { enum: ["personal", "shared"] }).notNull().default("personal"),
		useAllDomains: boolean("use_all_domains").notNull().default(true),
		disabled: boolean("disabled").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("mailboxes_address_idx").on(t.domainId, t.localPart),
		index("mailboxes_organization_domain_idx").on(t.organizationId, t.domainId),
	],
);

export const autoReplyDeliveries = pgTable(
	"auto_reply_deliveries",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		recipient: text("recipient").notNull(),
		sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(t) => [
		uniqueIndex("auto_reply_deliveries_mailbox_recipient_idx").on(t.mailboxId, t.recipient),
		index("auto_reply_deliveries_sent_idx").on(t.sentAt),
	],
);

export const mailboxAccess = pgTable(
	"mailbox_access",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		permission: text("permission", { enum: ["read_only", "send_as", "send_on_behalf", "full_access"] })
			.notNull()
			.default("read_only"),
		createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("mailbox_access_mailbox_user_idx").on(t.mailboxId, t.userId),
		index("mailbox_access_user_idx").on(t.userId),
		index("mailbox_access_mailbox_idx").on(t.mailboxId),
	],
);

export const contacts = pgTable(
	"contacts",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.default(DEFAULT_ORGANIZATION_ID)
			.references(() => organizations.id),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		displayName: text("display_name"),
		source: text("source", { enum: ["manual", "inbound", "outbound"] })
			.notNull()
			.default("inbound"),
		blocked: boolean("blocked").notNull().default(false),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("contacts_user_email_idx").on(t.userId, t.email),
		index("contacts_user_idx").on(t.userId),
	],
);

export const folders = pgTable(
	"folders",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.default(DEFAULT_ORGANIZATION_ID)
			.references(() => organizations.id),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		color: text("color").notNull().default("#2563eb"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("folders_mailbox_name_idx").on(t.mailboxId, t.name),
		index("folders_user_idx").on(t.userId),
		index("folders_mailbox_idx").on(t.mailboxId),
	],
);

export const apiKeys = pgTable("api_keys", {
	id: text("id").primaryKey(),
	organizationId: text("organization_id")
		.notNull()
		.default(DEFAULT_ORGANIZATION_ID)
		.references(() => organizations.id),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	prefix: text("prefix").notNull(),
	keyHash: text("key_hash").notNull(),
	/**
	 * How `key_hash` was produced. New keys are `sha256` (hex of the full key);
	 * `bcrypt` rows predate T6.1 and keep verifying so nobody is locked out.
	 */
	hashAlgo: text("hash_algo").notNull().default("bcrypt"),
	scopes: text("scopes").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
	/** Null means the key never expires. */
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
	/** Set by `DELETE /api/api-keys/[id]`; a revoked key can never authenticate again. */
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
	lastUsedIp: text("last_used_ip"),
}, (t) => [index("api_keys_organization_idx").on(t.organizationId)]);

export const conversations = pgTable(
	"conversations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		// The subject as first seen, kept for display; `subjectNormalized` is what we match on.
		subject: text("subject"),
		subjectNormalized: text("subject_normalized").notNull().default(""),
		lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: "date" }),
		messageCount: integer("message_count").notNull().default(0),
		assignedUserId: text("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
		status: text("status", { enum: ["open", "closed", "snoozed"] })
			.notNull()
			.default("open"),
		snoozedUntil: timestamp("snoozed_until", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("conversations_mailbox_last_message_idx").on(t.mailboxId, t.lastMessageAt.desc()),
		index("conversations_mailbox_subject_idx").on(t.mailboxId, t.subjectNormalized),
		index("conversations_organization_last_message_idx").on(t.organizationId, t.lastMessageAt),
	],
);

export const conversationNotes = pgTable(
	"conversation_notes",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
		body: text("body").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [index("conversation_notes_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const messages = pgTable(
	"messages",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
		providerMessageId: text("provider_message_id"),
		folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
		fromAddr: text("from_addr").notNull(),
		toAddr: text("to_addr").notNull(),
		subject: text("subject"),
		snippet: text("snippet"),
		textBody: text("text_body"),
		htmlBody: text("html_body"),
		rawR2Key: text("raw_r2_key"),
		status: text("status").notNull().default("received"),
		read: boolean("read").notNull().default(false),
		starred: boolean("starred").notNull().default(false),
		snoozedUntil: timestamp("snoozed_until", { withTimezone: true, mode: "date" }),
		/** When the message was moved to `status = 'trash'`; drives the retention purge. */
		trashedAt: timestamp("trashed_at", { withTimezone: true, mode: "date" }),
		threadId: text("thread_id"),
		conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
		// RFC 5322 threading headers, verbatim (angle brackets included).
		inReplyTo: text("in_reply_to"),
		referencesHeader: text("references").array(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
		/**
		 * Full-text index over subject + participants + text body (T6.2).
		 *
		 * `GENERATED ALWAYS AS (...) STORED`, so Postgres maintains it and the app
		 * never writes to it. drizzle-kit cannot express the generation
		 * expression: the exact DDL the migration needs is at the top of
		 * `src/lib/search/service.ts`.
		 */
		searchVector: tsvector("search_vector"),
	},
	(t) => [
		index("messages_user_created_idx").on(t.userId, t.createdAt),
		index("messages_search_idx").using("gin", t.searchVector),
		index("messages_organization_mailbox_created_idx").on(t.organizationId, t.mailboxId, t.createdAt),
		index("messages_conversation_idx").on(t.conversationId, t.createdAt),
		index("messages_mailbox_idx").on(t.mailboxId),
		index("messages_folder_idx").on(t.folderId),
		// The folder list query shape: one mailbox, one status, newest first.
		index("messages_mailbox_status_created_idx").on(t.mailboxId, t.status, t.createdAt),
		// Inbox and every other unfiled view add `folder_id IS NULL`; the partial
		// index keeps filed mail out of the heap read entirely.
		index("messages_mailbox_status_unfiled_created_idx")
			.on(t.mailboxId, t.status, t.createdAt)
			.where(sql`${t.folderId} IS NULL`),
		// Inbound idempotency: the edge worker may retry the same message.
		uniqueIndex("messages_inbound_provider_id_idx")
			.on(t.mailboxId, t.providerMessageId)
			.where(sql`${t.direction} = 'inbound' AND ${t.providerMessageId} IS NOT NULL`),
	],
);

export const messageAttachments = pgTable(
	"message_attachments",
	{
		id: text("id").primaryKey(),
		messageId: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		filename: text("filename").notNull(),
		contentType: text("content_type").notNull(),
		size: integer("size").notNull(),
		disposition: text("disposition", { enum: ["attachment", "inline"] })
			.notNull()
			.default("attachment"),
		contentId: text("content_id"),
		r2Key: text("r2_key").notNull().unique(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [index("message_attachments_message_idx").on(t.messageId)],
);

export const outboundJobs = pgTable("outbound_jobs", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
	status: text("status", { enum: ["queued", "sent", "failed"] }).notNull().default("queued"),
	payload: text("payload").notNull(),
	error: text("error"),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const emailTemplates = pgTable(
	"email_templates",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.default(DEFAULT_ORGANIZATION_ID)
			.references(() => organizations.id),
		userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		subject: text("subject").notNull().default(""),
		textBody: text("text_body").notNull().default(""),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
	},
	(t) => [index("email_templates_user_idx").on(t.userId)],
);

export const calendarEvents = pgTable(
	"calendar_events",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.default(DEFAULT_ORGANIZATION_ID)
			.references(() => organizations.id),
		userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		title: text("title").notNull(),
		description: text("description").notNull().default(""),
		location: text("location").notNull().default(""),
		attendees: text("attendees").notNull().default("[]"),
		startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
		endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
		/** All-day events ignore the clock part of `starts_at`/`ends_at`. */
		allDay: boolean("all_day").notNull().default(false),
		/** IANA zone the wall-clock times were entered in, e.g. `Europe/London`. */
		timezone: text("timezone").notNull().default("UTC"),
		/** RFC 5545 RRULE body, without the `RRULE:` prefix. Null for a single event. */
		rrule: text("rrule"),
		/**
		 * ICS UID; stable across exports and updates. The SQL default exists so a
		 * build that predates this column can still insert a row (the app supplies
		 * its own value), which keeps a migrate-then-deploy rollout safe.
		 */
		uid: text("uid")
			.notNull()
			.default(sql`('evt_' || gen_random_uuid()::text)`)
			.$defaultFn(() => newId("evt")),
		/** `private` is the owner only; `organization` is everyone in the org. */
		visibility: text("visibility", { enum: ["private", "organization"] })
			.notNull()
			.default("private"),
		/** Optional display colour, e.g. `#2563eb`. */
		color: text("color"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
	},
	(t) => [
		index("calendar_events_user_starts_idx").on(t.userId, t.startsAt),
		index("calendar_events_org_visibility_starts_idx").on(t.organizationId, t.visibility, t.startsAt),
	],
);

export const routingRules = pgTable("routing_rules", {
	id: text("id").primaryKey(),
	organizationId: text("organization_id")
		.notNull()
		.default(DEFAULT_ORGANIZATION_ID)
		.references(() => organizations.id),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	domainId: text("domain_id")
		.notNull()
		.references(() => domains.id, { onDelete: "cascade" }),
	pattern: text("pattern").notNull(),
	matchField: text("match_field", { enum: ["email", "content", "title"] }).notNull().default("email"),
	matchOperator: text("match_operator", { enum: ["contains", "exact"] }).notNull().default("contains"),
	matchValue: text("match_value").notNull().default(""),
	mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
	folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
	action: text("action", { enum: ["store", "forward", "reject", "spam", "trash"] }).notNull().default("store"),
	forwardTo: text("forward_to"),
	priority: integer("priority").notNull().default(0),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const webhooks = pgTable("webhooks", {
	id: text("id").primaryKey(),
	organizationId: text("organization_id")
		.notNull()
		.default(DEFAULT_ORGANIZATION_ID)
		.references(() => organizations.id),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	url: text("url").notNull(),
	secret: text("secret").notNull(),
	events: text("events").notNull(),
	/** Free-text label so an operator can tell two endpoints apart. */
	description: text("description"),
	enabled: boolean("enabled").notNull().default(true),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
}, (t) => [index("webhooks_organization_idx").on(t.organizationId)]);

export const webhookDeliveries = pgTable("webhook_deliveries", {
	id: text("id").primaryKey(),
	webhookId: text("webhook_id")
		.notNull()
		.references(() => webhooks.id, { onDelete: "cascade" }),
	eventType: text("event_type").notNull(),
	payload: text("payload").notNull(),
	/** `pending` | `delivered` | `dead`. `pending` rows are retried. */
	status: text("status").notNull().default("pending"),
	attempts: integer("attempts").notNull().default(0),
	/** When the retry worker may try again. Null once delivered or dead. */
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
	/** Transport error or non-2xx body summary from the last attempt. */
	lastError: text("last_error"),
	/** HTTP status of the last attempt, null when the request never completed. */
	responseStatus: integer("response_status"),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const sessions = pgTable("sessions", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	tokenHash: text("token_hash").notNull().unique(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
	/**
	 * Set only on sessions minted by `POST /api/platform/orgs/[id]/impersonate`:
	 * the platform operator acting as the session's user (T3.3). Null on every
	 * ordinary login.
	 */
	impersonatedByUserId: text("impersonated_by_user_id").references(() => users.id, {
		onDelete: "cascade",
	}),
	/** The organisation the operator asked to enter; kept for the audit trail. */
	impersonatedOrganizationId: text("impersonated_organization_id").references(
		() => organizations.id,
	),
	/**
	 * The password step passed but the TOTP step has not. A pending session is NOT
	 * logged in: `getUserFromSession()` refuses it, only the two-factor route may
	 * read it (`getPendingTwoFactorSession`) and promote it.
	 */
	pendingTwoFactor: boolean("pending_two_factor").notNull().default(false),
	/** Refreshed at most once every 5 minutes so the sessions list stays cheap. */
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
	/** Client IP and user agent seen at login; shown in the sessions list. */
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/**
 * One-time links: password reset and magic-link sign-in.
 *
 * Same shape as `user_invites`: only the SHA-256 hex of the token is stored, and
 * `used_at` is set by the atomic UPDATE that spends it (`src/lib/auth/tokens.ts`),
 * so a token can never be redeemed twice even under a race.
 */
export const authTokens = pgTable(
	"auth_tokens",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		purpose: text("purpose", { enum: ["password_reset", "magic_link"] }).notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
		usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
		/** IP that asked for the link; kept so abuse can be traced. */
		requestIp: text("request_ip"),
	},
	(t) => [index("auth_tokens_user_purpose_idx").on(t.userId, t.purpose)],
);

/**
 * Platform operators (T3.3, decision D2).
 *
 * Deliberately a table and not a `users.role` value: a role flag is one bad
 * `WHERE` away from cross-tenant exposure. Membership is checked only by
 * `requirePlatformOperator()` (`src/lib/platform/guard.ts`), which guards
 * `/api/platform/**` and nothing else.
 */
export const platformOperators = pgTable("platform_operators", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
	createdByUserId: text("created_by_user_id").references((): AnyPgColumn => users.id, {
		onDelete: "set null",
	}),
});

export const auditLogs = pgTable(
	"audit_logs",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.default(DEFAULT_ORGANIZATION_ID)
			.references(() => organizations.id),
		actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
		targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
		action: text("action").notNull(),
		metadata: text("metadata"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("audit_logs_actor_idx").on(t.actorUserId),
		index("audit_logs_mailbox_idx").on(t.mailboxId),
		index("audit_logs_created_idx").on(t.createdAt),
	],
);

export const backupSettings = pgTable("backup_settings", {
	id: text("id").primaryKey(),
	enabled: boolean("enabled").notNull().default(false),
	scheduleType: text("schedule_type", { enum: ["daily", "weekly", "monthly"] })
		.notNull()
		.default("daily"),
	scheduleValue: integer("schedule_value"),
	retentionEnabled: boolean("retention_enabled").notNull().default(false),
	retentionDays: integer("retention_days").notNull().default(30),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const appSettings = pgTable("app_settings", {
	id: text("id").primaryKey(),
	appName: text("app_name").notNull().default("Mailflare"),
	iconKey: text("icon_key"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const backups = pgTable(
	"backups",
	{
		id: text("id").primaryKey(),
		status: text("status", { enum: ["queued", "running", "completed", "failed"] })
			.notNull()
			.default("queued"),
		trigger: text("trigger", { enum: ["manual", "scheduled"] }).notNull(),
		r2Key: text("r2_key"),
		filename: text("filename"),
		size: integer("size"),
		error: text("error"),
		createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
		startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
		completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [
		index("backups_created_idx").on(t.createdAt),
		index("backups_status_idx").on(t.status),
	],
);

export const inboundFailures = pgTable(
	"inbound_failures",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.default(DEFAULT_ORGANIZATION_ID)
			.references(() => organizations.id),
		rawR2Key: text("raw_r2_key").notNull().unique(),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		fromAddr: text("from_addr").notNull(),
		toAddr: text("to_addr").notNull(),
		error: text("error"),
		attempts: integer("attempts").notNull().default(1),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
		resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
	},
	(t) => [
		index("inbound_failures_created_idx").on(t.createdAt),
		index("inbound_failures_resolved_idx").on(t.resolvedAt),
	],
);

/**
 * Per-organisation quota limits (T5.1).
 *
 * A `null` column means "no limit" for that dimension, and a missing row means the
 * organisation is unlimited entirely. Templates live in `src/lib/quotas/templates.ts`.
 */
export const orgQuotas = pgTable("org_quotas", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organizations.id, { onDelete: "cascade" }),
	maxMailboxes: integer("max_mailboxes"),
	maxSharedMailboxes: integer("max_shared_mailboxes"),
	maxAccounts: integer("max_accounts"),
	maxDomains: integer("max_domains"),
	/** Bytes; int8 because 10 GiB does not fit in int4. */
	maxStorageBytes: bigint("max_storage_bytes", { mode: "number" }),
	maxDailySends: integer("max_daily_sends"),
	maxAttachmentBytes: bigint("max_attachment_bytes", { mode: "number" }),
});

/**
 * Per-organisation usage counters (T5.1). The row every quota check takes
 * `SELECT ... FOR UPDATE` on.
 *
 * `day_key` is the UTC `yyyy-mm-dd` the `sends_today` counter belongs to; when it
 * is not today, `sends_today` is treated as 0 and rewritten on the next check.
 */
export const orgUsage = pgTable("org_usage", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organizations.id, { onDelete: "cascade" }),
	mailboxes: integer("mailboxes").notNull().default(0),
	accounts: integer("accounts").notNull().default(0),
	domains: integer("domains").notNull().default(0),
	storageBytes: bigint("storage_bytes", { mode: "number" }).notNull().default(0),
	sendsToday: integer("sends_today").notNull().default(0),
	dayKey: text("day_key").notNull().default("1970-01-01"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/**
 * Per-organisation retention windows (T5.2).
 *
 * Every column is a number of days. A missing row means the defaults below,
 * which are also the defaults `getRetention()` returns, so an organisation that
 * has never opened the settings behaves exactly like one that saved them
 * unchanged. `scripts/retention.ts` reads these once per run.
 */
export const orgRetention = pgTable("org_retention", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organizations.id, { onDelete: "cascade" }),
	/** Days a message may sit in `status = 'trash'` before it is really deleted. */
	trashDays: integer("trash_days").notNull().default(30),
	/** Days an expired session row is kept after `expires_at`. */
	sessionsDays: integer("sessions_days").notNull().default(7),
	webhookDeliveriesDays: integer("webhook_deliveries_days").notNull().default(30),
	/** `platform.*` actions are never deleted, whatever this says. */
	auditLogsDays: integer("audit_logs_days").notNull().default(365),
	autoReplyDays: integer("auto_reply_days").notNull().default(30),
	outboundJobsDays: integer("outbound_jobs_days").notNull().default(30),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/**
 * Set-password invites (T3.5).
 *
 * One row per invite: `token_hash` is the SHA-256 hex of a 32-byte random token
 * that is shown to the inviter (or emailed) exactly once. `accepted_at` marks it
 * spent; accepting also clears every other pending invite for that user.
 */
export const userInvites = pgTable(
	"user_invites",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.default(DEFAULT_ORGANIZATION_ID)
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
		acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
		createdByUserId: text("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("user_invites_user_idx").on(t.userId),
		index("user_invites_organization_idx").on(t.organizationId),
	],
);

export const schema = {
	organizations,
	users,
	domains,
	mailboxes,
	autoReplyDeliveries,
	mailboxAccess,
	contacts,
	folders,
	apiKeys,
	conversations,
	conversationNotes,
	messages,
	messageAttachments,
	outboundJobs,
	emailTemplates,
	calendarEvents,
	routingRules,
	webhooks,
	webhookDeliveries,
	sessions,
	authTokens,
	auditLogs,
	backupSettings,
	backups,
	appSettings,
	inboundFailures,
	orgQuotas,
	orgUsage,
	orgRetention,
	userInvites,
};
