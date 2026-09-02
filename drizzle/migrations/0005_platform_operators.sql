CREATE TABLE "platform_operators" (
	"user_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "impersonated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "impersonated_organization_id" text;--> statement-breakpoint
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonated_by_user_id_users_id_fk" FOREIGN KEY ("impersonated_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonated_organization_id_organizations_id_fk" FOREIGN KEY ("impersonated_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Seed the first platform operator: the oldest existing admin (T3.3).
INSERT INTO platform_operators (user_id, created_at) SELECT id, now() FROM users WHERE role='admin' ORDER BY created_at LIMIT 1 ON CONFLICT DO NOTHING;
