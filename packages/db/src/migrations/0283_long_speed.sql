ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_kind";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_purpose";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_purpose_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_subject_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_work_subject_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_descriptor_coherent";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_response_coherent";--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" DROP CONSTRAINT "processor_crypto_signer_authorizations_processor";--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" DROP CONSTRAINT "processor_crypto_signer_authorizations_descriptor_size";--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" DROP CONSTRAINT "processor_crypto_signer_authorizations_authorization_size";--> statement-breakpoint
ALTER TABLE "reflection_record_authority_reconciliations" DROP CONSTRAINT "reflection_record_authority_reconciliation_completion_coherent";--> statement-breakpoint
ALTER TABLE "reflection_record_authority_reconciliations" ADD COLUMN "target_access_namespace_ids" text[];--> statement-breakpoint
ALTER TABLE "reflection_record_authority_reconciliations" ADD COLUMN "target_audience_set_commitment" "bytea";--> statement-breakpoint
ALTER TABLE "reflection_record_authority_reconciliations" ADD COLUMN "target_crypto_retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_legacy_carrier_bounds" CHECK ("background_crypto_authorization_requests"."processor_kind" is not distinct from 'reflection' or (
        ("background_crypto_authorization_requests"."descriptor_bytes" is null or octet_length("background_crypto_authorization_requests"."descriptor_bytes") <= 131072)
        and ("background_crypto_authorization_requests"."accepted_response_kind" is distinct from 'processor'
          or "background_crypto_authorization_requests"."accepted_response_bytes" is null
          or octet_length("background_crypto_authorization_requests"."accepted_response_bytes") <= 200704)
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_kind" CHECK ("background_crypto_authorization_requests"."work_kind" in (
        'stenographer.extraction',
        'stenographer.historical',
        'stenographer.compaction',
        'stenographer.rebuild',
        'stenographer.publication_reconcile',
        'stenographer.output_repair',
        'reflection.authority_reproject',
        'reflection.publication_reconcile',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.approval_resume'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_purpose" CHECK ("background_crypto_authorization_requests"."purpose" in (
        'journal.extract',
        'journal.compact',
        'journal.rebuild',
        'journal.reconcile',
        'journal.repair',
        'record.reproject',
        'record.reconcile',
        'memory.review',
        'memory.exit_flush',
        'task.dispatch',
        'task.execute',
        'task.approval_resume'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_purpose_coherent" CHECK ((
        "background_crypto_authorization_requests"."work_kind" in (
          'stenographer.extraction',
          'stenographer.historical'
        ) and "background_crypto_authorization_requests"."purpose" = 'journal.extract'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.compaction'
        and "background_crypto_authorization_requests"."purpose" = 'journal.compact'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.rebuild'
        and "background_crypto_authorization_requests"."purpose" = 'journal.rebuild'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.publication_reconcile'
        and "background_crypto_authorization_requests"."format_version" in (2, 3)
        and "background_crypto_authorization_requests"."purpose" = 'journal.reconcile'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'stenographer.output_repair'
        and "background_crypto_authorization_requests"."format_version" in (2, 3)
        and "background_crypto_authorization_requests"."purpose" = 'journal.repair'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'reflection.authority_reproject'
        and "background_crypto_authorization_requests"."format_version" = 2
        and "background_crypto_authorization_requests"."purpose" = 'record.reproject'
      ) or (
        "background_crypto_authorization_requests"."work_kind" = 'reflection.publication_reconcile'
        and "background_crypto_authorization_requests"."format_version" = 2
        and "background_crypto_authorization_requests"."purpose" = 'record.reconcile'
      ) or "background_crypto_authorization_requests"."work_kind" = "background_crypto_authorization_requests"."purpose");--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_subject_coherent" CHECK ((
        "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
        and ("background_crypto_authorization_requests"."processor_kind" = 'stenographer'
          or ("background_crypto_authorization_requests"."processor_kind" = 'reflection' and "background_crypto_authorization_requests"."format_version" = 2))
        and "background_crypto_authorization_requests"."processor_version" = 1
        and (
          ("background_crypto_authorization_requests"."format_version" = 1
            and "background_crypto_authorization_requests"."processor_authorization_revision" is not null)
          or ("background_crypto_authorization_requests"."format_version" in (2, 3)
            and "background_crypto_authorization_requests"."processor_authorization_revision" is null)
        )
        and "background_crypto_authorization_requests"."agent_id" is null
        and "background_crypto_authorization_requests"."agent_runtime_generation" is null
        and "background_crypto_authorization_requests"."agent_authorization_revision" is null
      ) or (
        "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'
        and "background_crypto_authorization_requests"."processor_kind" is null
        and "background_crypto_authorization_requests"."processor_version" is null
        and "background_crypto_authorization_requests"."processor_authorization_revision" is null
        and "background_crypto_authorization_requests"."agent_id" is not null
        and "background_crypto_authorization_requests"."agent_runtime_generation" is not null
        and "background_crypto_authorization_requests"."agent_authorization_revision" is not null
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_work_subject_coherent" CHECK ((
        ("background_crypto_authorization_requests"."work_kind" like 'stenographer.%' and "background_crypto_authorization_requests"."processor_kind" = 'stenographer'
          or "background_crypto_authorization_requests"."work_kind" like 'reflection.%' and "background_crypto_authorization_requests"."processor_kind" = 'reflection')
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'processor'
      ) or (
        "background_crypto_authorization_requests"."work_kind" not like 'stenographer.%'
        and "background_crypto_authorization_requests"."work_kind" not like 'reflection.%'
        and "background_crypto_authorization_requests"."credential_subject_kind" = 'agent'
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_descriptor_coherent" CHECK ((
        "background_crypto_authorization_requests"."descriptor_hash" is null
        and "background_crypto_authorization_requests"."descriptor_bytes" is null
      ) or (
        "background_crypto_authorization_requests"."descriptor_hash" is not null
        and "background_crypto_authorization_requests"."descriptor_bytes" is not null
        and octet_length("background_crypto_authorization_requests"."descriptor_hash")
          = 32
        and octet_length("background_crypto_authorization_requests"."descriptor_bytes") between 1
          and 15933355
      ));--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" ADD CONSTRAINT "background_crypto_authorization_requests_response_coherent" CHECK ((
        "background_crypto_authorization_requests"."accepted_response_kind" is null
        and "background_crypto_authorization_requests"."accepted_response_hash" is null
        and "background_crypto_authorization_requests"."accepted_response_bytes" is null
        and "background_crypto_authorization_requests"."credential_id" is null
        and "background_crypto_authorization_requests"."credential_hash" is null
        and "background_crypto_authorization_requests"."issuing_human_id" is null
        and "background_crypto_authorization_requests"."issuing_device_id" is null
        and "background_crypto_authorization_requests"."issuing_device_authorization_revision" is null
        and "background_crypto_authorization_requests"."issuer_signing_public_key_hash" is null
        and "background_crypto_authorization_requests"."accepted_at" is null
        and "background_crypto_authorization_requests"."authorization_expires_at" is null
      ) or (
        "background_crypto_authorization_requests"."accepted_response_kind" = "background_crypto_authorization_requests"."credential_subject_kind"
        and "background_crypto_authorization_requests"."accepted_response_hash" is not null
        and "background_crypto_authorization_requests"."accepted_response_bytes" is not null
        and octet_length("background_crypto_authorization_requests"."accepted_response_hash")
          = 32
        and (
          (
            "background_crypto_authorization_requests"."accepted_response_kind" = 'processor'
            and octet_length("background_crypto_authorization_requests"."accepted_response_bytes") between 1
              and 34621355
          ) or (
            "background_crypto_authorization_requests"."accepted_response_kind" = 'agent'
            and octet_length("background_crypto_authorization_requests"."accepted_response_bytes") between 1
              and 16912384
          )
        )
        and "background_crypto_authorization_requests"."credential_id" is not null
        and "background_crypto_authorization_requests"."credential_hash" is not null
        and octet_length("background_crypto_authorization_requests"."credential_hash")
          = 32
        and "background_crypto_authorization_requests"."issuing_human_id" is not null
        and "background_crypto_authorization_requests"."issuing_device_id" is not null
        and "background_crypto_authorization_requests"."issuing_device_authorization_revision" is not null
        and "background_crypto_authorization_requests"."issuer_signing_public_key_hash" is not null
        and octet_length("background_crypto_authorization_requests"."issuer_signing_public_key_hash")
          = 32
        and "background_crypto_authorization_requests"."accepted_at" is not null
        and "background_crypto_authorization_requests"."authorization_expires_at" is not null
      ));--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD CONSTRAINT "processor_crypto_signer_authorizations_legacy_carrier_bounds" CHECK ("processor_crypto_signer_authorizations"."processor_kind" is not distinct from 'reflection' or (
        octet_length("processor_crypto_signer_authorizations"."work_descriptor_bytes") <= 131072
        and octet_length("processor_crypto_signer_authorizations"."authorization_bytes") <= 131072
      ));--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD CONSTRAINT "processor_crypto_signer_authorizations_processor" CHECK (("processor_crypto_signer_authorizations"."processor_kind" = 'stenographer'
        or ("processor_crypto_signer_authorizations"."processor_kind" = 'reflection' and "processor_crypto_signer_authorizations"."format_version" = 2))
        and "processor_crypto_signer_authorizations"."processor_version" = 1);--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD CONSTRAINT "processor_crypto_signer_authorizations_descriptor_size" CHECK (octet_length("processor_crypto_signer_authorizations"."work_descriptor_bytes") between 1
      and 15933355);--> statement-breakpoint
