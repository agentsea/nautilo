ALTER TABLE "encryption_transition_observation_admissions" ADD COLUMN "subject_human_id" text;--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_admissions" ADD COLUMN "memory_id" uuid;--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_admissions" ADD COLUMN "crypto_object_id" text;--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_admissions" ADD COLUMN "content_revision" integer;--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_admissions" ADD COLUMN "crypto_access_revision" integer;--> statement-breakpoint
ALTER TABLE "encryption_transition_observation_admissions" ADD CONSTRAINT "encryption_transition_observation_admissions_memory_read_binding" CHECK (("encryption_transition_observation_admissions"."family" = 'memory' and "encryption_transition_observation_admissions"."operation" = 'read'
        and "encryption_transition_observation_admissions"."subject_human_id" is not null and length("encryption_transition_observation_admissions"."subject_human_id") > 0
        and "encryption_transition_observation_admissions"."memory_id" is not null
        and "encryption_transition_observation_admissions"."crypto_object_id" is not null and length("encryption_transition_observation_admissions"."crypto_object_id") > 0
        and "encryption_transition_observation_admissions"."content_revision" is not null and "encryption_transition_observation_admissions"."content_revision" > 0
        and "encryption_transition_observation_admissions"."crypto_access_revision" is not null and "encryption_transition_observation_admissions"."crypto_access_revision" >= 0)
        or (not ("encryption_transition_observation_admissions"."family" = 'memory' and "encryption_transition_observation_admissions"."operation" = 'read')
          and "encryption_transition_observation_admissions"."subject_human_id" is null and "encryption_transition_observation_admissions"."memory_id" is null
          and "encryption_transition_observation_admissions"."crypto_object_id" is null and "encryption_transition_observation_admissions"."content_revision" is null
          and "encryption_transition_observation_admissions"."crypto_access_revision" is null));