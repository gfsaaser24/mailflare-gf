export type BackupScheduleType = "daily" | "weekly" | "monthly";

export type DatabaseBackupTable = "users" | "domains" | "mailboxes" | "mailbox_access" | "auto_reply_deliveries" | "contacts" | "folders" | "calendar_events" | "email_templates" | "api_keys" | "messages" | "message_attachments" | "outbound_jobs" | "routing_rules" | "webhooks" | "webhook_deliveries" | "sessions" | "audit_logs" | "backup_settings" | "backups" | "app_settings";
export type DatabaseRecord = Record<string, string | number | boolean | null>;
export type DatabaseBackupDocument = { format: "mailflare-database-backup"; version: 1; createdAt: string; tables: Record<DatabaseBackupTable, DatabaseRecord[]>; };
