ALTER TABLE "reflection_record_semantic_work" DROP CONSTRAINT "reflection_record_semantic_work_manual_recovery_coherent";--> statement-breakpoint
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
        and (
          "reflection_record_semantic_work"."manual_recovery_source_generation" = "reflection_record_semantic_work"."generation" - 1
          or (
            "reflection_record_semantic_work"."manual_recovery_source_generation" = "reflection_record_semantic_work"."generation"
            and "reflection_record_semantic_work"."manual_recovery_spent_at" is null
            and "reflection_record_semantic_work"."accepted_model_binding" is not null
            and "reflection_record_semantic_work"."accepted_model_binding_generation" = "reflection_record_semantic_work"."generation"
          )
        )
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
      ));