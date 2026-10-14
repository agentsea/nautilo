ALTER TABLE "memories" ADD COLUMN "model_exposure_dependencies" jsonb;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "soul_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_journal_batches" ADD COLUMN "accepted_model_binding" jsonb;--> statement-breakpoint
ALTER TABLE "room_journal_state" ADD COLUMN "compaction_accepted_model_binding" jsonb;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "accepted_model_binding" jsonb;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "accepted_model_binding_generation" integer;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_exposure_representation" CHECK ("memories"."content" is not null or "memories"."model_exposure_dependencies" is null);--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_model_binding_coherent" CHECK ((
        "reflection_record_semantic_work"."accepted_model_binding" is null
        and "reflection_record_semantic_work"."accepted_model_binding_generation" is null
      ) or (
        "reflection_record_semantic_work"."accepted_model_binding" is not null
        and "reflection_record_semantic_work"."accepted_model_binding_generation" = "reflection_record_semantic_work"."generation"
      ));