ALTER TABLE "processor_crypto_signer_authorizations" ADD CONSTRAINT "processor_crypto_signer_authorizations_authorization_size" CHECK (octet_length("processor_crypto_signer_authorizations"."authorization_bytes") between 1
      and 15934231);--> statement-breakpoint
ALTER TABLE "reflection_record_authority_reconciliations" ADD CONSTRAINT "reflection_record_authority_reconciliation_target_access_coherent" CHECK (("reflection_record_authority_reconciliations"."target_access_namespace_ids" is null and "reflection_record_authority_reconciliations"."target_audience_set_commitment" is null)
        or ("reflection_record_authority_reconciliations"."target_crypto_object_id" is not null
          and "reflection_record_authority_reconciliations"."target_access_namespace_ids" is not null
          and "reflection_record_authority_reconciliations"."target_audience_set_commitment" is not null
          and cardinality("reflection_record_authority_reconciliations"."target_access_namespace_ids") between 1 and 256
          and array_position("reflection_record_authority_reconciliations"."target_access_namespace_ids", null) is null
          and octet_length("reflection_record_authority_reconciliations"."target_audience_set_commitment") = 32));--> statement-breakpoint
ALTER TABLE "reflection_record_authority_reconciliations" ADD CONSTRAINT "reflection_record_authority_reconciliation_target_retirement_coherent" CHECK ("reflection_record_authority_reconciliations"."target_crypto_retired_at" is null or
        ("reflection_record_authority_reconciliations"."target_crypto_object_id" is not null and "reflection_record_authority_reconciliations"."state" = 'quarantined'));--> statement-breakpoint
