ALTER TABLE "encryption_transition_history_read_admissions" DROP CONSTRAINT "encryption_transition_history_read_admissions_identity_shape";--> statement-breakpoint
ALTER TABLE "encryption_transition_history_read_admissions" DROP CONSTRAINT "encryption_transition_history_read_admissions_state_shape";--> statement-breakpoint
ALTER TABLE "encryption_transition_history_read_admissions" ADD COLUMN "selected_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "encryption_transition_history_read_admissions" ADD CONSTRAINT "encryption_transition_history_read_admissions_identity_shape" CHECK (length("encryption_transition_history_read_admissions"."operation_id") between 1 and 255
        and length("encryption_transition_history_read_admissions"."client_request_key") between 1 and 255
        and length("encryption_transition_history_read_admissions"."subject_human_id") between 1 and 255
        and "encryption_transition_history_read_admissions"."policy_revision" > 0
        and octet_length("encryption_transition_history_read_admissions"."selected_coordinate_digest") = 32
        and octet_length("encryption_transition_history_read_admissions"."token_digest") = 32
        and "encryption_transition_history_read_admissions"."selected_count" between 1 and 50
        and "encryption_transition_history_read_admissions"."eligible_count" between 0 and "encryption_transition_history_read_admissions"."selected_count");--> statement-breakpoint
