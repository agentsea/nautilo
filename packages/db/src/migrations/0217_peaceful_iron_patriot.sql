ALTER TABLE "domain_key_heads" DROP CONSTRAINT "domain_key_heads_publication_fk";
--> statement-breakpoint
ALTER TABLE "domain_key_recipient_envelopes" DROP CONSTRAINT "domain_key_envelopes_head_fk";
--> statement-breakpoint
ALTER TABLE "namespace_domain_key_heads" DROP CONSTRAINT "namespace_domain_key_heads_binding_fk";
