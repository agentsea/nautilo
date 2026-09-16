ALTER TABLE "memory_crypto_operations" DROP CONSTRAINT "memory_crypto_operations_foreground_replay_coherent";--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD CONSTRAINT "memory_crypto_operations_foreground_replay_coherent" CHECK ((
          "memory_crypto_operations"."foreground_stable_request_digest" is null
          and "memory_crypto_operations"."foreground_mutation_kind" is null
          and "memory_crypto_operations"."foreground_required_namespace_ids" is null
          and "memory_crypto_operations"."foreground_save_similarity" is null
        ) or (
          "memory_crypto_operations"."foreground_stable_request_digest" is not null
          and "memory_crypto_operations"."foreground_mutation_kind" is not null
          and "memory_crypto_operations"."foreground_required_namespace_ids" is not null
          and octet_length("memory_crypto_operations"."foreground_stable_request_digest") = 32
          and "memory_crypto_operations"."foreground_mutation_kind" in ('save', 'replace', 'promote', 'demote')
          and cardinality("memory_crypto_operations"."foreground_required_namespace_ids") > 0
          and array_position("memory_crypto_operations"."foreground_required_namespace_ids", null) is null
          and (
            ("memory_crypto_operations"."foreground_mutation_kind" = 'save'
              and ("memory_crypto_operations"."foreground_save_similarity" is null
                or "memory_crypto_operations"."foreground_save_similarity" between -1 and 1))
            or ("memory_crypto_operations"."foreground_mutation_kind" <> 'save'
              and "memory_crypto_operations"."foreground_save_similarity" is null)
          )
        ));