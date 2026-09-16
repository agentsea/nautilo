ALTER TABLE "artifact_crypto_operations" DROP CONSTRAINT "artifact_crypto_operations_shape";--> statement-breakpoint
ALTER TABLE "artifact_crypto_operations" ADD CONSTRAINT "artifact_crypto_operations_shape" CHECK ((
        "artifact_crypto_operations"."operation_type" = 'create'
        and "artifact_crypto_operations"."expected_artifact_revision" = 0
        and "artifact_crypto_operations"."result_artifact_revision" = 1
        and "artifact_crypto_operations"."expected_access_revision" = 0
        and "artifact_crypto_operations"."result_access_revision" = 0
        and "artifact_crypto_operations"."expected_blob_generation" = 0
        and "artifact_crypto_operations"."result_blob_generation" = 1
        and "artifact_crypto_operations"."expected_blob_id" is null
        and "artifact_crypto_operations"."expected_required_namespace_fingerprint" is null
      ) or (
        "artifact_crypto_operations"."operation_type" = 'content'
        and "artifact_crypto_operations"."expected_artifact_revision" > 0
        and "artifact_crypto_operations"."result_artifact_revision" = "artifact_crypto_operations"."expected_artifact_revision" + 1
        and "artifact_crypto_operations"."expected_access_revision" >= 0
        and "artifact_crypto_operations"."result_access_revision" = 0
        and "artifact_crypto_operations"."expected_blob_generation" > 0
        and "artifact_crypto_operations"."result_blob_generation" = "artifact_crypto_operations"."expected_blob_generation" + 1
        and "artifact_crypto_operations"."expected_blob_id" is not null
        and "artifact_crypto_operations"."result_blob_id" <> "artifact_crypto_operations"."expected_blob_id"
        and "artifact_crypto_operations"."expected_required_namespace_fingerprint" is not null
      ) or (
        "artifact_crypto_operations"."operation_type" = 'control'
        and "artifact_crypto_operations"."expected_artifact_revision" > 0
        and "artifact_crypto_operations"."result_artifact_revision" = "artifact_crypto_operations"."expected_artifact_revision" + 1
        and "artifact_crypto_operations"."expected_access_revision" >= 0
        and "artifact_crypto_operations"."result_access_revision" = 0
        and "artifact_crypto_operations"."expected_blob_generation" > 0
        and "artifact_crypto_operations"."result_blob_generation" = "artifact_crypto_operations"."expected_blob_generation"
        and "artifact_crypto_operations"."expected_blob_id" is not null
        and "artifact_crypto_operations"."result_blob_id" = "artifact_crypto_operations"."expected_blob_id"
        and "artifact_crypto_operations"."expected_required_namespace_fingerprint" is not null
      ) or (
        "artifact_crypto_operations"."operation_type" = 'access'
        and "artifact_crypto_operations"."expected_artifact_revision" > 0
        and "artifact_crypto_operations"."result_artifact_revision" = "artifact_crypto_operations"."expected_artifact_revision"
        and "artifact_crypto_operations"."expected_access_revision" >= 0
        and "artifact_crypto_operations"."result_access_revision" = "artifact_crypto_operations"."expected_access_revision" + 1
        and "artifact_crypto_operations"."expected_blob_generation" > 0
        and "artifact_crypto_operations"."result_blob_generation" = "artifact_crypto_operations"."expected_blob_generation"
        and "artifact_crypto_operations"."expected_blob_id" is not null
        and "artifact_crypto_operations"."result_blob_id" = "artifact_crypto_operations"."expected_blob_id"
        and "artifact_crypto_operations"."expected_required_namespace_fingerprint" is not null
      ));