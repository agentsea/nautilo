CREATE FUNCTION "public"."crypto_participants_are_canonical"(
  "participants" text[]
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  "participant" text;
  "participant_bytes" bytea;
  "previous_bytes" bytea := NULL;
BEGIN
  IF cardinality("participants") < 1 OR cardinality("participants") > 64 THEN
    RETURN false;
  END IF;

  FOREACH "participant" IN ARRAY "participants" LOOP
    IF octet_length("participant") NOT BETWEEN 1 AND 128
      OR "participant" !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    THEN
      RETURN false;
    END IF;

    "participant_bytes" := convert_to("participant", 'UTF8');
    IF "previous_bytes" IS NOT NULL
      AND "previous_bytes" >= "participant_bytes"
    THEN
      RETURN false;
    END IF;
    "previous_bytes" := "participant_bytes";
  END LOOP;

  RETURN true;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."crypto_participants_are_canonical"(text[])
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."crypto_participants_are_canonical"(text[])
  TO "nautilo_crypto";--> statement-breakpoint
CREATE TABLE "agent_crypto_runtime_challenges" (
	"agent_id" text NOT NULL,
	"challenge_hash" "bytea" NOT NULL,
	"ordinal" smallint NOT NULL,
	"consumed" boolean NOT NULL,
	CONSTRAINT "agent_crypto_runtime_challenges_agent_id_challenge_hash_pk" PRIMARY KEY("agent_id","challenge_hash"),
	CONSTRAINT "agent_crypto_runtime_challenges_agent_id_portable" CHECK (octet_length("agent_crypto_runtime_challenges"."agent_id") between 1
      and 128
      and "agent_crypto_runtime_challenges"."agent_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_crypto_runtime_challenges_hash_size" CHECK (octet_length("agent_crypto_runtime_challenges"."challenge_hash") = 32),
	CONSTRAINT "agent_crypto_runtime_challenges_ordinal_range" CHECK ("agent_crypto_runtime_challenges"."ordinal" between 0
      and 255)
);
--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_crypto_runtime_config_objects" (
	"agent_id" text NOT NULL,
	"object_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"config_revision" bigint NOT NULL,
	"runtime_generation" bigint NOT NULL,
	"wrapped_dek_hash" "bytea" NOT NULL,
	"wrapped_dek_bytes" "bytea" NOT NULL,
	CONSTRAINT "agent_crypto_runtime_config_objects_agent_id_object_id_pk" PRIMARY KEY("agent_id","object_id"),
	CONSTRAINT "agent_crypto_runtime_config_objects_agent_id_portable" CHECK (octet_length("agent_crypto_runtime_config_objects"."agent_id") between 1
      and 128
      and "agent_crypto_runtime_config_objects"."agent_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_crypto_runtime_config_objects_object_id_portable" CHECK (octet_length("agent_crypto_runtime_config_objects"."object_id") between 1
      and 128
      and "agent_crypto_runtime_config_objects"."object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_crypto_runtime_config_objects_ordinal_range" CHECK ("agent_crypto_runtime_config_objects"."ordinal" between 0
      and 255),
	CONSTRAINT "agent_crypto_runtime_config_objects_config_revision_safe" CHECK ("agent_crypto_runtime_config_objects"."config_revision" between 0 and 9007199254740991),
	CONSTRAINT "agent_crypto_runtime_config_objects_generation_safe" CHECK ("agent_crypto_runtime_config_objects"."runtime_generation" between 0 and 9007199254740991),
	CONSTRAINT "agent_crypto_runtime_config_objects_wrapped_hash_size" CHECK (octet_length("agent_crypto_runtime_config_objects"."wrapped_dek_hash") = 32),
	CONSTRAINT "agent_crypto_runtime_config_objects_wrapped_dek_size" CHECK (octet_length("agent_crypto_runtime_config_objects"."wrapped_dek_bytes") between 40
      and 4096)
);
--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_config_objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_crypto_runtime_domain_envelopes" (
	"agent_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"domain_epoch" bigint NOT NULL,
	"agent_authorization_revision" bigint NOT NULL,
	"runtime_generation" bigint NOT NULL,
	"committer_device_id" text NOT NULL,
	"envelope_hash" "bytea" NOT NULL,
	"envelope_bytes" "bytea" NOT NULL,
	CONSTRAINT "agent_crypto_runtime_domain_envelopes_agent_id_domain_id_pk" PRIMARY KEY("agent_id","domain_id"),
	CONSTRAINT "agent_crypto_runtime_domain_envelopes_agent_id_portable" CHECK (octet_length("agent_crypto_runtime_domain_envelopes"."agent_id") between 1
      and 128
      and "agent_crypto_runtime_domain_envelopes"."agent_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_crypto_runtime_domain_envelopes_domain_id_portable" CHECK (octet_length("agent_crypto_runtime_domain_envelopes"."domain_id") between 1
      and 128
      and "agent_crypto_runtime_domain_envelopes"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_crypto_runtime_domain_envelopes_ordinal_range" CHECK ("agent_crypto_runtime_domain_envelopes"."ordinal" between 0
      and 255),
	CONSTRAINT "agent_crypto_runtime_domain_envelopes_domain_epoch_safe" CHECK ("agent_crypto_runtime_domain_envelopes"."domain_epoch" between 0 and 9007199254740991),
	CONSTRAINT "agent_crypto_runtime_domain_envelopes_authorization_revision_safe" CHECK ("agent_crypto_runtime_domain_envelopes"."agent_authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "agent_crypto_runtime_domain_envelopes_generation_safe" CHECK ("agent_crypto_runtime_domain_envelopes"."runtime_generation" between 0 and 9007199254740991),
	CONSTRAINT "agent_crypto_runtime_domain_envelopes_device_id_portable" CHECK (octet_length("agent_crypto_runtime_domain_envelopes"."committer_device_id") between 1
      and 128
      and "agent_crypto_runtime_domain_envelopes"."committer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_crypto_runtime_domain_envelopes_hash_size" CHECK (octet_length("agent_crypto_runtime_domain_envelopes"."envelope_hash") = 32),
	CONSTRAINT "agent_crypto_runtime_domain_envelopes_bytes_size" CHECK (octet_length("agent_crypto_runtime_domain_envelopes"."envelope_bytes") between 1
      and 1048576)
);
--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_domain_envelopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_crypto_runtime_states" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"runtime_generation" bigint NOT NULL,
	"config_object_count" integer NOT NULL,
	"config_inventory_digest" "bytea" NOT NULL,
	CONSTRAINT "agent_crypto_runtime_states_agent_id_portable" CHECK (octet_length("agent_crypto_runtime_states"."agent_id") between 1
      and 128
      and "agent_crypto_runtime_states"."agent_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_crypto_runtime_states_authorization_revision_safe" CHECK ("agent_crypto_runtime_states"."authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "agent_crypto_runtime_states_generation_safe" CHECK ("agent_crypto_runtime_states"."runtime_generation" between 0 and 9007199254740991),
	CONSTRAINT "agent_crypto_runtime_states_config_count_range" CHECK ("agent_crypto_runtime_states"."config_object_count" between 0
        and 256),
	CONSTRAINT "agent_crypto_runtime_states_inventory_digest_size" CHECK (octet_length("agent_crypto_runtime_states"."config_inventory_digest") = 32)
);
--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_domain_provider_heads" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"epoch" bigint NOT NULL,
	"state_hash" "bytea" NOT NULL,
	"roster_bytes" "bytea" NOT NULL,
	CONSTRAINT "crypto_domain_provider_heads_domain_id_portable" CHECK (octet_length("crypto_domain_provider_heads"."domain_id") between 1
      and 128
      and "crypto_domain_provider_heads"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_provider_heads_provider_id_portable" CHECK (octet_length("crypto_domain_provider_heads"."provider_id") between 1
      and 128
      and "crypto_domain_provider_heads"."provider_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domain_provider_heads_epoch_safe" CHECK ("crypto_domain_provider_heads"."epoch" between 0 and 9007199254740991),
	CONSTRAINT "crypto_domain_provider_heads_state_hash_size" CHECK (octet_length("crypto_domain_provider_heads"."state_hash") = 32),
	CONSTRAINT "crypto_domain_provider_heads_roster_size" CHECK (octet_length("crypto_domain_provider_heads"."roster_bytes") between 0
      and 1048616)
);
--> statement-breakpoint
ALTER TABLE "crypto_domain_provider_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_digest" "bytea" NOT NULL,
	"participants" text[] NOT NULL,
	"epoch" bigint NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"roster_bytes" "bytea" NOT NULL,
	CONSTRAINT "crypto_domains_id_portable" CHECK (octet_length("crypto_domains"."id") between 1
      and 128
      and "crypto_domains"."id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_domains_participant_digest_size" CHECK (octet_length("crypto_domains"."participant_digest") = 32),
	CONSTRAINT "crypto_domains_participants_count" CHECK (cardinality("crypto_domains"."participants") between 1
        and 64),
	CONSTRAINT "crypto_domains_participants_canonical" CHECK (crypto_participants_are_canonical("crypto_domains"."participants")),
	CONSTRAINT "crypto_domains_epoch_safe" CHECK ("crypto_domains"."epoch" between 0 and 9007199254740991),
	CONSTRAINT "crypto_domains_authorization_revision_safe" CHECK ("crypto_domains"."authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "crypto_domains_roster_size" CHECK (octet_length("crypto_domains"."roster_bytes") between 0
      and 1048616)
);
--> statement-breakpoint
ALTER TABLE "crypto_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_grants" (
	"grant_id" text PRIMARY KEY NOT NULL,
	"grant_bytes" "bytea" NOT NULL,
	"consumed" boolean NOT NULL,
	CONSTRAINT "crypto_grants_grant_id_portable" CHECK (octet_length("crypto_grants"."grant_id") between 1
      and 128
      and "crypto_grants"."grant_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_grants_bytes_size" CHECK (octet_length("crypto_grants"."grant_bytes") between 1
      and 2097152)
);
--> statement-breakpoint
ALTER TABLE "crypto_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crypto_objects" (
	"object_id" text PRIMARY KEY NOT NULL,
	"payload_hash" "bytea" NOT NULL,
	"payload_bytes" "bytea" NOT NULL,
	CONSTRAINT "crypto_objects_object_id_portable" CHECK (octet_length("crypto_objects"."object_id") between 1
      and 128
      and "crypto_objects"."object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "crypto_objects_payload_hash_size" CHECK (octet_length("crypto_objects"."payload_hash") = 32),
	CONSTRAINT "crypto_objects_payload_size" CHECK (octet_length("crypto_objects"."payload_bytes") between 1
      and 1048616)
);
--> statement-breakpoint
ALTER TABLE "crypto_objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "human_crypto_recovery_archives" (
	"human_id" text PRIMARY KEY NOT NULL,
	"recovery_key_generation" bigint NOT NULL,
	"archive_hash" "bytea" NOT NULL,
	"archive_bytes" "bytea" NOT NULL,
	CONSTRAINT "human_crypto_recovery_archives_human_id_portable" CHECK (octet_length("human_crypto_recovery_archives"."human_id") between 1
      and 128
      and "human_crypto_recovery_archives"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_recovery_archives_generation_safe" CHECK ("human_crypto_recovery_archives"."recovery_key_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_recovery_archives_hash_size" CHECK (octet_length("human_crypto_recovery_archives"."archive_hash") = 32),
	CONSTRAINT "human_crypto_recovery_archives_bytes_size" CHECK (octet_length("human_crypto_recovery_archives"."archive_bytes") between 1
      and 67108864)
);
--> statement-breakpoint
ALTER TABLE "human_crypto_recovery_archives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "namespace_crypto_bindings" (
	"namespace_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"binding_hash" "bytea" NOT NULL,
	"previous_binding_hash" "bytea",
	"signed_binding_bytes" "bytea" NOT NULL,
	"human_keyring_envelope_bytes" "bytea" NOT NULL,
	"ai_keyring_envelope_bytes" "bytea" NOT NULL,
	CONSTRAINT "namespace_crypto_bindings_namespace_id_revision_pk" PRIMARY KEY("namespace_id","revision"),
	CONSTRAINT "uq_namespace_crypto_bindings_hash" UNIQUE("namespace_id","binding_hash"),
	CONSTRAINT "uq_namespace_crypto_bindings_head" UNIQUE("namespace_id","revision","binding_hash"),
	CONSTRAINT "namespace_crypto_bindings_namespace_id_portable" CHECK (octet_length("namespace_crypto_bindings"."namespace_id") between 1
      and 128
      and "namespace_crypto_bindings"."namespace_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_crypto_bindings_revision_safe" CHECK ("namespace_crypto_bindings"."revision" between 0 and 9007199254740991),
	CONSTRAINT "namespace_crypto_bindings_binding_hash_size" CHECK (octet_length("namespace_crypto_bindings"."binding_hash") = 32),
	CONSTRAINT "namespace_crypto_bindings_previous_hash_size" CHECK ("namespace_crypto_bindings"."previous_binding_hash" is null
        or octet_length("namespace_crypto_bindings"."previous_binding_hash")
          = 32),
	CONSTRAINT "namespace_crypto_bindings_signed_size" CHECK (octet_length("namespace_crypto_bindings"."signed_binding_bytes") between 1
      and 1048616),
	CONSTRAINT "namespace_crypto_bindings_genesis_chain" CHECK ((
        "namespace_crypto_bindings"."revision" = 0 and "namespace_crypto_bindings"."previous_binding_hash" is null
      ) or (
        "namespace_crypto_bindings"."revision" > 0 and "namespace_crypto_bindings"."previous_binding_hash" is not null
      )),
	CONSTRAINT "namespace_crypto_bindings_human_keyring_size" CHECK (octet_length("namespace_crypto_bindings"."human_keyring_envelope_bytes") between 1
      and 262144),
	CONSTRAINT "namespace_crypto_bindings_ai_keyring_size" CHECK (octet_length("namespace_crypto_bindings"."ai_keyring_envelope_bytes") between 1
      and 262144)
);
--> statement-breakpoint
ALTER TABLE "namespace_crypto_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "namespace_crypto_heads" (
	"namespace_id" text PRIMARY KEY NOT NULL,
	"access_revision" bigint NOT NULL,
	"binding_hash" "bytea" NOT NULL,
	"domain_id" text NOT NULL,
	"domain_epoch" bigint NOT NULL,
	CONSTRAINT "namespace_crypto_heads_namespace_id_portable" CHECK (octet_length("namespace_crypto_heads"."namespace_id") between 1
      and 128
      and "namespace_crypto_heads"."namespace_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_crypto_heads_access_revision_safe" CHECK ("namespace_crypto_heads"."access_revision" between 0 and 9007199254740991),
	CONSTRAINT "namespace_crypto_heads_binding_hash_size" CHECK (octet_length("namespace_crypto_heads"."binding_hash") = 32),
	CONSTRAINT "namespace_crypto_heads_domain_id_portable" CHECK (octet_length("namespace_crypto_heads"."domain_id") between 1
      and 128
      and "namespace_crypto_heads"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "namespace_crypto_heads_domain_epoch_safe" CHECK ("namespace_crypto_heads"."domain_epoch" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "namespace_crypto_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "object_crypto_access_heads" (
	"object_id" text PRIMARY KEY NOT NULL,
	"access_revision" bigint NOT NULL,
	"manifest_hash" "bytea" NOT NULL,
	CONSTRAINT "object_crypto_access_heads_object_id_portable" CHECK (octet_length("object_crypto_access_heads"."object_id") between 1
      and 128
      and "object_crypto_access_heads"."object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "object_crypto_access_heads_revision_safe" CHECK ("object_crypto_access_heads"."access_revision" between 0 and 9007199254740991),
	CONSTRAINT "object_crypto_access_heads_manifest_hash_size" CHECK (octet_length("object_crypto_access_heads"."manifest_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "object_crypto_access_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "object_crypto_access_manifests" (
	"object_id" text NOT NULL,
	"access_revision" bigint NOT NULL,
	"manifest_hash" "bytea" NOT NULL,
	"previous_manifest_hash" "bytea",
	"payload_hash" "bytea" NOT NULL,
	"manifest_bytes" "bytea" NOT NULL,
	CONSTRAINT "object_crypto_access_manifests_object_id_access_revision_pk" PRIMARY KEY("object_id","access_revision"),
	CONSTRAINT "uq_object_crypto_access_manifests_hash" UNIQUE("object_id","manifest_hash"),
	CONSTRAINT "uq_object_crypto_access_manifests_head" UNIQUE("object_id","access_revision","manifest_hash"),
	CONSTRAINT "object_crypto_access_manifests_object_id_portable" CHECK (octet_length("object_crypto_access_manifests"."object_id") between 1
      and 128
      and "object_crypto_access_manifests"."object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "object_crypto_access_manifests_revision_safe" CHECK ("object_crypto_access_manifests"."access_revision" between 0 and 9007199254740991),
	CONSTRAINT "object_crypto_access_manifests_hash_size" CHECK (octet_length("object_crypto_access_manifests"."manifest_hash") = 32),
	CONSTRAINT "object_crypto_access_manifests_previous_hash_size" CHECK ("object_crypto_access_manifests"."previous_manifest_hash" is null
        or octet_length("object_crypto_access_manifests"."previous_manifest_hash")
          = 32),
	CONSTRAINT "object_crypto_access_manifests_payload_hash_size" CHECK (octet_length("object_crypto_access_manifests"."payload_hash") = 32),
	CONSTRAINT "object_crypto_access_manifests_genesis_chain" CHECK ((
        "object_crypto_access_manifests"."access_revision" = 0
        and "object_crypto_access_manifests"."previous_manifest_hash" is null
      ) or (
        "object_crypto_access_manifests"."access_revision" > 0
        and "object_crypto_access_manifests"."previous_manifest_hash" is not null
      )),
	CONSTRAINT "object_crypto_access_manifests_bytes_size" CHECK (octet_length("object_crypto_access_manifests"."manifest_bytes") between 1
      and 1048616)
);
--> statement-breakpoint
ALTER TABLE "object_crypto_access_manifests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "object_crypto_namespace_envelopes" (
	"object_id" text NOT NULL,
	"access_revision" bigint NOT NULL,
	"namespace_id" text NOT NULL,
	"ordinal" smallint NOT NULL,
	"envelope_hash" "bytea" NOT NULL,
	"envelope_bytes" "bytea" NOT NULL,
	CONSTRAINT "object_crypto_namespace_envelopes_object_id_access_revision_namespace_id_pk" PRIMARY KEY("object_id","access_revision","namespace_id"),
	CONSTRAINT "object_crypto_namespace_envelopes_object_id_portable" CHECK (octet_length("object_crypto_namespace_envelopes"."object_id") between 1
      and 128
      and "object_crypto_namespace_envelopes"."object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "object_crypto_namespace_envelopes_revision_safe" CHECK ("object_crypto_namespace_envelopes"."access_revision" between 0 and 9007199254740991),
	CONSTRAINT "object_crypto_namespace_envelopes_namespace_id_portable" CHECK (octet_length("object_crypto_namespace_envelopes"."namespace_id") between 1
      and 128
      and "object_crypto_namespace_envelopes"."namespace_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "object_crypto_namespace_envelopes_ordinal_range" CHECK ("object_crypto_namespace_envelopes"."ordinal" between 0
      and 255),
	CONSTRAINT "object_crypto_namespace_envelopes_hash_size" CHECK (octet_length("object_crypto_namespace_envelopes"."envelope_hash") = 32),
	CONSTRAINT "object_crypto_namespace_envelopes_bytes_size" CHECK (octet_length("object_crypto_namespace_envelopes"."envelope_bytes") between 1
      and 1048576)
);
--> statement-breakpoint
ALTER TABLE "object_crypto_namespace_envelopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_challenges" ADD CONSTRAINT "agent_crypto_runtime_challenges_state_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_crypto_runtime_states"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_config_objects" ADD CONSTRAINT "agent_crypto_runtime_config_objects_state_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_crypto_runtime_states"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_domain_envelopes" ADD CONSTRAINT "agent_crypto_runtime_domain_envelopes_state_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_crypto_runtime_states"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_domain_provider_heads" ADD CONSTRAINT "crypto_domain_provider_heads_domain_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."crypto_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_crypto_bindings" ADD CONSTRAINT "namespace_crypto_bindings_previous_fk" FOREIGN KEY ("namespace_id","previous_binding_hash") REFERENCES "public"."namespace_crypto_bindings"("namespace_id","binding_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespace_crypto_heads" ADD CONSTRAINT "namespace_crypto_heads_binding_fk" FOREIGN KEY ("namespace_id","access_revision","binding_hash") REFERENCES "public"."namespace_crypto_bindings"("namespace_id","revision","binding_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_crypto_access_heads" ADD CONSTRAINT "object_crypto_access_heads_manifest_fk" FOREIGN KEY ("object_id","access_revision","manifest_hash") REFERENCES "public"."object_crypto_access_manifests"("object_id","access_revision","manifest_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_crypto_access_manifests" ADD CONSTRAINT "object_crypto_access_manifests_object_fk" FOREIGN KEY ("object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_crypto_access_manifests" ADD CONSTRAINT "object_crypto_access_manifests_previous_fk" FOREIGN KEY ("object_id","previous_manifest_hash") REFERENCES "public"."object_crypto_access_manifests"("object_id","manifest_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_crypto_namespace_envelopes" ADD CONSTRAINT "object_crypto_namespace_envelopes_manifest_fk" FOREIGN KEY ("object_id","access_revision") REFERENCES "public"."object_crypto_access_manifests"("object_id","access_revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_crypto_runtime_challenges_ordinal" ON "agent_crypto_runtime_challenges" USING btree ("agent_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_crypto_runtime_config_objects_ordinal" ON "agent_crypto_runtime_config_objects" USING btree ("agent_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_crypto_runtime_domain_envelopes_ordinal" ON "agent_crypto_runtime_domain_envelopes" USING btree ("agent_id","ordinal");--> statement-breakpoint
CREATE INDEX "idx_crypto_domains_participant_digest" ON "crypto_domains" USING btree ("participant_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_object_crypto_namespace_envelopes_ordinal" ON "object_crypto_namespace_envelopes" USING btree ("object_id","access_revision","ordinal");--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_challenges_crypto_sel" ON "agent_crypto_runtime_challenges" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_challenges_crypto_ins" ON "agent_crypto_runtime_challenges" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_challenges_crypto_upd" ON "agent_crypto_runtime_challenges" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_challenges_crypto_del" ON "agent_crypto_runtime_challenges" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_config_objects_crypto_sel" ON "agent_crypto_runtime_config_objects" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_config_objects_crypto_ins" ON "agent_crypto_runtime_config_objects" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_config_objects_crypto_upd" ON "agent_crypto_runtime_config_objects" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_config_objects_crypto_del" ON "agent_crypto_runtime_config_objects" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_domain_envelopes_crypto_sel" ON "agent_crypto_runtime_domain_envelopes" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_domain_envelopes_crypto_ins" ON "agent_crypto_runtime_domain_envelopes" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_domain_envelopes_crypto_upd" ON "agent_crypto_runtime_domain_envelopes" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_domain_envelopes_crypto_del" ON "agent_crypto_runtime_domain_envelopes" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_states_crypto_sel" ON "agent_crypto_runtime_states" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_states_crypto_ins" ON "agent_crypto_runtime_states" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_states_crypto_upd" ON "agent_crypto_runtime_states" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_provider_heads_crypto_sel" ON "crypto_domain_provider_heads" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_provider_heads_crypto_ins" ON "crypto_domain_provider_heads" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_domain_provider_heads_crypto_upd" ON "crypto_domain_provider_heads" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_domains_crypto_sel" ON "crypto_domains" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_domains_crypto_ins" ON "crypto_domains" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_domains_crypto_upd" ON "crypto_domains" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_grants_crypto_sel" ON "crypto_grants" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_grants_crypto_ins" ON "crypto_grants" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_grants_crypto_upd" ON "crypto_grants" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "crypto_objects_crypto_sel" ON "crypto_objects" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "crypto_objects_crypto_ins" ON "crypto_objects" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_recovery_archives_crypto_sel" ON "human_crypto_recovery_archives" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_recovery_archives_crypto_ins" ON "human_crypto_recovery_archives" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_recovery_archives_crypto_upd" ON "human_crypto_recovery_archives" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_crypto_bindings_crypto_sel" ON "namespace_crypto_bindings" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_crypto_bindings_crypto_ins" ON "namespace_crypto_bindings" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_crypto_heads_crypto_sel" ON "namespace_crypto_heads" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "namespace_crypto_heads_crypto_ins" ON "namespace_crypto_heads" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "namespace_crypto_heads_crypto_upd" ON "namespace_crypto_heads" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "object_crypto_access_heads_crypto_sel" ON "object_crypto_access_heads" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "object_crypto_access_heads_crypto_ins" ON "object_crypto_access_heads" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "object_crypto_access_heads_crypto_upd" ON "object_crypto_access_heads" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "object_crypto_access_manifests_crypto_sel" ON "object_crypto_access_manifests" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "object_crypto_access_manifests_crypto_ins" ON "object_crypto_access_manifests" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "object_crypto_namespace_envelopes_crypto_sel" ON "object_crypto_namespace_envelopes" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "object_crypto_namespace_envelopes_crypto_ins" ON "object_crypto_namespace_envelopes" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE FUNCTION "public"."crypto_domains_preserve_participants"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."participant_digest" IS DISTINCT FROM NEW."participant_digest"
    OR OLD."participants" IS DISTINCT FROM NEW."participants"
  THEN
    RAISE EXCEPTION
      'Crypto Domain identity and exact participants are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."crypto_domains_preserve_participants"()
  FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "crypto_domains_preserve_participants"
BEFORE UPDATE ON "crypto_domains"
FOR EACH ROW
EXECUTE FUNCTION "public"."crypto_domains_preserve_participants"();--> statement-breakpoint
ALTER TABLE "crypto_domains" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_domain_provider_heads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "namespace_crypto_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "namespace_crypto_heads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_objects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "object_crypto_access_manifests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "object_crypto_namespace_envelopes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "object_crypto_access_heads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_config_objects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_domain_envelopes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_challenges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crypto_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_recovery_archives" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "crypto_domains",
  "crypto_domain_provider_heads",
  "namespace_crypto_bindings",
  "namespace_crypto_heads",
  "crypto_objects",
  "object_crypto_access_manifests",
  "object_crypto_namespace_envelopes",
  "object_crypto_access_heads",
  "agent_crypto_runtime_states",
  "agent_crypto_runtime_config_objects",
  "agent_crypto_runtime_domain_envelopes",
  "agent_crypto_runtime_challenges",
  "crypto_grants",
  "human_crypto_recovery_archives"
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  "crypto_domains",
  "crypto_domain_provider_heads",
  "namespace_crypto_heads",
  "object_crypto_access_heads",
  "agent_crypto_runtime_states",
  "crypto_grants",
  "human_crypto_recovery_archives"
TO "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  "namespace_crypto_bindings",
  "crypto_objects",
  "object_crypto_access_manifests",
  "object_crypto_namespace_envelopes"
TO "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "agent_crypto_runtime_config_objects",
  "agent_crypto_runtime_domain_envelopes",
  "agent_crypto_runtime_challenges"
TO "nautilo_crypto";
