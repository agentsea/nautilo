ALTER TABLE "tasks" ADD COLUMN "ordinary_fallback_operation_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ordinary_fallback_request_digest" "bytea";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ordinary_fallback_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ordinary_fallback_policy_revision" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ordinary_fallback_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ordinary_fallback_receipt_coherent" CHECK ((
      "tasks"."ordinary_fallback_operation_id" is null
      and "tasks"."ordinary_fallback_request_digest" is null
      and "tasks"."ordinary_fallback_reason" is null
      and "tasks"."ordinary_fallback_policy_revision" is null
      and "tasks"."ordinary_fallback_completed_at" is null
    ) or (
      "tasks"."ordinary_fallback_operation_id" is not null
      and length("tasks"."ordinary_fallback_operation_id") > 0
      and "tasks"."ordinary_fallback_request_digest" is not null
      and octet_length("tasks"."ordinary_fallback_request_digest") = 32
      and "tasks"."ordinary_fallback_reason" is not null
      and "tasks"."ordinary_fallback_reason" = 'target_encryption_not_ready'
      and "tasks"."ordinary_fallback_policy_revision" is not null
      and "tasks"."ordinary_fallback_policy_revision" > 0
      and "tasks"."ordinary_fallback_completed_at" is not null
    ));