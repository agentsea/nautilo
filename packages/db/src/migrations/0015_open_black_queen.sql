CREATE TABLE "session_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"patch_id" text NOT NULL,
	"absolute_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drained_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "session_notifications" ADD CONSTRAINT "session_notifications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_session_notifications_pending" ON "session_notifications" USING btree ("thread_id","agent_id","drained_at");