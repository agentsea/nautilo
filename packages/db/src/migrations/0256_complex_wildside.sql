ALTER TABLE "encryption_transition_observation_admissions" DROP CONSTRAINT "encryption_transition_observation_admissions_vocabulary_check";--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_buckets" DROP CONSTRAINT "encryption_transition_observations_outcome_reason_coherent";--> statement-breakpoint
ALTER TABLE "encryption_transition_outcome_totals" DROP CONSTRAINT "encryption_transition_outcome_totals_vocabulary_check";--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_admissions" ADD CONSTRAINT "encryption_transition_observation_admissions_vocabulary_check" CHECK ("encryption_transition_observation_admissions"."family" in ('message', 'memory', 'artifact', 'record')
        and "encryption_transition_observation_admissions"."operation" in ('create', 'update', 'access_update', 'read', 'read_repair', 'unsupported'));--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_buckets" ADD CONSTRAINT "encryption_transition_observations_outcome_reason_coherent" CHECK ((
        ("encryption_transition_observation_buckets"."outcome" in ('verified', 'pending') and "encryption_transition_observation_buckets"."reason" = 'none')
        or ("encryption_transition_observation_buckets"."outcome" = 'reconciling' and "encryption_transition_observation_buckets"."reason" = 'response_lost')
        or ("encryption_transition_observation_buckets"."outcome" = 'unavailable' and "encryption_transition_observation_buckets"."reason" in (
          'unmigrated', 'unsupported_operation', 'client_crypto_unavailable',
          'client_crypto_preparation_failed', 'client_custody_unavailable',
          'current_read_authority_unavailable',
          'retained_key_material_unavailable', 'signer_evidence_unavailable',
          'live_shadow_lifecycle_unavailable',
          'namespace_encryption_not_ready', 'stale_authority_product',
          'client_observation_expired'
        ))
        or ("encryption_transition_observation_buckets"."outcome" = 'failed' and "encryption_transition_observation_buckets"."reason" in (
          'parity_mismatch', 'integrity_failure', 'publication_failure'
        ))
      ) and (
        ("encryption_transition_observation_buckets"."operation" = 'unsupported' and "encryption_transition_observation_buckets"."reason" = 'unsupported_operation')
        or ("encryption_transition_observation_buckets"."operation" <> 'unsupported' and "encryption_transition_observation_buckets"."reason" <> 'unsupported_operation')
      ) and (
        "encryption_transition_observation_buckets"."operation" <> 'read'
        or ("encryption_transition_observation_buckets"."family" in ('message', 'memory')
          and "encryption_transition_observation_buckets"."outcome" in ('verified', 'unavailable', 'failed')
          and "encryption_transition_observation_buckets"."reason" in (
            'none', 'client_crypto_unavailable', 'client_custody_unavailable',
            'current_read_authority_unavailable',
            'retained_key_material_unavailable', 'signer_evidence_unavailable',
            'live_shadow_lifecycle_unavailable', 'client_observation_expired',
            'integrity_failure', 'parity_mismatch'
          ))
      ) and (
        "encryption_transition_observation_buckets"."reason" not in (
          'current_read_authority_unavailable',
          'retained_key_material_unavailable', 'signer_evidence_unavailable',
          'live_shadow_lifecycle_unavailable'
        ) or "encryption_transition_observation_buckets"."operation" = 'read'
      ));--> statement-breakpoint
ALTER TABLE "encryption_transition_outcome_totals" ADD CONSTRAINT "encryption_transition_outcome_totals_vocabulary_check" CHECK ("encryption_transition_outcome_totals"."family" in ('message', 'memory', 'artifact', 'record')
        and "encryption_transition_outcome_totals"."operation" in ('create', 'update', 'access_update', 'read', 'read_repair', 'unsupported')
        and (
          ("encryption_transition_outcome_totals"."outcome" in ('verified', 'pending') and "encryption_transition_outcome_totals"."reason" = 'none')
          or ("encryption_transition_outcome_totals"."outcome" = 'reconciling' and "encryption_transition_outcome_totals"."reason" = 'response_lost')
          or ("encryption_transition_outcome_totals"."outcome" = 'unavailable' and "encryption_transition_outcome_totals"."reason" in (
            'unmigrated', 'unsupported_operation', 'client_crypto_unavailable',
            'client_crypto_preparation_failed', 'client_custody_unavailable',
            'current_read_authority_unavailable',
            'retained_key_material_unavailable', 'signer_evidence_unavailable',
            'live_shadow_lifecycle_unavailable',
            'namespace_encryption_not_ready', 'stale_authority_product',
            'client_observation_expired'
          ))
          or ("encryption_transition_outcome_totals"."outcome" = 'failed' and "encryption_transition_outcome_totals"."reason" in (
            'parity_mismatch', 'integrity_failure', 'publication_failure'
          ))
        )
        and (
          ("encryption_transition_outcome_totals"."operation" = 'unsupported' and "encryption_transition_outcome_totals"."reason" = 'unsupported_operation')
          or ("encryption_transition_outcome_totals"."operation" <> 'unsupported' and "encryption_transition_outcome_totals"."reason" <> 'unsupported_operation')
        )
        and (
          "encryption_transition_outcome_totals"."operation" <> 'read'
          or ("encryption_transition_outcome_totals"."family" in ('message', 'memory')
            and "encryption_transition_outcome_totals"."outcome" in ('verified', 'unavailable', 'failed')
            and "encryption_transition_outcome_totals"."reason" in (
              'none', 'client_crypto_unavailable', 'client_custody_unavailable',
              'current_read_authority_unavailable',
              'retained_key_material_unavailable', 'signer_evidence_unavailable',
              'live_shadow_lifecycle_unavailable', 'client_observation_expired',
              'integrity_failure', 'parity_mismatch'
            ))
        )
        and (
          "encryption_transition_outcome_totals"."reason" not in (
            'current_read_authority_unavailable',
            'retained_key_material_unavailable', 'signer_evidence_unavailable',
            'live_shadow_lifecycle_unavailable'
          ) or "encryption_transition_outcome_totals"."operation" = 'read'
        ));