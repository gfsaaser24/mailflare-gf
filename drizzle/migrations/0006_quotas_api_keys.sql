CREATE TABLE "org_quotas" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"max_mailboxes" integer,
	"max_shared_mailboxes" integer,
	"max_accounts" integer,
	"max_domains" integer,
	"max_storage_bytes" bigint,
	"max_daily_sends" integer,
	"max_attachment_bytes" bigint
);
--> statement-breakpoint
CREATE TABLE "org_usage" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"mailboxes" integer DEFAULT 0 NOT NULL,
	"accounts" integer DEFAULT 0 NOT NULL,
	"domains" integer DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"sends_today" integer DEFAULT 0 NOT NULL,
	"day_key" text DEFAULT '1970-01-01' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "hash_algo" text DEFAULT 'bcrypt' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_used_ip" text;--> statement-breakpoint
ALTER TABLE "org_quotas" ADD CONSTRAINT "org_quotas_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_usage" ADD CONSTRAINT "org_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;