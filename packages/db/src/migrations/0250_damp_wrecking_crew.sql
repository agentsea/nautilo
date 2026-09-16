ALTER TABLE "memory_crypto_operations" ADD COLUMN "semantic_change_kind" text;--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD COLUMN "semantic_change_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD CONSTRAINT "memory_crypto_operations_semantic_change_ack_coherent" CHECK ((
          "memory_crypto_operations"."semantic_change_kind" is null
          or "memory_crypto_operations"."semantic_change_kind" in (
            'replace', 'demote', 'archive', 'restore', 'scope', 'delete'
          )
        ) and (
          "memory_crypto_operations"."semantic_change_acknowledged_at" is null or (
            "memory_crypto_operations"."semantic_change_kind" is not null
            and "memory_crypto_operations"."completion" = 'complete'
          )
        ));