ALTER TABLE "memory_crypto_operations" DROP CONSTRAINT "memory_crypto_operations_shape";--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ADD CONSTRAINT "memory_crypto_operations_shape" CHECK ((
          "memory_crypto_operations"."operation_type" = 'update'
          and "memory_crypto_operations"."result_content_revision" = "memory_crypto_operations"."expected_content_revision" + 1
          and "memory_crypto_operations"."result_access_revision" is null
          and "memory_crypto_operations"."target_required_namespace_fingerprint" is null
        ) or (
          "memory_crypto_operations"."operation_type" = 'access'
          and "memory_crypto_operations"."result_content_revision" is null
          and "memory_crypto_operations"."result_access_revision" = "memory_crypto_operations"."expected_access_revision" + 1
          and octet_length("memory_crypto_operations"."target_required_namespace_fingerprint") = 32
        ) or (
          "memory_crypto_operations"."operation_type" = 'delete'
          and "memory_crypto_operations"."result_content_revision" is null
          and "memory_crypto_operations"."result_access_revision" is null
          and "memory_crypto_operations"."target_required_namespace_fingerprint" is null
        ) or (
          "memory_crypto_operations"."operation_type" = 'metadata'
          and "memory_crypto_operations"."result_content_revision" is null
          and "memory_crypto_operations"."result_access_revision" is null
          and "memory_crypto_operations"."target_required_namespace_fingerprint" is null
        ));