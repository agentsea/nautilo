CREATE TABLE "room_journal_model_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"work_kind" text NOT NULL,
	"work_id" text NOT NULL,
	"source_batch_id" uuid,
	"rebuild_generation" integer NOT NULL,
	"observed_attempt" integer NOT NULL,
	"observed_failure_at" timestamp with time zone NOT NULL,
	"observed_through" timestamp with time zone NOT NULL,
	"target_model_id" text NOT NULL,
	"authorized_by" uuid NOT NULL,
	"authorized_at" timestamp with time zone NOT NULL,
	"claim_lease_token" uuid,
	"claimed_at" timestamp with time zone,
	"spent_at" timestamp with time zone,
	CONSTRAINT "uq_room_journal_model_recovery_attempt" UNIQUE("room_id","work_kind","work_id","rebuild_generation","observed_attempt"),
	CONSTRAINT "room_journal_model_recovery_work_shape" CHECK ((
        "room_journal_model_recoveries"."work_kind" = 'extraction'
        AND "room_journal_model_recoveries"."source_batch_id" IS NOT NULL
        AND "room_journal_model_recoveries"."work_id" = "room_journal_model_recoveries"."source_batch_id"::text
      ) OR (
        "room_journal_model_recoveries"."work_kind" = 'compaction'
        AND "room_journal_model_recoveries"."source_batch_id" IS NULL
      )),
	CONSTRAINT "room_journal_model_recovery_coordinates" CHECK ("room_journal_model_recoveries"."rebuild_generation" >= 0
        AND "room_journal_model_recoveries"."observed_attempt" > 0
        AND char_length("room_journal_model_recoveries"."work_id") BETWEEN 1 AND 512
        AND char_length("room_journal_model_recoveries"."target_model_id") BETWEEN 1 AND 512
        AND btrim("room_journal_model_recoveries"."target_model_id") = "room_journal_model_recoveries"."target_model_id"),
	CONSTRAINT "room_journal_model_recovery_claim" CHECK (("room_journal_model_recoveries"."claim_lease_token" IS NULL) = ("room_journal_model_recoveries"."claimed_at" IS NULL)
        AND ("room_journal_model_recoveries"."spent_at" IS NULL OR "room_journal_model_recoveries"."claimed_at" IS NOT NULL)),
	CONSTRAINT "room_journal_model_recovery_time_order" CHECK ("room_journal_model_recoveries"."observed_failure_at" <= "room_journal_model_recoveries"."observed_through"
        AND "room_journal_model_recoveries"."observed_through" <= "room_journal_model_recoveries"."authorized_at"
        AND ("room_journal_model_recoveries"."claimed_at" IS NULL OR "room_journal_model_recoveries"."authorized_at" <= "room_journal_model_recoveries"."claimed_at")
        AND ("room_journal_model_recoveries"."spent_at" IS NULL OR "room_journal_model_recoveries"."claimed_at" <= "room_journal_model_recoveries"."spent_at"))
);
--> statement-breakpoint
ALTER TABLE "room_journal_model_recoveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_recovery_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"authorized_by" uuid NOT NULL,
	"observed_through" timestamp with time zone NOT NULL,
	"stenographer" jsonb,
	"reflection" jsonb,
	"memory" jsonb
);
--> statement-breakpoint
ALTER TABLE "memory_recovery_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "manual_recovery_id" uuid;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "manual_recovery_source_generation" integer;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "manual_recovery_authorized_by" uuid;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "manual_recovery_authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "manual_recovery_observed_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "manual_recovery_service_model_id" text;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "manual_recovery_spent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_journal_model_recoveries" ADD CONSTRAINT "room_journal_model_recoveries_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_journal_model_recoveries" ADD CONSTRAINT "room_journal_model_recoveries_source_batch_id_room_journal_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "public"."room_journal_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_room_journal_model_recovery_pending" ON "room_journal_model_recoveries" USING btree ("work_kind","spent_at","room_id");--> statement-breakpoint
CREATE INDEX "memory_recovery_runs_latest" ON "memory_recovery_runs" USING btree ("observed_through");--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_manual_recovery_coherent" CHECK ((
        "reflection_record_semantic_work"."manual_recovery_id" is null
        and "reflection_record_semantic_work"."manual_recovery_source_generation" is null
        and "reflection_record_semantic_work"."manual_recovery_authorized_by" is null
        and "reflection_record_semantic_work"."manual_recovery_authorized_at" is null
        and "reflection_record_semantic_work"."manual_recovery_observed_through" is null
        and "reflection_record_semantic_work"."manual_recovery_service_model_id" is null
        and "reflection_record_semantic_work"."manual_recovery_spent_at" is null
      ) or (
        "reflection_record_semantic_work"."manual_recovery_id" is not null
        and "reflection_record_semantic_work"."manual_recovery_source_generation" is not null
        and "reflection_record_semantic_work"."manual_recovery_source_generation" > 0
        and "reflection_record_semantic_work"."manual_recovery_source_generation" = "reflection_record_semantic_work"."generation" - 1
        and "reflection_record_semantic_work"."manual_recovery_authorized_by" is not null
        and "reflection_record_semantic_work"."manual_recovery_authorized_at" is not null
        and "reflection_record_semantic_work"."manual_recovery_observed_through" is not null
        and "reflection_record_semantic_work"."manual_recovery_observed_through" <= "reflection_record_semantic_work"."manual_recovery_authorized_at"
        and "reflection_record_semantic_work"."manual_recovery_service_model_id" is not null
        and octet_length("reflection_record_semantic_work"."manual_recovery_service_model_id") > 0
        and btrim("reflection_record_semantic_work"."manual_recovery_service_model_id") = "reflection_record_semantic_work"."manual_recovery_service_model_id"
        and (
          "reflection_record_semantic_work"."manual_recovery_spent_at" is null
          or "reflection_record_semantic_work"."manual_recovery_spent_at" >= "reflection_record_semantic_work"."manual_recovery_authorized_at"
        )
      ));--> statement-breakpoint
CREATE POLICY "room_journal_model_recoveries_product_all" ON "room_journal_model_recoveries" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "memory_recovery_runs_product" ON "memory_recovery_runs" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON TABLE "memory_recovery_runs", "room_journal_model_recoveries" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "memory_recovery_runs", "room_journal_model_recoveries" TO "nautilo";
