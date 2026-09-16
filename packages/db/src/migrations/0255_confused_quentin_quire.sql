ALTER TABLE "memory_crypto_operations" DROP CONSTRAINT "memory_crypto_operations_completion_coherent";--> statement-breakpoint
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
          and "memory_crypto_operations"."ordinary_fallback_reason" is not null
          and "memory_crypto_operations"."ordinary_fallback_reason" in (
            'encryption_pending', 'target_encryption_not_ready'
          )
          and "memory_crypto_operations"."disposition" = 'complete'
        ));