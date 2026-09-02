ALTER TABLE "domains" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dns_ok" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "last_checked_at" timestamp with time zone;