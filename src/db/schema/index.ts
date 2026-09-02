import { pgTable, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
	id: text("id").primaryKey(),
	email: text("email").notNull().unique(),
	resetEmail: text("reset_email"),
	forwardingEmail: text("forwarding_email"),
	passwordHash: text("password_hash").notNull(),
	name: text("name").notNull(),
	avatarKey: text("avatar_key"),
	role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
	disabled: boolean("disabled").notNull().default(false),
	canManageMailboxes: boolean("can_manage_mailboxes").notNull().default(false),
	createdByUserId: text("created_by_user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const domains = pgTable(
	"domains",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		hostname: text("hostname").notNull(),
		zoneId: text("zone_id").notNull(),
		status: text("status", { enum: ["pending", "active", "error"] })
			.notNull()
			.default("pending"),
		routingStatus: text("routing_status"),
		sendingSubdomainTag: text("sending_subdomain_tag"),
		sendingEnabled: boolean("sending_enabled").notNull().default(false),
		routingEnabled: boolean("routing_enabled").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("domains_hostname_idx").on(t.hostname),
		index("domains_user_idx").on(t.userId),
	],
);

export const mailboxes = pgTable(
	"mailboxes",
	{
		id: text("id").primaryKey(),
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
	(t) => [uniqueIndex("mailboxes_address_idx").on(t.domainId, t.localPart)],
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
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	prefix: text("prefix").notNull(),
	keyHash: text("key_hash").notNull(),
	scopes: text("scopes").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
});

export const messages = pgTable(
	"messages",
	{
		id: text("id").primaryKey(),
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
		threadId: text("thread_id"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("messages_user_created_idx").on(t.userId, t.createdAt),
		index("messages_mailbox_idx").on(t.mailboxId),
		index("messages_folder_idx").on(t.folderId),
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
		userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
		title: text("title").notNull(),
		description: text("description").notNull().default(""),
		location: text("location").notNull().default(""),
		attendees: text("attendees").notNull().default("[]"),
		startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
		endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
	},
	(t) => [index("calendar_events_user_starts_idx").on(t.userId, t.startsAt)],
);

export const routingRules = pgTable("routing_rules", {
	id: text("id").primaryKey(),
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
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	url: text("url").notNull(),
	secret: text("secret").notNull(),
	events: text("events").notNull(),
	enabled: boolean("enabled").notNull().default(true),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
	id: text("id").primaryKey(),
	webhookId: text("webhook_id")
		.notNull()
		.references(() => webhooks.id, { onDelete: "cascade" }),
	eventType: text("event_type").notNull(),
	payload: text("payload").notNull(),
	status: text("status").notNull().default("pending"),
	attempts: integer("attempts").notNull().default(0),
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
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const auditLogs = pgTable(
	"audit_logs",
	{
		id: text("id").primaryKey(),
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

export const schema = {
	users,
	domains,
	mailboxes,
	autoReplyDeliveries,
	mailboxAccess,
	contacts,
	folders,
	apiKeys,
	messages,
	messageAttachments,
	outboundJobs,
	emailTemplates,
	calendarEvents,
	routingRules,
	webhooks,
	webhookDeliveries,
	sessions,
	auditLogs,
	backupSettings,
	backups,
	appSettings,
};
