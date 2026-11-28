ALTER TABLE "memory_review_model_recoveries" ADD COLUMN "source_revision_fingerprint" text;--> statement-breakpoint
ALTER TABLE "memory_review_model_recoveries" ADD COLUMN "source_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_review_model_recoveries" ADD CONSTRAINT "memory_review_model_recovery_source_fingerprint" CHECK (
    "memory_review_model_recoveries"."source_revision_fingerprint" is null
    or "memory_review_model_recoveries"."source_revision_fingerprint" ~ '^[0-9a-f]{64}$'
  );