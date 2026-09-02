CREATE TABLE "inbound_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"raw_r2_key" text NOT NULL,
	"mailbox_id" text,
	"from_addr" text NOT NULL,
	"to_addr" text NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "inbound_failures_raw_r2_key_unique" UNIQUE("raw_r2_key")
);
--> statement-breakpoint
ALTER TABLE "inbound_failures" ADD CONSTRAINT "inbound_failures_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_failures_created_idx" ON "inbound_failures" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "inbound_failures_resolved_idx" ON "inbound_failures" USING btree ("resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_inbound_provider_id_idx" ON "messages" USING btree ("mailbox_id","provider_message_id") WHERE "messages"."direction" = 'inbound' AND "messages"."provider_message_id" IS NOT NULL;