ALTER TABLE "encryption_transition_history_read_admissions" ADD CONSTRAINT "encryption_transition_history_read_admissions_state_shape" CHECK ((
        "encryption_transition_history_read_admissions"."state" = 'planned'
        and "encryption_transition_history_read_admissions"."consumption_kind" is null
        and "encryption_transition_history_read_admissions"."acknowledgement_digest" is null
        and "encryption_transition_history_read_admissions"."ordered_result_set_digest" is null
        and "encryption_transition_history_read_admissions"."terminal_at" is null
        and "encryption_transition_history_read_admissions"."verified_count" + "encryption_transition_history_read_admissions"."client_crypto_unavailable_count"
          + "encryption_transition_history_read_admissions"."client_custody_unavailable_count"
          + "encryption_transition_history_read_admissions"."current_read_authority_unavailable_count"
          + "encryption_transition_history_read_admissions"."retained_key_material_unavailable_count"
          + "encryption_transition_history_read_admissions"."signer_evidence_unavailable_count"
          + "encryption_transition_history_read_admissions"."live_shadow_lifecycle_unavailable_count"
          + "encryption_transition_history_read_admissions"."integrity_failure_count" + "encryption_transition_history_read_admissions"."parity_mismatch_count"
          + "encryption_transition_history_read_admissions"."client_observation_expired_count" = 0
      ) or (
        "encryption_transition_history_read_admissions"."state" = 'consumed'
        and "encryption_transition_history_read_admissions"."consumption_kind" in (
          'signed_acknowledgement', 'unavailable_token', 'server_unavailable',
          'ineligible'
        )
        and "encryption_transition_history_read_admissions"."terminal_at" is not null
        and "encryption_transition_history_read_admissions"."terminal_at" < "encryption_transition_history_read_admissions"."expires_at"
        and "encryption_transition_history_read_admissions"."client_observation_expired_count" = 0
        and "encryption_transition_history_read_admissions"."verified_count" + "encryption_transition_history_read_admissions"."client_crypto_unavailable_count"
          + "encryption_transition_history_read_admissions"."client_custody_unavailable_count"
          + "encryption_transition_history_read_admissions"."current_read_authority_unavailable_count"
          + "encryption_transition_history_read_admissions"."retained_key_material_unavailable_count"
          + "encryption_transition_history_read_admissions"."signer_evidence_unavailable_count"
          + "encryption_transition_history_read_admissions"."live_shadow_lifecycle_unavailable_count"
          + "encryption_transition_history_read_admissions"."integrity_failure_count" + "encryption_transition_history_read_admissions"."parity_mismatch_count"
          = "encryption_transition_history_read_admissions"."eligible_count"
        and (
          ("encryption_transition_history_read_admissions"."consumption_kind" = 'signed_acknowledgement'
            and "encryption_transition_history_read_admissions"."reader_device_id" is not null
            and octet_length("encryption_transition_history_read_admissions"."acknowledgement_digest") = 32
            and octet_length("encryption_transition_history_read_admissions"."ordered_result_set_digest") = 32)
          or ("encryption_transition_history_read_admissions"."consumption_kind" = 'unavailable_token'
            and "encryption_transition_history_read_admissions"."acknowledgement_digest" is null
            and "encryption_transition_history_read_admissions"."ordered_result_set_digest" is null
            and "encryption_transition_history_read_admissions"."verified_count" = 0
            and "encryption_transition_history_read_admissions"."current_read_authority_unavailable_count" = 0
            and "encryption_transition_history_read_admissions"."retained_key_material_unavailable_count" = 0
            and "encryption_transition_history_read_admissions"."signer_evidence_unavailable_count" = 0
            and "encryption_transition_history_read_admissions"."live_shadow_lifecycle_unavailable_count" = 0
            and "encryption_transition_history_read_admissions"."integrity_failure_count" = 0
            and "encryption_transition_history_read_admissions"."parity_mismatch_count" = 0
            and ("encryption_transition_history_read_admissions"."client_crypto_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
              or "encryption_transition_history_read_admissions"."client_custody_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"))
          or ("encryption_transition_history_read_admissions"."consumption_kind" = 'server_unavailable'
            and "encryption_transition_history_read_admissions"."acknowledgement_digest" is null
            and "encryption_transition_history_read_admissions"."ordered_result_set_digest" is null
            and "encryption_transition_history_read_admissions"."verified_count" = 0
            and "encryption_transition_history_read_admissions"."client_custody_unavailable_count" = 0
            and "encryption_transition_history_read_admissions"."integrity_failure_count" = 0
            and "encryption_transition_history_read_admissions"."parity_mismatch_count" = 0
            and (
              "encryption_transition_history_read_admissions"."client_crypto_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
              or "encryption_transition_history_read_admissions"."current_read_authority_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
              or "encryption_transition_history_read_admissions"."retained_key_material_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
              or "encryption_transition_history_read_admissions"."signer_evidence_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
              or "encryption_transition_history_read_admissions"."live_shadow_lifecycle_unavailable_count" = "encryption_transition_history_read_admissions"."eligible_count"
            ))
          or ("encryption_transition_history_read_admissions"."consumption_kind" = 'ineligible'
            and "encryption_transition_history_read_admissions"."eligible_count" = 0
            and "encryption_transition_history_read_admissions"."reader_device_id" is null
            and "encryption_transition_history_read_admissions"."acknowledgement_digest" is null
            and "encryption_transition_history_read_admissions"."ordered_result_set_digest" is null)
        )
      ) or (
        "encryption_transition_history_read_admissions"."state" = 'expired'
        and "encryption_transition_history_read_admissions"."consumption_kind" = 'expiry'
        and "encryption_transition_history_read_admissions"."acknowledgement_digest" is null
        and "encryption_transition_history_read_admissions"."ordered_result_set_digest" is null
        and "encryption_transition_history_read_admissions"."terminal_at" = "encryption_transition_history_read_admissions"."expires_at"
        and "encryption_transition_history_read_admissions"."client_observation_expired_count" = "encryption_transition_history_read_admissions"."eligible_count"
        and "encryption_transition_history_read_admissions"."verified_count" + "encryption_transition_history_read_admissions"."client_crypto_unavailable_count"
          + "encryption_transition_history_read_admissions"."client_custody_unavailable_count"
          + "encryption_transition_history_read_admissions"."current_read_authority_unavailable_count"
          + "encryption_transition_history_read_admissions"."retained_key_material_unavailable_count"
          + "encryption_transition_history_read_admissions"."signer_evidence_unavailable_count"
          + "encryption_transition_history_read_admissions"."live_shadow_lifecycle_unavailable_count"
          + "encryption_transition_history_read_admissions"."integrity_failure_count" + "encryption_transition_history_read_admissions"."parity_mismatch_count" = 0
      ));