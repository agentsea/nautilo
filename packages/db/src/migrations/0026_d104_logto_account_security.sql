CREATE TABLE IF NOT EXISTS "logto_account_security" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"requires_password_change" boolean DEFAULT false NOT NULL,
	"password_change_reason" text,
	"required_since" timestamp,
	"completed_at" timestamp,
	"last_operator_actor_id" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "logto_account_security" ADD CONSTRAINT "logto_account_security_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "logto_account_security" ADD CONSTRAINT "logto_account_security_last_operator_actor_id_actors_id_fk" FOREIGN KEY ("last_operator_actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
INSERT INTO "logto_account_security" ("user_id", "requires_password_change", "password_change_reason", "required_since", "completed_at", "last_operator_actor_id", "updated_at")
SELECT "id", true, 'migration_temp_password', now(), NULL, NULL, now()
FROM "users"
WHERE "external_id" IS NOT NULL AND "server" IS NULL
ON CONFLICT ("user_id") DO NOTHING;
