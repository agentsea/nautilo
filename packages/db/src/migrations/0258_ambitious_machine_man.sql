ALTER TABLE "memory_crypto_operations" DROP CONSTRAINT "memory_crypto_operations_human_outcome_coherent";--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD CONSTRAINT "memory_crypto_operations_human_outcome_coherent" CHECK ("memory_crypto_operations"."human_product_outcome" is null or (
          "memory_crypto_operations"."completion" in ('complete', 'ordinary_fallback')
          and "memory_crypto_operations"."disposition" = 'complete'
        ));