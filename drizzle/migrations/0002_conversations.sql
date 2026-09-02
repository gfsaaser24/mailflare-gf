CREATE TABLE "conversation_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"subject" text,
	"subject_normalized" text DEFAULT '' NOT NULL,
	"last_message_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"assigned_user_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "in_reply_to" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "references" text[];--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_notes_conversation_idx" ON "conversation_notes" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_mailbox_last_message_idx" ON "conversations" USING btree ("mailbox_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_mailbox_subject_idx" ON "conversations" USING btree ("mailbox_id","subject_normalized");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
-- Backfill: one conversation per (mailbox_id, normalised subject) group of the
-- messages that already exist. The normalisation below must stay in step with
-- `normalizeSubject()` in src/lib/conversations/service.ts.
INSERT INTO "conversations" (
	"id", "mailbox_id", "subject", "subject_normalized",
	"last_message_at", "message_count", "status", "created_at"
)
SELECT
	'cnv_' || md5(g."mailbox_id" || ':' || g."subject_normalized"),
	g."mailbox_id",
	g."subject",
	g."subject_normalized",
	g."last_message_at",
	g."message_count",
	'open',
	g."created_at"
FROM (
	SELECT
		m."mailbox_id" AS "mailbox_id",
		lower(trim(regexp_replace(coalesce(m."subject", ''), '^((re|fw|fwd)\s*:\s*)+', '', 'i'))) AS "subject_normalized",
		(array_agg(m."subject" ORDER BY m."created_at"))[1] AS "subject",
		max(m."created_at") AS "last_message_at",
		count(*)::int AS "message_count",
		min(m."created_at") AS "created_at"
	FROM "messages" m
	WHERE m."mailbox_id" IS NOT NULL AND m."conversation_id" IS NULL
	GROUP BY 1, 2
) g;--> statement-breakpoint
UPDATE "messages" m
SET "conversation_id" = c."id"
FROM "conversations" c
WHERE m."mailbox_id" IS NOT NULL
	AND m."conversation_id" IS NULL
	AND c."mailbox_id" = m."mailbox_id"
	AND c."subject_normalized" = lower(trim(regexp_replace(coalesce(m."subject", ''), '^((re|fw|fwd)\s*:\s*)+', '', 'i')));
