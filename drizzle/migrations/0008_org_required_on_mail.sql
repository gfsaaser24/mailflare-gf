ALTER TABLE "conversations" ALTER COLUMN "organization_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "organization_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "trashed_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: existing trashed messages start their trash window at creation time.
UPDATE messages SET trashed_at = created_at WHERE status = 'trash' AND trashed_at IS NULL;
