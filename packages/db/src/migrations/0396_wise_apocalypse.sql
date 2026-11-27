CREATE INDEX "idx_reflection_record_semantic_work_manual_recovery_family" ON "reflection_record_semantic_work" USING btree ((case
    when "accepted_model_binding"->>'version' = '1'
      and "accepted_model_binding"->>'kind' = 'service'
      and "accepted_model_binding"->>'role' = 'memoryReflection'
    then 'binding:' || encode(sha256(jsonb_send("accepted_model_binding")), 'hex')
    when "manual_recovery_id" is not null
    then 'recovery:' || "manual_recovery_id"::text
    else 'record:' || md5("record_id")
  end),"record_id") WHERE "reflection_record_semantic_work"."state" in ('complete', 'quarantined');