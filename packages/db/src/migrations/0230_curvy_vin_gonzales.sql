CREATE TABLE "human_crypto_device_admission_challenges" (
	"challenge_id" text PRIMARY KEY NOT NULL,
	"challenge_hash" "bytea" NOT NULL,
	"credential_digest" "bytea" NOT NULL,
	"user_id" uuid NOT NULL,
	"human_actor_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"device_generation" bigint NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"lineage_generation" bigint NOT NULL,
	"epoch" bigint NOT NULL,
	"security_revision" bigint NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "uq_human_crypto_device_admission_challenges_hash" UNIQUE("challenge_hash"),
	CONSTRAINT "human_crypto_device_admission_challenges_id_portable" CHECK (octet_length("human_crypto_device_admission_challenges"."challenge_id") between 1
      and 128
      and "human_crypto_device_admission_challenges"."challenge_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_admission_challenges_device_portable" CHECK (octet_length("human_crypto_device_admission_challenges"."device_id") between 1
      and 128
      and "human_crypto_device_admission_challenges"."device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_admission_challenges_hash_size" CHECK (octet_length("human_crypto_device_admission_challenges"."challenge_hash") = 32),
	CONSTRAINT "human_crypto_device_admission_challenges_credential_size" CHECK (octet_length("human_crypto_device_admission_challenges"."credential_digest") = 32),
	CONSTRAINT "human_crypto_device_admission_challenges_head_size" CHECK (octet_length("human_crypto_device_admission_challenges"."head_digest") = 32),
	CONSTRAINT "human_crypto_device_admission_challenges_nonce_size" CHECK (octet_length("human_crypto_device_admission_challenges"."nonce") = 32),
	CONSTRAINT "human_crypto_device_admission_challenges_device_generation_safe" CHECK ("human_crypto_device_admission_challenges"."device_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_admission_challenges_lineage_safe" CHECK ("human_crypto_device_admission_challenges"."lineage_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_admission_challenges_epoch_safe" CHECK ("human_crypto_device_admission_challenges"."epoch" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_admission_challenges_security_revision_safe" CHECK ("human_crypto_device_admission_challenges"."security_revision" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_admission_challenges_positive_coordinates" CHECK ("human_crypto_device_admission_challenges"."device_generation" >= 1
        and "human_crypto_device_admission_challenges"."lineage_generation" >= 1
        and "human_crypto_device_admission_challenges"."security_revision" >= 1),
	CONSTRAINT "human_crypto_device_admission_challenges_expiry" CHECK ("human_crypto_device_admission_challenges"."expires_at" > "human_crypto_device_admission_challenges"."issued_at"
        and "human_crypto_device_admission_challenges"."expires_at"
          <= "human_crypto_device_admission_challenges"."issued_at"
            + interval '300 seconds'),
	CONSTRAINT "human_crypto_device_admission_challenges_terminal_coherent" CHECK (not (
        "human_crypto_device_admission_challenges"."consumed_at" is not null
        and "human_crypto_device_admission_challenges"."invalidated_at" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "human_crypto_device_admission_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "human_crypto_device_admissions" (
	"credential_digest" "bytea" PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"human_actor_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"device_generation" bigint NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"lineage_generation" bigint NOT NULL,
	"epoch" bigint NOT NULL,
	"security_revision" bigint NOT NULL,
	"head_digest" "bytea" NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "human_crypto_device_admissions_device_portable" CHECK (octet_length("human_crypto_device_admissions"."device_id") between 1
      and 128
      and "human_crypto_device_admissions"."device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_admissions_credential_size" CHECK (octet_length("human_crypto_device_admissions"."credential_digest") = 32),
	CONSTRAINT "human_crypto_device_admissions_head_size" CHECK (octet_length("human_crypto_device_admissions"."head_digest") = 32),
	CONSTRAINT "human_crypto_device_admissions_device_generation_safe" CHECK ("human_crypto_device_admissions"."device_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_admissions_lineage_safe" CHECK ("human_crypto_device_admissions"."lineage_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_admissions_epoch_safe" CHECK ("human_crypto_device_admissions"."epoch" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_admissions_security_revision_safe" CHECK ("human_crypto_device_admissions"."security_revision" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_admissions_positive_coordinates" CHECK ("human_crypto_device_admissions"."device_generation" >= 1
        and "human_crypto_device_admissions"."lineage_generation" >= 1
        and "human_crypto_device_admissions"."security_revision" >= 1),
	CONSTRAINT "human_crypto_device_admissions_expiry" CHECK ("human_crypto_device_admissions"."expires_at" > "human_crypto_device_admissions"."admitted_at")
);
--> statement-breakpoint
ALTER TABLE "human_crypto_device_admissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_device_admission_challenges" ADD CONSTRAINT "human_crypto_device_admission_challenges_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_admission_challenges" ADD CONSTRAINT "human_crypto_device_admission_challenges_actor_fk" FOREIGN KEY ("human_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_admission_challenges" ADD CONSTRAINT "human_crypto_device_admission_challenges_device_fk" FOREIGN KEY ("device_id","device_generation") REFERENCES "public"."human_crypto_devices"("device_id","device_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_admission_challenges" ADD CONSTRAINT "human_crypto_device_admission_challenges_server_fk" FOREIGN KEY ("server_instance_id") REFERENCES "public"."nautilo_instance_identity"("server_instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_admissions" ADD CONSTRAINT "human_crypto_device_admissions_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_admissions" ADD CONSTRAINT "human_crypto_device_admissions_actor_fk" FOREIGN KEY ("human_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_admissions" ADD CONSTRAINT "human_crypto_device_admissions_device_fk" FOREIGN KEY ("device_id","device_generation") REFERENCES "public"."human_crypto_devices"("device_id","device_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_admissions" ADD CONSTRAINT "human_crypto_device_admissions_server_fk" FOREIGN KEY ("server_instance_id") REFERENCES "public"."nautilo_instance_identity"("server_instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_human_crypto_device_admission_challenges_live_credential" ON "human_crypto_device_admission_challenges" USING btree ("credential_digest") WHERE "human_crypto_device_admission_challenges"."consumed_at" is null
        and "human_crypto_device_admission_challenges"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "idx_human_crypto_device_admission_challenges_expiry" ON "human_crypto_device_admission_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_human_crypto_device_admissions_expiry" ON "human_crypto_device_admissions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_human_crypto_device_admissions_device" ON "human_crypto_device_admissions" USING btree ("human_actor_id","device_id","device_generation");--> statement-breakpoint
CREATE POLICY "human_crypto_device_admission_challenges_crypto_sel" ON "human_crypto_device_admission_challenges" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_admission_challenges_crypto_ins" ON "human_crypto_device_admission_challenges" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_admission_challenges_crypto_upd" ON "human_crypto_device_admission_challenges" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_admission_challenges_crypto_del" ON "human_crypto_device_admission_challenges" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_admissions_crypto_sel" ON "human_crypto_device_admissions" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_admissions_crypto_ins" ON "human_crypto_device_admissions" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_admissions_crypto_upd" ON "human_crypto_device_admissions" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_admissions_crypto_del" ON "human_crypto_device_admissions" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);
--> statement-breakpoint
-- M232_CRYPTO_DELIVERY_AUTHORITY--> statement-breakpoint
ALTER TABLE "human_crypto_device_admission_challenges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_device_admissions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "human_crypto_device_admission_challenges",
  "human_crypto_device_admissions"
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "human_crypto_device_admission_challenges",
  "human_crypto_device_admissions"
TO "nautilo_crypto";
