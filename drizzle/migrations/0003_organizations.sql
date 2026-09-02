CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
INSERT INTO "organizations" ("id", "name", "slug", "status", "created_at")
SELECT
	'org_default',
	COALESCE((SELECT "app_name" FROM "app_settings" ORDER BY "id" LIMIT 1), 'Mailflare'),
	'default',
	'active',
	now()
WHERE NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = 'org_default');--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "email_templates" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "inbound_failures" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "routing_rules" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "organization_id" text DEFAULT 'org_default';--> statement-breakpoint
UPDATE "api_keys" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "audit_logs" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "calendar_events" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "contacts" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "conversations" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "domains" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "email_templates" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "folders" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "inbound_failures" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "mailboxes" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "messages" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "routing_rules" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "users" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
UPDATE "webhooks" SET "organization_id" = 'org_default' WHERE "organization_id" IS NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "email_templates" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_failures" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_rules" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_failures" ADD CONSTRAINT "inbound_failures_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_organization_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "conversations_organization_last_message_idx" ON "conversations" USING btree ("organization_id","last_message_at");--> statement-breakpoint
CREATE INDEX "domains_organization_idx" ON "domains" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mailboxes_organization_domain_idx" ON "mailboxes" USING btree ("organization_id","domain_id");--> statement-breakpoint
CREATE INDEX "messages_organization_mailbox_created_idx" ON "messages" USING btree ("organization_id","mailbox_id","created_at");--> statement-breakpoint
CREATE INDEX "users_organization_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "webhooks_organization_idx" ON "webhooks" USING btree ("organization_id");