ALTER TABLE "conversation_shadow_turn_operations" DROP CONSTRAINT "conversation_shadow_turn_operations_digest_shape";--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_challenges" DROP CONSTRAINT "agent_crypto_runtime_challenges_ordinal_range";--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_domain_envelopes" DROP CONSTRAINT "agent_crypto_runtime_domain_envelopes_ordinal_range";--> statement-breakpoint
ALTER TABLE "background_crypto_authorization_requests" DROP CONSTRAINT "background_crypto_authorization_requests_response_coherent";--> statement-breakpoint
ALTER TABLE "crypto_grants" DROP CONSTRAINT "crypto_grants_bytes_size";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD CONSTRAINT "conversation_shadow_turn_operations_digest_shape" CHECK (("conversation_shadow_turn_operations"."namespace_binding_hash" is null or octet_length("conversation_shadow_turn_operations"."namespace_binding_hash") = 32)
        and ("conversation_shadow_turn_operations"."namespace_head_digest" is null or octet_length("conversation_shadow_turn_operations"."namespace_head_digest") = 32)
        and ("conversation_shadow_turn_operations"."namespace_publication_digest" is null or octet_length("conversation_shadow_turn_operations"."namespace_publication_digest") = 32)
        and ("conversation_shadow_turn_operations"."namespace_publication_set_digest" is null or octet_length("conversation_shadow_turn_operations"."namespace_publication_set_digest") = 32)
        and ("conversation_shadow_turn_operations"."namespace_audience_fingerprint" is null or octet_length("conversation_shadow_turn_operations"."namespace_audience_fingerprint") = 32)
        and ("conversation_shadow_turn_operations"."grant_domain_participant_digest" is null or octet_length("conversation_shadow_turn_operations"."grant_domain_participant_digest") = 32)
        and ("conversation_shadow_turn_operations"."grant_domain_head_digest" is null or octet_length("conversation_shadow_turn_operations"."grant_domain_head_digest") = 32)
        and ("conversation_shadow_turn_operations"."grant_domain_publication_digest" is null or octet_length("conversation_shadow_turn_operations"."grant_domain_publication_digest") = 32)
        and ("conversation_shadow_turn_operations"."namespace_bundle_digest" is null or octet_length("conversation_shadow_turn_operations"."namespace_bundle_digest") = 32)
        and ("conversation_shadow_turn_operations"."agent_grant_plan_digest" is null or octet_length("conversation_shadow_turn_operations"."agent_grant_plan_digest") = 32)
        and ("conversation_shadow_turn_operations"."agent_grant_plan_bytes" is null or octet_length("conversation_shadow_turn_operations"."agent_grant_plan_bytes") between 1 and 8388608)
        and octet_length("conversation_shadow_turn_operations"."plan_digest") = 32
        and ("conversation_shadow_turn_operations"."plan_bytes" is null or octet_length("conversation_shadow_turn_operations"."plan_bytes") between 1 and 8388608)
        and ("conversation_shadow_turn_operations"."human_request_digest" is null or octet_length("conversation_shadow_turn_operations"."human_request_digest") = 32)
        and ("conversation_shadow_turn_operations"."human_request_bytes" is null or octet_length("conversation_shadow_turn_operations"."human_request_bytes") between 1 and 18874368)
        and ("conversation_shadow_turn_operations"."grant_digest" is null or octet_length("conversation_shadow_turn_operations"."grant_digest") = 32)
        and ("conversation_shadow_turn_operations"."final_causal_event_digest" is null or octet_length("conversation_shadow_turn_operations"."final_causal_event_digest") = 32)
        and ("conversation_shadow_turn_operations"."client_verification_digest" is null or octet_length("conversation_shadow_turn_operations"."client_verification_digest") = 32));--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_challenges" ADD CONSTRAINT "agent_crypto_runtime_challenges_ordinal_range" CHECK ("agent_crypto_runtime_challenges"."ordinal" between 0
      and 16383);--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_domain_envelopes" ADD CONSTRAINT "agent_crypto_runtime_domain_envelopes_ordinal_range" CHECK ("agent_crypto_runtime_domain_envelopes"."ordinal" between 0
      and 16383);--> statement-breakpoint
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
              and 200704
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
ALTER TABLE "crypto_grants" ADD CONSTRAINT "crypto_grants_bytes_size" CHECK (octet_length("crypto_grants"."grant_bytes") between 1
      and 16777216);