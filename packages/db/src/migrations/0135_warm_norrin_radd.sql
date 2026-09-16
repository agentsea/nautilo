CREATE TABLE "agent_crypto_runtime_signers" (
	"agent_id" text NOT NULL,
	"runtime_generation" bigint NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"transition_kind" text NOT NULL,
	"operation_id" text NOT NULL,
	"signer_key_id" text NOT NULL,
	"signer_public_key" "bytea" NOT NULL,
	"publication_bytes" "bytea" NOT NULL,
	CONSTRAINT "agent_crypto_runtime_signers_agent_id_runtime_generation_pk" PRIMARY KEY("agent_id","runtime_generation"),
	CONSTRAINT "uq_agent_crypto_runtime_signers_key_id" UNIQUE("signer_key_id"),
	CONSTRAINT "uq_agent_crypto_runtime_signers_operation" UNIQUE("agent_id","operation_id"),
	CONSTRAINT "agent_crypto_runtime_signers_agent_id_portable" CHECK (octet_length("agent_crypto_runtime_signers"."agent_id") between 1
      and 128
      and "agent_crypto_runtime_signers"."agent_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_crypto_runtime_signers_generation_safe" CHECK ("agent_crypto_runtime_signers"."runtime_generation" between 0 and 9007199254740991),
	CONSTRAINT "agent_crypto_runtime_signers_authorization_revision_safe" CHECK ("agent_crypto_runtime_signers"."authorization_revision" between 0 and 9007199254740991),
	CONSTRAINT "agent_crypto_runtime_signers_transition_kind" CHECK ("agent_crypto_runtime_signers"."transition_kind" in ('initialization', 'rotation')),
	CONSTRAINT "agent_crypto_runtime_signers_transition_generation_coherent" CHECK ((
        ("agent_crypto_runtime_signers"."transition_kind" = 'initialization'
          and "agent_crypto_runtime_signers"."runtime_generation" = 0)
        or
        ("agent_crypto_runtime_signers"."transition_kind" = 'rotation'
          and "agent_crypto_runtime_signers"."runtime_generation" > 0)
      )),
	CONSTRAINT "agent_crypto_runtime_signers_operation_id_portable" CHECK (octet_length("agent_crypto_runtime_signers"."operation_id") between 1
      and 128
      and "agent_crypto_runtime_signers"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_crypto_runtime_signers_key_id_portable" CHECK (octet_length("agent_crypto_runtime_signers"."signer_key_id") between 1
      and 128
      and "agent_crypto_runtime_signers"."signer_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "agent_crypto_runtime_signers_public_key_size" CHECK (octet_length("agent_crypto_runtime_signers"."signer_public_key") = 32),
	CONSTRAINT "agent_crypto_runtime_signers_publication_size" CHECK (octet_length("agent_crypto_runtime_signers"."publication_bytes") between 1
      and 1024)
);
--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_signers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_crypto_runtime_signers" ADD CONSTRAINT "agent_crypto_runtime_signers_state_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_crypto_runtime_states"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_signers_crypto_sel" ON "agent_crypto_runtime_signers" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "agent_crypto_runtime_signers_crypto_ins" ON "agent_crypto_runtime_signers" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);
--> statement-breakpoint
-- M237_AGENT_RUNTIME_SIGNER_AUTHORITY
ALTER TABLE "agent_crypto_runtime_signers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "agent_crypto_runtime_signers"
  FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "agent_crypto_runtime_signers"
  TO "nautilo_crypto";
