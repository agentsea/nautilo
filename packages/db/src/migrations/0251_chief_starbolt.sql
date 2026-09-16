ALTER TABLE "memory_crypto_operations" ADD COLUMN "foreground_stable_request_digest" "bytea";--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD COLUMN "foreground_mutation_kind" text;--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD COLUMN "foreground_required_namespace_ids" uuid[];--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD COLUMN "foreground_save_similarity" double precision;--> statement-breakpoint
CREATE INDEX "idx_memory_crypto_operations_unacknowledged_semantic_effect" ON "memory_crypto_operations" USING btree ("sequence") WHERE "memory_crypto_operations"."completion" = 'complete'
          and "memory_crypto_operations"."semantic_change_kind" is not null
          and "memory_crypto_operations"."semantic_change_acknowledged_at" is null;--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD CONSTRAINT "memory_crypto_operations_foreground_replay_coherent" CHECK ((
          "memory_crypto_operations"."foreground_stable_request_digest" is null
          and "memory_crypto_operations"."foreground_mutation_kind" is null
          and "memory_crypto_operations"."foreground_required_namespace_ids" is null
          and "memory_crypto_operations"."foreground_save_similarity" is null
        ) or (
          octet_length("memory_crypto_operations"."foreground_stable_request_digest") = 32
          and "memory_crypto_operations"."foreground_mutation_kind" in ('save', 'replace', 'promote', 'demote')
          and cardinality("memory_crypto_operations"."foreground_required_namespace_ids") > 0
          and (
            ("memory_crypto_operations"."foreground_mutation_kind" = 'save'
              and ("memory_crypto_operations"."foreground_save_similarity" is null
                or "memory_crypto_operations"."foreground_save_similarity" between -1 and 1))
            or ("memory_crypto_operations"."foreground_mutation_kind" <> 'save'
              and "memory_crypto_operations"."foreground_save_similarity" is null)
          )
        ));