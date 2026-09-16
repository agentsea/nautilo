-- D525 — provider processing timing is presentation-safe only after it is
-- normalized to whole seconds. The average is a typical/P80 duration, never a
-- predicted remaining time or completion percentage.
ALTER TABLE "media_generations"
  ADD COLUMN "provider_execution_seconds" integer,
  ADD COLUMN "provider_average_execution_seconds" integer;
--> statement-breakpoint
ALTER TABLE "media_generations"
  ADD CONSTRAINT "media_generations_provider_timing_nonnegative"
  CHECK (
    ("provider_execution_seconds" is null or "provider_execution_seconds" between 0 and 2147483647)
    and ("provider_average_execution_seconds" is null or "provider_average_execution_seconds" between 0 and 2147483647)
  );
