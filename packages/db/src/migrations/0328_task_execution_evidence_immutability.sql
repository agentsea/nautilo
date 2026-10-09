-- Custom SQL migration file, put your code below! --
--> statement-breakpoint
-- TASK_EXECUTION_EVIDENCE_IMMUTABILITY
CREATE OR REPLACE FUNCTION "public"."guard_task_execution_evidence"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'TRUNCATE' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Task execution evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME IN (
      'task_run_message_associations',
      'protected_task_execution_segment_receipts'
    ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.task_runs WHERE id = OLD.task_run_id
      ) THEN RETURN OLD; END IF;
    END IF;
    IF TG_TABLE_NAME = 'protected_task_continuation_receipts' THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.protected_task_execution_segment_receipts
        WHERE task_run_id = OLD.task_run_id
          AND execution_segment = OLD.execution_segment
          AND job_id = OLD.job_id
      ) THEN RETURN OLD; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'Task execution evidence is immutable' USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
GRANT TRIGGER ON TABLE
  "task_run_message_associations",
  "protected_task_execution_segment_receipts",
  "protected_task_continuation_receipts"
TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "task_run_message_associations_immutable_row"
BEFORE UPDATE OR DELETE ON "task_run_message_associations"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
CREATE TRIGGER "task_run_message_associations_immutable_table"
BEFORE TRUNCATE ON "task_run_message_associations"
FOR EACH STATEMENT EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
CREATE TRIGGER "protected_task_execution_segment_receipts_immutable_row"
BEFORE UPDATE OR DELETE ON "protected_task_execution_segment_receipts"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
CREATE TRIGGER "protected_task_execution_segment_receipts_immutable_table"
BEFORE TRUNCATE ON "protected_task_execution_segment_receipts"
FOR EACH STATEMENT EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
CREATE TRIGGER "protected_task_continuation_receipts_immutable_row"
BEFORE UPDATE OR DELETE ON "protected_task_continuation_receipts"
FOR EACH ROW EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
CREATE TRIGGER "protected_task_continuation_receipts_immutable_table"
BEFORE TRUNCATE ON "protected_task_continuation_receipts"
FOR EACH STATEMENT EXECUTE FUNCTION "public"."guard_task_execution_evidence"();--> statement-breakpoint
REVOKE TRIGGER ON TABLE
  "task_run_message_associations",
  "protected_task_execution_segment_receipts",
  "protected_task_continuation_receipts"
FROM "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "task_run_message_associations",
  "protected_task_execution_segment_receipts",
  "protected_task_continuation_receipts"
FROM "nautilo";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE
  "task_run_message_associations",
  "protected_task_execution_segment_receipts",
  "protected_task_continuation_receipts"
TO "nautilo";--> statement-breakpoint
GRANT UPDATE ("task_run_id")
ON TABLE "protected_task_execution_segment_receipts" TO "nautilo";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."guard_task_execution_evidence"()
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
