DROP INDEX "idx_reflection_record_semantic_work_manual_recovery_family";--> statement-breakpoint
CREATE INDEX "memory_review_open_scope_order" ON "memory_review_turns" USING btree ("session_id","agent_id","owner_id","access_scope","first_message_id","id") WHERE "memory_review_turns"."receipt_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_semantic_work_manual_recovery_binding" ON "reflection_record_semantic_work" USING btree ((case
    when "accepted_model_binding"->>'version' = '1'
      and "accepted_model_binding"->>'kind' = 'service'
      and "accepted_model_binding"->>'role' = 'memoryReflection'
    then 'binding:' || encode(sha256(jsonb_send("accepted_model_binding")), 'hex')
    else null
  end),"record_id") WHERE "reflection_record_semantic_work"."state" in ('complete', 'quarantined');--> statement-breakpoint
CREATE INDEX "idx_reflection_record_semantic_work_manual_recovery_grant" ON "reflection_record_semantic_work" USING btree ("manual_recovery_id","record_id") WHERE "reflection_record_semantic_work"."state" in ('complete', 'quarantined')
        and "reflection_record_semantic_work"."manual_recovery_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_reflection_record_semantic_work_derived_recovery_cursor" ON "reflection_record_semantic_work" USING btree (('derived:' || encode(sha256(jsonb_send(
    jsonb_object(array['record', "record_id"])
  )), 'hex')),"record_id") WHERE "reflection_record_semantic_work"."state" = 'quarantined';--> statement-breakpoint
CREATE INDEX "idx_reflection_record_semantic_work_manual_recovery_family" ON "reflection_record_semantic_work" USING btree ((case
    when "manual_recovery_id" is not null
    then 'recovery:' || "manual_recovery_id"::text
    when case
    when "accepted_model_binding"->>'version' = '1'
      and "accepted_model_binding"->>'kind' = 'service'
      and "accepted_model_binding"->>'role' = 'memoryReflection'
    then 'binding:' || encode(sha256(jsonb_send("accepted_model_binding")), 'hex')
    else null
  end is not null
    then case
    when "accepted_model_binding"->>'version' = '1'
      and "accepted_model_binding"->>'kind' = 'service'
      and "accepted_model_binding"->>'role' = 'memoryReflection'
    then 'binding:' || encode(sha256(jsonb_send("accepted_model_binding")), 'hex')
    else null
  end
    else 'record:' || md5("record_id")
  end),"record_id") WHERE "reflection_record_semantic_work"."state" in ('complete', 'quarantined');