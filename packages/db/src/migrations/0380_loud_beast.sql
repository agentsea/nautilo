ALTER TABLE "object_crypto_access_manifests" DROP CONSTRAINT "object_crypto_access_manifests_signer_evidence_size";--> statement-breakpoint
ALTER TABLE "object_crypto_access_manifests" ADD CONSTRAINT "object_crypto_access_manifests_signer_evidence_size" CHECK ("object_crypto_access_manifests"."signer_evidence_bytes" is null or (
        octet_length("object_crypto_access_manifests"."signer_evidence_bytes") between 1
        and 3675
      ));