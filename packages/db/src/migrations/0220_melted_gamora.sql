ALTER TABLE "domain_key_envelope_acknowledgements" DROP CONSTRAINT "domain_key_acks_device_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_heads" DROP CONSTRAINT "domain_key_heads_domain_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_heads" DROP CONSTRAINT "domain_key_heads_issuer_human_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_heads" DROP CONSTRAINT "domain_key_heads_issuer_device_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_publication_operations" DROP CONSTRAINT "domain_key_pub_domain_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_publication_operations" DROP CONSTRAINT "domain_key_pub_issuer_human_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_publication_operations" DROP CONSTRAINT "domain_key_pub_issuer_device_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_recipient_envelopes" DROP CONSTRAINT "domain_key_envelopes_recipient_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_recipient_envelopes" DROP CONSTRAINT "domain_key_envelopes_issuer_human_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_recipient_envelopes" DROP CONSTRAINT "domain_key_envelopes_issuer_device_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_recipient_requests" DROP CONSTRAINT "domain_key_requests_human_fk";
--> statement-breakpoint
ALTER TABLE "namespace_domain_key_bindings" DROP CONSTRAINT "namespace_domain_key_bindings_namespace_fk";
--> statement-breakpoint
ALTER TABLE "namespace_domain_key_bindings" DROP CONSTRAINT "namespace_domain_key_bindings_issuer_human_fk";
--> statement-breakpoint
ALTER TABLE "namespace_domain_key_bindings" DROP CONSTRAINT "namespace_domain_key_bindings_issuer_device_fk";
--> statement-breakpoint
ALTER TABLE "namespace_domain_key_heads" DROP CONSTRAINT "namespace_domain_key_heads_namespace_fk";
