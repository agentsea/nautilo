ALTER TABLE "conversion_operations" ADD COLUMN "submission_lease_id" varchar(64);--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD COLUMN "submission_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD COLUMN "cancellation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversion_operations" ADD CONSTRAINT "conversion_operations_submission_lease" CHECK ((
        ("conversion_operations"."status" = 'submitting' AND "conversion_operations"."submission_lease_id" IS NOT NULL AND "conversion_operations"."submission_lease_expires_at" IS NOT NULL)
        OR ("conversion_operations"."status" <> 'submitting' AND "conversion_operations"."submission_lease_id" IS NULL AND "conversion_operations"."submission_lease_expires_at" IS NULL)
      ));