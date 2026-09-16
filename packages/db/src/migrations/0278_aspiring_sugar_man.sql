ALTER TABLE "room_event_rollups" ADD COLUMN "ordinary_fallback_reason" text;--> statement-breakpoint
ALTER TABLE "room_event_rollups" ADD COLUMN "ordinary_fallback_rebuild_generation" integer;--> statement-breakpoint
ALTER TABLE "room_event_rollups" ADD COLUMN "ordinary_output_fingerprint" "bytea";--> statement-breakpoint
ALTER TABLE "room_journal_batches" ADD COLUMN "ordinary_fallback_reason" text;--> statement-breakpoint
ALTER TABLE "room_journal_batches" ADD COLUMN "ordinary_fallback_rebuild_generation" integer;--> statement-breakpoint
ALTER TABLE "room_journal_batches" ADD COLUMN "ordinary_output_fingerprint" "bytea";--> statement-breakpoint
ALTER TABLE "room_event_rollups" ADD CONSTRAINT "room_event_rollups_ordinary_fallback_provenance" CHECK ((
        "room_event_rollups"."ordinary_fallback_reason" IS NULL
        AND "room_event_rollups"."ordinary_fallback_rebuild_generation" IS NULL
        AND "room_event_rollups"."ordinary_output_fingerprint" IS NULL
      ) OR (
        "room_event_rollups"."ordinary_fallback_reason" IS NOT NULL
        AND "room_event_rollups"."ordinary_fallback_reason" IN ('device', 'authority')
        AND "room_event_rollups"."ordinary_fallback_rebuild_generation" IS NOT NULL
        AND "room_event_rollups"."ordinary_fallback_rebuild_generation" >= 0
        AND "room_event_rollups"."ordinary_output_fingerprint" IS NOT NULL
        AND octet_length("room_event_rollups"."ordinary_output_fingerprint") = 32
      ));--> statement-breakpoint
ALTER TABLE "room_journal_batches" ADD CONSTRAINT "room_journal_batches_ordinary_fallback_provenance" CHECK ((
        "room_journal_batches"."ordinary_fallback_reason" IS NULL
        AND "room_journal_batches"."ordinary_fallback_rebuild_generation" IS NULL
        AND "room_journal_batches"."ordinary_output_fingerprint" IS NULL
      ) OR (
        "room_journal_batches"."status" = 'completed'
        AND "room_journal_batches"."observation_publication_version" = 2
        AND "room_journal_batches"."ordinary_fallback_reason" IS NOT NULL
        AND "room_journal_batches"."ordinary_fallback_reason" IN ('device', 'authority')
        AND "room_journal_batches"."ordinary_fallback_rebuild_generation" IS NOT NULL
        AND "room_journal_batches"."ordinary_fallback_rebuild_generation" >= 0
        AND "room_journal_batches"."ordinary_output_fingerprint" IS NOT NULL
        AND octet_length("room_journal_batches"."ordinary_output_fingerprint") = 32
      ));