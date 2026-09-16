ALTER TABLE "namespace_key_envelope_acknowledgements" DROP CONSTRAINT "ns_key_envelope_acknowledgements_generation_positive";--> statement-breakpoint
ALTER TABLE "namespace_key_generation_heads" DROP CONSTRAINT "ns_key_generation_heads_generation_positive";--> statement-breakpoint
ALTER TABLE "namespace_key_generation_heads" DROP CONSTRAINT "ns_key_generation_heads_predecessor_coherent";--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" DROP CONSTRAINT "ns_key_recipient_envelopes_generation_positive";--> statement-breakpoint
ALTER TABLE "namespace_key_envelope_acknowledgements" ADD CONSTRAINT "ns_key_envelope_acknowledgements_generation_safe" CHECK ("namespace_key_envelope_acknowledgements"."generation" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "namespace_key_generation_heads" ADD CONSTRAINT "ns_key_generation_heads_generation_safe" CHECK ("namespace_key_generation_heads"."generation" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "namespace_key_generation_heads" ADD CONSTRAINT "ns_key_generation_heads_predecessor_coherent" CHECK (("namespace_key_generation_heads"."generation" = 0 and "namespace_key_generation_heads"."previous_head_digest" is null)
        or ("namespace_key_generation_heads"."generation" > 0 and "namespace_key_generation_heads"."previous_head_digest" is not null));--> statement-breakpoint
ALTER TABLE "namespace_key_recipient_envelopes" ADD CONSTRAINT "ns_key_recipient_envelopes_generation_safe" CHECK ("namespace_key_recipient_envelopes"."generation" between 0 and 9007199254740991);