CREATE TABLE "collaboration_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_name" text NOT NULL,
	"target_kind" text NOT NULL,
	"artifact_id" text,
	"current_folder_ref" text,
	"current_relative_path" text,
	"creator_user_id" uuid NOT NULL,
	"relay_owner_user_id" uuid,
	"created_by_agent_id" uuid,
	"room_id" uuid,
	"document_kind" text NOT NULL,
	"state" text NOT NULL,
	"y_state" "bytea" NOT NULL,
	"primary_sha256" text,
	"primary_revision" integer,
	"last_materialized_sha256" text,
	"last_materialized_revision" integer,
	"last_materialized_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collaboration_sessions" ADD CONSTRAINT "collaboration_sessions_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_sessions" ADD CONSTRAINT "collaboration_sessions_relay_owner_user_id_users_id_fk" FOREIGN KEY ("relay_owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_sessions" ADD CONSTRAINT "collaboration_sessions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_sessions" ADD CONSTRAINT "collaboration_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_collaboration_sessions_document_name" ON "collaboration_sessions" USING btree ("document_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_collaboration_sessions_artifact_room_active" ON "collaboration_sessions" USING btree ("artifact_id","room_id") WHERE "collaboration_sessions"."target_kind" = 'artifact' AND "collaboration_sessions"."room_id" IS NOT NULL AND "collaboration_sessions"."state" IN ('active', 'recoverable');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_collaboration_sessions_artifact_no_room_active" ON "collaboration_sessions" USING btree ("artifact_id") WHERE "collaboration_sessions"."target_kind" = 'artifact' AND "collaboration_sessions"."room_id" IS NULL AND "collaboration_sessions"."state" IN ('active', 'recoverable');--> statement-breakpoint
CREATE INDEX "idx_collaboration_sessions_current_file" ON "collaboration_sessions" USING btree ("relay_owner_user_id","current_folder_ref","current_relative_path");--> statement-breakpoint
CREATE INDEX "idx_collaboration_sessions_expires_at" ON "collaboration_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_collaboration_sessions_creator_user_id" ON "collaboration_sessions" USING btree ("creator_user_id");--> statement-breakpoint
CREATE INDEX "idx_collaboration_sessions_relay_owner_user_id" ON "collaboration_sessions" USING btree ("relay_owner_user_id");