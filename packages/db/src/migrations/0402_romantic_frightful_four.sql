DROP INDEX "idx_reflection_record_semantic_work_manual_recovery_binding";--> statement-breakpoint
DROP INDEX "idx_reflection_record_semantic_work_manual_recovery_grant";--> statement-breakpoint
CREATE INDEX "idx_reflection_record_semantic_work_manual_recovery_binding" ON "reflection_record_semantic_work" USING btree ((case
    when "accepted_model_binding"->>'version' = '1'
      and "accepted_model_binding"->>'kind' = 'service'
      and "accepted_model_binding"->>'role' = 'memoryReflection'
    then 'binding:' || encode(sha256(jsonb_send("accepted_model_binding")), 'hex')
    else null
  end),"record_id") WHERE case
    when "reflection_record_semantic_work"."accepted_model_binding"->>'version' = '1'
      and "reflection_record_semantic_work"."accepted_model_binding"->>'kind' = 'service'
      and "reflection_record_semantic_work"."accepted_model_binding"->>'role' = 'memoryReflection'
    then 'binding:' || encode(sha256(jsonb_send("reflection_record_semantic_work"."accepted_model_binding")), 'hex')
    else null
  end
        is not null;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_semantic_work_manual_recovery_grant" ON "reflection_record_semantic_work" USING btree ("manual_recovery_id","record_id") WHERE "reflection_record_semantic_work"."manual_recovery_id" is not null;