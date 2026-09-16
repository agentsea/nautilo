ALTER TABLE "domain_key_envelope_acknowledgements" DROP CONSTRAINT "domain_key_acks_envelope_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_recipient_envelopes" DROP CONSTRAINT "domain_key_envelopes_request_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_recipient_requests" DROP CONSTRAINT "domain_key_requests_head_fk";
--> statement-breakpoint
ALTER TABLE "namespace_domain_key_bindings" DROP CONSTRAINT "namespace_domain_key_bindings_head_fk";
--> statement-breakpoint
ALTER TABLE "namespace_domain_key_heads" DROP CONSTRAINT "namespace_domain_key_heads_domain_fk";