ALTER TABLE "reflection_record_authority_reconciliations" ADD CONSTRAINT "reflection_record_authority_reconciliation_completion_coherent" CHECK (("reflection_record_authority_reconciliations"."state" = 'complete' and "reflection_record_authority_reconciliations"."completed_at" is not null)
        or ("reflection_record_authority_reconciliations"."state" <> 'complete' and ("reflection_record_authority_reconciliations"."completed_at" is null
          or ("reflection_record_authority_reconciliations"."target_crypto_object_id" is not null and "reflection_record_authority_reconciliations"."state" in ('crypto_complete', 'attached', 'quarantined')))));
--> statement-breakpoint
-- M327 REFLECTION AUTHORITY RECEIPT AUGMENTATION FINALIZER
CREATE OR REPLACE FUNCTION "public"."reflection_authority_guard_reconciliation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  augmenting boolean;
  checkpoint_pause boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reflection authority reconciliation receipts cannot be deleted';
  END IF;
  augmenting := OLD.state = 'complete' AND OLD.target_crypto_object_id IS NULL
    AND NEW.state IN ('crypto_complete', 'quarantined')
    AND NEW.target_crypto_object_id IS NOT NULL
    AND NEW.target_representation_generation IS NOT NULL
    AND ((NEW.target_access_namespace_ids IS NOT NULL
      AND NEW.target_audience_set_commitment IS NOT NULL)
      OR (NEW.state = 'quarantined'
        AND NEW.target_access_namespace_ids IS NULL
        AND NEW.target_audience_set_commitment IS NULL))
    AND NEW.target_crypto_retired_at IS NULL
    AND OLD.sealed_checkpoint IS NOT DISTINCT FROM NEW.sealed_checkpoint
    AND OLD.attempt_count IS NOT DISTINCT FROM NEW.attempt_count
    AND OLD.lease_token IS NOT DISTINCT FROM NEW.lease_token
    AND OLD.lease_expires_at IS NOT DISTINCT FROM NEW.lease_expires_at
    AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
    AND (NEW.failure_code IS NULL OR NEW.failure_code = 'mapping_conflict')
    AND OLD.completed_at IS NOT DISTINCT FROM NEW.completed_at
    AND OLD.former_crypto_retired_at IS NOT DISTINCT FROM NEW.former_crypto_retired_at;
  checkpoint_pause := OLD.state = 'leased'
    AND NEW.state = 'pending'
    AND OLD.lease_token IS NOT NULL
    AND OLD.lease_expires_at IS NOT NULL
    AND NEW.lease_token IS NULL
    AND NEW.lease_expires_at IS NULL
    AND NEW.next_attempt_at IS NOT NULL
    AND NEW.failure_code IS NULL
    AND NEW.sealed_checkpoint IS NOT NULL
    AND OLD.target_representation_generation IS NULL
    AND NEW.target_representation_generation IS NULL
    AND OLD.target_crypto_object_id IS NULL
    AND NEW.target_crypto_object_id IS NULL
    AND OLD.target_access_namespace_ids IS NULL
    AND NEW.target_access_namespace_ids IS NULL
    AND OLD.target_audience_set_commitment IS NULL
    AND NEW.target_audience_set_commitment IS NULL
    AND OLD.target_crypto_retired_at IS NULL
    AND NEW.target_crypto_retired_at IS NULL
    AND OLD.former_crypto_object_id IS NULL
    AND NEW.former_crypto_object_id IS NULL
    AND OLD.former_crypto_retired_at IS NULL
    AND NEW.former_crypto_retired_at IS NULL
    AND OLD.completed_at IS NULL
    AND NEW.completed_at IS NULL
    AND NEW.attempt_count = OLD.attempt_count - 1;
  IF OLD.reconciliation_id IS DISTINCT FROM NEW.reconciliation_id
     OR OLD.record_id IS DISTINCT FROM NEW.record_id
     OR OLD.expected_projection_generation IS DISTINCT FROM NEW.expected_projection_generation
     OR OLD.source_change_generation IS DISTINCT FROM NEW.source_change_generation
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Reflection authority reconciliation identity is immutable';
  END IF;
  IF OLD.state = 'complete' AND NOT (augmenting OR (
    NEW.state = 'complete'
    AND OLD.former_crypto_object_id IS NOT NULL
    AND OLD.former_crypto_retired_at IS NULL
    AND NEW.former_crypto_retired_at IS NOT NULL
    AND OLD.sealed_checkpoint IS NOT DISTINCT FROM NEW.sealed_checkpoint
    AND OLD.attempt_count IS NOT DISTINCT FROM NEW.attempt_count
    AND OLD.lease_token IS NOT DISTINCT FROM NEW.lease_token
    AND OLD.lease_expires_at IS NOT DISTINCT FROM NEW.lease_expires_at
    AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
    AND OLD.failure_code IS NOT DISTINCT FROM NEW.failure_code
    AND OLD.target_representation_generation IS NOT DISTINCT FROM NEW.target_representation_generation
    AND OLD.target_crypto_object_id IS NOT DISTINCT FROM NEW.target_crypto_object_id
    AND OLD.former_crypto_object_id IS NOT DISTINCT FROM NEW.former_crypto_object_id
    AND OLD.completed_at IS NOT DISTINCT FROM NEW.completed_at
    AND OLD.target_access_namespace_ids IS NOT DISTINCT FROM NEW.target_access_namespace_ids
    AND OLD.target_audience_set_commitment IS NOT DISTINCT FROM NEW.target_audience_set_commitment
    AND OLD.target_crypto_retired_at IS NOT DISTINCT FROM NEW.target_crypto_retired_at
  )) THEN
    RAISE EXCEPTION 'Completed Reflection authority reconciliation is immutable except retirement acknowledgement';
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state AND NOT (augmenting OR
    (OLD.state = 'pending' AND NEW.state IN ('leased', 'crypto_complete', 'complete', 'quarantined'))
    OR (OLD.state = 'leased' AND NEW.state IN ('pending', 'crypto_complete', 'complete', 'quarantined'))
    OR (OLD.state = 'crypto_complete' AND NEW.state IN ('attached', 'complete', 'quarantined'))
    OR (OLD.state = 'attached' AND NEW.state IN ('complete', 'quarantined'))
    OR (OLD.state = 'quarantined' AND NEW.state = 'pending' AND OLD.target_crypto_object_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Invalid Reflection authority reconciliation state transition';
  END IF;
  IF (NEW.attempt_count < OLD.attempt_count AND NOT checkpoint_pause)
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'Invalid Reflection authority reconciliation attempt transition';
  END IF;
  IF OLD.target_crypto_object_id IS NOT NULL
     AND OLD.target_crypto_object_id IS DISTINCT FROM NEW.target_crypto_object_id THEN
    RAISE EXCEPTION 'Reflection authority target crypto identity is immutable';
  END IF;
  IF (OLD.target_representation_generation IS NOT NULL AND OLD.target_representation_generation IS DISTINCT FROM NEW.target_representation_generation)
     OR (OLD.target_access_namespace_ids IS NOT NULL AND OLD.target_access_namespace_ids IS DISTINCT FROM NEW.target_access_namespace_ids)
     OR (OLD.target_audience_set_commitment IS NOT NULL AND OLD.target_audience_set_commitment IS DISTINCT FROM NEW.target_audience_set_commitment)
     OR (OLD.target_crypto_retired_at IS NOT NULL AND OLD.target_crypto_retired_at IS DISTINCT FROM NEW.target_crypto_retired_at)
     OR (OLD.completed_at IS NOT NULL AND OLD.completed_at IS DISTINCT FROM NEW.completed_at) THEN
    RAISE EXCEPTION 'Reflection authority materialization and logical completion are immutable';
  END IF;
  IF OLD.former_crypto_object_id IS NOT NULL
     AND OLD.former_crypto_object_id IS DISTINCT FROM NEW.former_crypto_object_id THEN
    RAISE EXCEPTION 'Reflection authority former crypto identity is immutable';
  END IF;
  IF OLD.former_crypto_retired_at IS NOT NULL
     AND OLD.former_crypto_retired_at IS DISTINCT FROM NEW.former_crypto_retired_at THEN
    RAISE EXCEPTION 'Reflection authority former crypto retirement is immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Reflection authority reconciliation time cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

