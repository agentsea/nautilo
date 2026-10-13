ALTER TABLE "media_generations" ADD COLUMN "cancellation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "cancellation_provider_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_cancellation_shape" CHECK (
      ("media_generations"."cancellation_provider_acknowledged_at" is null or "media_generations"."cancellation_requested_at" is not null)
      and ("media_generations"."cancellation_requested_at" is null or (
        "media_generations"."provider" = 'surplus'
        and "media_generations"."provider_queue_id" is not null
        and "media_generations"."accepted_at" is not null
      ))
      and ("media_generations"."cancellation_provider_acknowledged_at" is null or "media_generations"."cancellation_provider_acknowledged_at" >= "media_generations"."cancellation_requested_at")
    );