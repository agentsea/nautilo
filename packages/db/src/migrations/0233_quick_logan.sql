CREATE TABLE "memory_review_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"work_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"outcome" text DEFAULT 'published' NOT NULL,
	"phase" text,
	"code" text,
	"counts" jsonb NOT NULL,
	"effects" jsonb NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_review_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_review_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"access_scope" text NOT NULL,
	"thread_id" text NOT NULL,
	"checkpoint_thread_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"source_ids" jsonb NOT NULL,
	"first_message_id" integer NOT NULL,
	"has_human" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_id" uuid,
	"lease_until" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"failure_phase" text,
	"failure_code" text,
	"completed_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"receipt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_review_turn_identity" UNIQUE("session_id","agent_id","owner_id","access_scope","turn_id")
);
--> statement-breakpoint
ALTER TABLE "memory_review_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "server_model_config" ADD COLUMN "memory_review_model" text;--> statement-breakpoint
ALTER TABLE "server_context_config" ADD COLUMN "memory_review_enabled" boolean;--> statement-breakpoint
ALTER TABLE "memory_review_turns" ADD CONSTRAINT "memory_review_turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_review_turns" ADD CONSTRAINT "memory_review_turns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_review_turns" ADD CONSTRAINT "memory_review_turns_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_review_receipt_time_idx" ON "memory_review_receipts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_review_publication_once" ON "memory_review_receipts" USING btree ("work_id") WHERE "memory_review_receipts"."outcome" = 'published';--> statement-breakpoint
CREATE INDEX "memory_review_pending_idx" ON "memory_review_turns" USING btree ("state","retry_at","first_message_id");--> statement-breakpoint
CREATE POLICY "memory_review_receipts_product" ON "memory_review_receipts" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "memory_review_receipts_agent" ON "memory_review_receipts" AS PERMISSIVE FOR ALL TO "nautilo_agent" USING ("memory_review_receipts"."agent_id" = app_current_agent_id() AND EXISTS (SELECT 1 FROM actors a WHERE a.id::text = "memory_review_receipts"."actor_id" AND a.owner_id = app_current_user_id() AND a.kind = 'user')) WITH CHECK ("memory_review_receipts"."agent_id" = app_current_agent_id() AND EXISTS (SELECT 1 FROM actors a WHERE a.id::text = "memory_review_receipts"."actor_id" AND a.owner_id = app_current_user_id() AND a.kind = 'user'));--> statement-breakpoint
CREATE POLICY "memory_review_turns_product" ON "memory_review_turns" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "memory_review_turns_agent" ON "memory_review_turns" AS PERMISSIVE FOR ALL TO "nautilo_agent" USING ("memory_review_turns"."agent_id" = app_current_agent_id() AND (
      EXISTS (SELECT 1 FROM actors a WHERE a.id::text = "memory_review_turns"."actor_id" AND a.owner_id = app_current_user_id() AND a.kind = 'user')
      OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = "memory_review_turns"."session_id" AND s.owner_id = app_current_user_id()))) WITH CHECK ("memory_review_turns"."agent_id" = app_current_agent_id() AND (
      EXISTS (SELECT 1 FROM actors a WHERE a.id::text = "memory_review_turns"."actor_id" AND a.owner_id = app_current_user_id() AND a.kind = 'user')
      OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = "memory_review_turns"."session_id" AND s.owner_id = app_current_user_id())));--> statement-breakpoint
-- Drizzle emits RLS policies but cannot express table privileges. Transcript
-- admission and publication use nautilo_agent; pruning/delivery remain product-owned.
REVOKE ALL ON memory_review_turns, memory_review_receipts FROM nautilo_agent;
GRANT SELECT, INSERT, UPDATE ON memory_review_turns TO nautilo_agent;
GRANT SELECT, INSERT ON memory_review_receipts TO nautilo_agent;
--> statement-breakpoint
-- The restricted publication transaction must pin current-account liveness
-- without reading the credential-bearing users table or nesting transactions.
-- Drizzle cannot express functions. No caller-supplied user coordinate exists.
CREATE FUNCTION app_memory_review_actor_is_active() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM public.users
    WHERE id = public.app_current_user_id() AND disabled_at IS NULL FOR SHARE;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION app_memory_review_actor_is_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_memory_review_actor_is_active() TO nautilo_agent;
