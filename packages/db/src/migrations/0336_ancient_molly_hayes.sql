ALTER TABLE "conversion_operations" DROP CONSTRAINT "conversion_operations_provider_job_phase";--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD CONSTRAINT "conversion_operations_provider_job_phase" CHECK ((
        ("conversion_operations"."status" IN ('prepared', 'submitting', 'submission_unknown', 'recovery_ambiguous') AND "conversion_operations"."provider_job_id" IS NULL)
        OR ("conversion_operations"."status" NOT IN ('prepared', 'submitting', 'submission_unknown', 'recovery_ambiguous') AND "conversion_operations"."provider_job_id" IS NOT NULL)
        OR ("conversion_operations"."status" = 'cancelled' AND "conversion_operations"."provider_job_id" IS NULL
          AND "conversion_operations"."failure_code" IS NOT DISTINCT FROM 'cancelled_before_provider_dispatch')
      ));