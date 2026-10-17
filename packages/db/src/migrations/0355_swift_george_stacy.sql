ALTER TABLE "reflection_record_semantic_work" DROP CONSTRAINT "reflection_record_semantic_work_model_binding_coherent";--> statement-breakpoint
ALTER TABLE "reflection_record_semantic_work" ADD CONSTRAINT "reflection_record_semantic_work_model_binding_coherent" CHECK ((
        "reflection_record_semantic_work"."accepted_model_binding" is null
        and "reflection_record_semantic_work"."accepted_model_binding_generation" is null
      ) or (
        "reflection_record_semantic_work"."accepted_model_binding" is not null
        and "reflection_record_semantic_work"."accepted_model_binding_generation" is not null
        and "reflection_record_semantic_work"."accepted_model_binding_generation" = "reflection_record_semantic_work"."generation"
      ));