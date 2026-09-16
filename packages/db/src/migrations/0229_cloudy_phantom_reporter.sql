DROP POLICY "namespace_key_envelope_acknowledgements_crypto_sel" ON "namespace_key_envelope_acknowledgements" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_envelope_acknowledgements_crypto_ins" ON "namespace_key_envelope_acknowledgements" CASCADE;--> statement-breakpoint
DROP TABLE "namespace_key_envelope_acknowledgements" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_generation_heads_crypto_sel" ON "namespace_key_generation_heads" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_generation_heads_crypto_ins" ON "namespace_key_generation_heads" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_generation_heads_crypto_upd" ON "namespace_key_generation_heads" CASCADE;--> statement-breakpoint
DROP TABLE "namespace_key_generation_heads" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_publication_operations_crypto_sel" ON "namespace_key_publication_operations" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_publication_operations_crypto_ins" ON "namespace_key_publication_operations" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_publication_operations_crypto_upd" ON "namespace_key_publication_operations" CASCADE;--> statement-breakpoint
DROP TABLE "namespace_key_publication_operations" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_recipient_authorization_operations_crypto_sel" ON "namespace_key_recipient_authorization_operations" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_recipient_authorization_operations_crypto_ins" ON "namespace_key_recipient_authorization_operations" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_recipient_authorization_operations_crypto_upd" ON "namespace_key_recipient_authorization_operations" CASCADE;--> statement-breakpoint
DROP TABLE "namespace_key_recipient_authorization_operations" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_recipient_envelopes_crypto_sel" ON "namespace_key_recipient_envelopes" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_recipient_envelopes_crypto_ins" ON "namespace_key_recipient_envelopes" CASCADE;--> statement-breakpoint
DROP TABLE "namespace_key_recipient_envelopes" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_recipient_sync_campaigns_crypto_sel" ON "namespace_key_recipient_sync_campaigns" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_recipient_sync_campaigns_crypto_ins" ON "namespace_key_recipient_sync_campaigns" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_key_recipient_sync_campaigns_crypto_upd" ON "namespace_key_recipient_sync_campaigns" CASCADE;--> statement-breakpoint
DROP TABLE "namespace_key_recipient_sync_campaigns" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_ack_crypto_sel" ON "grant_domain_envelope_acknowledgements" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_ack_crypto_ins" ON "grant_domain_envelope_acknowledgements" CASCADE;--> statement-breakpoint
DROP TABLE "grant_domain_envelope_acknowledgements" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_heads_crypto_sel" ON "grant_domain_heads" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_heads_crypto_ins" ON "grant_domain_heads" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_heads_crypto_upd" ON "grant_domain_heads" CASCADE;--> statement-breakpoint
DROP TABLE "grant_domain_heads" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_pub_crypto_sel" ON "grant_domain_publication_operations" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_pub_crypto_ins" ON "grant_domain_publication_operations" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_pub_crypto_upd" ON "grant_domain_publication_operations" CASCADE;--> statement-breakpoint
DROP TABLE "grant_domain_publication_operations" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_recipient_auth_crypto_sel" ON "grant_domain_recipient_authorization_operations" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_recipient_auth_crypto_ins" ON "grant_domain_recipient_authorization_operations" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_recipient_auth_crypto_upd" ON "grant_domain_recipient_authorization_operations" CASCADE;--> statement-breakpoint
DROP TABLE "grant_domain_recipient_authorization_operations" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_envelopes_crypto_sel" ON "grant_domain_recipient_envelopes" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_envelopes_crypto_ins" ON "grant_domain_recipient_envelopes" CASCADE;--> statement-breakpoint
DROP TABLE "grant_domain_recipient_envelopes" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_sync_crypto_sel" ON "grant_domain_recipient_sync_campaigns" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_sync_crypto_ins" ON "grant_domain_recipient_sync_campaigns" CASCADE;--> statement-breakpoint
DROP POLICY "grant_domain_sync_crypto_upd" ON "grant_domain_recipient_sync_campaigns" CASCADE;--> statement-breakpoint
DROP TABLE "grant_domain_recipient_sync_campaigns" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_grant_domain_bindings_crypto_sel" ON "namespace_grant_domain_bindings" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_grant_domain_bindings_crypto_ins" ON "namespace_grant_domain_bindings" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_grant_domain_bindings_crypto_upd" ON "namespace_grant_domain_bindings" CASCADE;--> statement-breakpoint
DROP TABLE "namespace_grant_domain_bindings" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_grant_domain_heads_crypto_sel" ON "namespace_grant_domain_heads" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_grant_domain_heads_crypto_ins" ON "namespace_grant_domain_heads" CASCADE;--> statement-breakpoint
DROP POLICY "namespace_grant_domain_heads_crypto_upd" ON "namespace_grant_domain_heads" CASCADE;--> statement-breakpoint
DROP TABLE "namespace_grant_domain_heads" CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" DROP CONSTRAINT "conversation_shadow_turn_operations_authority_scheme";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ALTER COLUMN "namespace_authority_scheme" SET DEFAULT 'domain_key_v2';--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD CONSTRAINT "conversation_shadow_turn_operations_authority_scheme" CHECK (("conversation_shadow_turn_operations"."namespace_authority_scheme" = 'domain_key_v2'
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