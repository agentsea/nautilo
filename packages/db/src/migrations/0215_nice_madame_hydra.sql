CREATE TABLE "claude_connections" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"profile_ref" uuid DEFAULT gen_random_uuid() NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"selected_model" varchar(320),
	"runtime" jsonb,
	"account" jsonb,
	"catalog" jsonb,
	"observation_revision" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_connections_observation_revision_check" CHECK ("claude_connections"."observation_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "claude_connections" ADD CONSTRAINT "claude_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_claude_connections_profile_ref" ON "claude_connections" USING btree ("profile_ref");
--> statement-breakpoint
ALTER TABLE claude_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE claude_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY claude_connections_owner ON claude_connections
  FOR ALL
  USING (user_id=app_current_user_id())
  WITH CHECK (user_id=app_current_user_id());
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON claude_connections TO nautilo_agent;
  END IF;
END $$;
