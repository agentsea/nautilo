CREATE TABLE "message_backfill_failures" (
	"message_id" integer PRIMARY KEY NOT NULL,
	"edit_revision" integer NOT NULL,
	"namespace_access_revision" integer NOT NULL,
	"policy_revision" integer NOT NULL,
	"crypto_object_id" text,
	"reason" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_backfill_failures_coordinates" CHECK ("message_backfill_failures"."edit_revision" >= 0 and "message_backfill_failures"."namespace_access_revision" >= 0 and "message_backfill_failures"."policy_revision" > 0),
	CONSTRAINT "message_backfill_failures_reason" CHECK ("message_backfill_failures"."reason" in ('integrity_failure', 'parity_mismatch', 'unsupported'))
);
--> statement-breakpoint
ALTER TABLE "message_backfill_failures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_backfill_scans" (
	"human_actor_id" uuid PRIMARY KEY NOT NULL,
	"cursor_message_id" integer DEFAULT 0 NOT NULL,
	"sweep_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sweep_at" timestamp with time zone,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resume_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_device_id" text,
	"lease_expires_at" timestamp with time zone,
	"claim" jsonb,
	"urgent_message_id" integer,
	"claim_is_urgent" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "message_backfill_scans_cursor" CHECK ("message_backfill_scans"."cursor_message_id" >= 0),
	CONSTRAINT "message_backfill_scans_urgent" CHECK ("message_backfill_scans"."claim_is_urgent" in (0, 1)),
	CONSTRAINT "message_backfill_scans_claim" CHECK (case when "message_backfill_scans"."lease_token" is null
    then "message_backfill_scans"."lease_device_id" is null and "message_backfill_scans"."lease_expires_at" is null and "message_backfill_scans"."claim" is null
    else "message_backfill_scans"."lease_device_id" is not null and "message_backfill_scans"."lease_expires_at" is not null and "message_backfill_scans"."claim" is not null end)
);
--> statement-breakpoint
ALTER TABLE "message_backfill_scans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "repair_publisher_human_id" uuid;--> statement-breakpoint
ALTER TABLE "message_backfill_failures" ADD CONSTRAINT "message_backfill_failures_message_id_session_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."session_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_backfill_scans" ADD CONSTRAINT "message_backfill_scans_human_actor_id_actors_id_fk" FOREIGN KEY ("human_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_backfill_scans" ADD CONSTRAINT "message_backfill_scans_urgent_message_id_session_messages_id_fk" FOREIGN KEY ("urgent_message_id") REFERENCES "public"."session_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_repair_human_publisher" CHECK (case when "session_message_crypto_revisions"."repair_publisher_kind" = 'human_device'
          then "session_message_crypto_revisions"."repair_publisher_human_id" is not null
          else "session_message_crypto_revisions"."repair_publisher_human_id" is null end);--> statement-breakpoint
CREATE POLICY "message_backfill_failures_product" ON "message_backfill_failures" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "message_backfill_scans_product" ON "message_backfill_scans" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M313_MESSAGE_BACKFILL_AUTHORITY

ALTER TABLE "message_backfill_scans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "message_backfill_scans" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "message_backfill_scans" TO "nautilo";
--> statement-breakpoint

ALTER TABLE "message_backfill_failures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "message_backfill_failures" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "message_backfill_failures" TO "nautilo";
