CREATE TABLE "personal_capability_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_capability_preferences_revision_check" CHECK ("personal_capability_preferences"."revision" >= 1),
	CONSTRAINT "personal_capability_preferences_overrides_object_check" CHECK (jsonb_typeof("personal_capability_preferences"."overrides") = 'object')
);
--> statement-breakpoint
ALTER TABLE "personal_capability_preferences" ADD CONSTRAINT "personal_capability_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
