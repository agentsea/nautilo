ALTER TABLE "reflection_record_semantic_work" ADD COLUMN "ordinary_fallback_reason" text;--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_ordinary_fallback_coherent" CHECK ("reflection_record_semantic_work"."ordinary_fallback_reason" is null or (
        "reflection_record_semantic_work"."state" = 'complete'
        and "reflection_record_semantic_work"."ordinary_fallback_reason" in (
          'recoverable_availability', 'key_waiting'
        )
      ));