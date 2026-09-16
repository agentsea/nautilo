ALTER TABLE "memory_crypto_operations" DROP CONSTRAINT "memory_crypto_operations_completion_coherent";--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" DROP CONSTRAINT "memory_crypto_operations_semantic_change_ack_coherent";--> statement-breakpoint
DROP INDEX "idx_memory_crypto_operations_unacknowledged_semantic_effect";--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD COLUMN "ordinary_fallback_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD COLUMN "ordinary_fallback_reason" text;--> statement-breakpoint
CREATE INDEX "idx_memory_crypto_operations_unacknowledged_semantic_effect" ON "memory_crypto_operations" USING btree ("sequence") WHERE "memory_crypto_operations"."completion" in ('complete', 'ordinary_fallback')
          and "memory_crypto_operations"."semantic_change_kind" is not null
          and "memory_crypto_operations"."semantic_change_acknowledged_at" is null;--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD CONSTRAINT "memory_crypto_operations_completion_coherent" CHECK ((
          "memory_crypto_operations"."completion" = 'pending'
          and "memory_crypto_operations"."crypto_completed_at" is null
          and "memory_crypto_operations"."ordinary_fallback_completed_at" is null
          and "memory_crypto_operations"."ordinary_fallback_reason" is null
          and "memory_crypto_operations"."disposition" in ('active', 'blocked', 'quarantined')
        ) or (
          "memory_crypto_operations"."completion" = 'complete'
          and "memory_crypto_operations"."crypto_completed_at" is not null
          and "memory_crypto_operations"."ordinary_fallback_completed_at" is null
          and "memory_crypto_operations"."ordinary_fallback_reason" is null
          and "memory_crypto_operations"."disposition" = 'complete'
        ) or (
          "memory_crypto_operations"."completion" = 'ordinary_fallback'
          and "memory_crypto_operations"."crypto_completed_at" is null
          and "memory_crypto_operations"."ordinary_fallback_completed_at" is not null
          and "memory_crypto_operations"."ordinary_fallback_reason" in (
            'encryption_pending', 'target_encryption_not_ready'
          )
          and "memory_crypto_operations"."disposition" = 'complete'
        ));--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD CONSTRAINT "memory_crypto_operations_semantic_change_ack_coherent" CHECK ((
          "memory_crypto_operations"."semantic_change_kind" is null
          or "memory_crypto_operations"."semantic_change_kind" in (
            'replace', 'demote', 'archive', 'restore', 'scope', 'delete'
          )
        ) and (
          "memory_crypto_operations"."semantic_change_acknowledged_at" is null or (
            "memory_crypto_operations"."semantic_change_kind" is not null
            and "memory_crypto_operations"."completion" in ('complete', 'ordinary_fallback')
          )
        ));