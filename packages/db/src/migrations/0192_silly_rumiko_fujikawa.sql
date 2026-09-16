ALTER TABLE "reflection_record_semantic_work" DROP CONSTRAINT "reflection_record_semantic_work_completion_coherent";--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_completion_coherent" CHECK ((
        "reflection_record_semantic_work"."state" = 'complete'
        and (
          "reflection_record_semantic_work"."stage" = 'organization'
          or "reflection_record_semantic_work"."change_reason" = 'parent_conflict'
        )
        and "reflection_record_semantic_work"."completed_generation" = "reflection_record_semantic_work"."generation"
        and "reflection_record_semantic_work"."completed_at" is not null
      ) or (
        "reflection_record_semantic_work"."state" <> 'complete'
        and "reflection_record_semantic_work"."completed_at" is null
      ));