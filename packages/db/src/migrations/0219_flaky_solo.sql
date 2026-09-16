ALTER TABLE "conversation_shadow_turn_operations" DROP CONSTRAINT "conversation_shadow_turn_operations_authority_scheme";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD CONSTRAINT "conversation_shadow_turn_operations_authority_scheme" CHECK ((
        "conversation_shadow_turn_operations"."namespace_authority_scheme" = 'domain_root_v1'
        and "conversation_shadow_turn_operations"."committer_device_signing_key_generation" is null
        and "conversation_shadow_turn_operations"."namespace_binding_hash" is not null
        and "conversation_shadow_turn_operations"."binding_revision_at_wrap" is not null
        and "conversation_shadow_turn_operations"."domain_id" is not null
        and "conversation_shadow_turn_operations"."domain_epoch" is not null
        and "conversation_shadow_turn_operations"."namespace_head_digest" is null
        and "conversation_shadow_turn_operations"."namespace_publication_digest" is null
        and "conversation_shadow_turn_operations"."namespace_publication_set_digest" is null
        and "conversation_shadow_turn_operations"."namespace_audience_fingerprint" is null
        and "conversation_shadow_turn_operations"."grant_domain_id" is null
        and "conversation_shadow_turn_operations"."grant_domain_participant_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_key_generation" is null
        and "conversation_shadow_turn_operations"."grant_domain_head_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_publication_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_authorization_revision" is null
        and "conversation_shadow_turn_operations"."namespace_bundle_revision" is null
        and "conversation_shadow_turn_operations"."namespace_bundle_digest" is null
        and "conversation_shadow_turn_operations"."agent_grant_plan_bytes" is null
        and "conversation_shadow_turn_operations"."agent_grant_plan_digest" is null
      ) or (
        "conversation_shadow_turn_operations"."namespace_authority_scheme" = 'device_wrapped_v1'
        and "conversation_shadow_turn_operations"."committer_device_signing_key_generation" is not null
        and "conversation_shadow_turn_operations"."namespace_binding_hash" is null
        and "conversation_shadow_turn_operations"."binding_revision_at_wrap" is null
        and "conversation_shadow_turn_operations"."domain_id" is null
        and "conversation_shadow_turn_operations"."domain_epoch" is null
        and "conversation_shadow_turn_operations"."namespace_head_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_publication_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_publication_set_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_audience_fingerprint" is not null
        and "conversation_shadow_turn_operations"."grant_domain_id" is null
        and "conversation_shadow_turn_operations"."grant_domain_participant_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_key_generation" is null
        and "conversation_shadow_turn_operations"."grant_domain_head_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_publication_digest" is null
        and "conversation_shadow_turn_operations"."grant_domain_authorization_revision" is null
        and "conversation_shadow_turn_operations"."namespace_bundle_revision" is null
        and "conversation_shadow_turn_operations"."namespace_bundle_digest" is null
        and "conversation_shadow_turn_operations"."agent_grant_plan_bytes" is not null
        and "conversation_shadow_turn_operations"."agent_grant_plan_digest" is not null
      ) or (
        "conversation_shadow_turn_operations"."namespace_authority_scheme" in ('grant_domain_v1', 'domain_key_v2')
        and "conversation_shadow_turn_operations"."committer_device_signing_key_generation" is not null
        and "conversation_shadow_turn_operations"."namespace_binding_hash" is null
        and "conversation_shadow_turn_operations"."binding_revision_at_wrap" is null
        and "conversation_shadow_turn_operations"."domain_id" is null
        and "conversation_shadow_turn_operations"."domain_epoch" is null
        and "conversation_shadow_turn_operations"."namespace_head_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_publication_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_publication_set_digest" is not null
        and "conversation_shadow_turn_operations"."namespace_audience_fingerprint" is not null
        and "conversation_shadow_turn_operations"."grant_domain_id" is not null
        and "conversation_shadow_turn_operations"."grant_domain_participant_digest" is not null
        and "conversation_shadow_turn_operations"."grant_domain_key_generation" is not null
        and "conversation_shadow_turn_operations"."grant_domain_head_digest" is not null
        and "conversation_shadow_turn_operations"."grant_domain_publication_digest" is not null
        and "conversation_shadow_turn_operations"."grant_domain_authorization_revision" is not null
        and "conversation_shadow_turn_operations"."namespace_bundle_revision" is not null
        and "conversation_shadow_turn_operations"."namespace_bundle_digest" is not null
        and "conversation_shadow_turn_operations"."agent_grant_plan_bytes" is not null
        and "conversation_shadow_turn_operations"."agent_grant_plan_digest" is not null
      ));