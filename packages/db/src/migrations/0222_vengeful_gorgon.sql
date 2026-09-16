CREATE TABLE "human_crypto_device_group_acknowledgements" (
	"human_id" text NOT NULL,
	"lineage_generation" bigint NOT NULL,
	"device_id" text NOT NULL,
	"device_generation" bigint NOT NULL,
	"acknowledged_sequence" bigint NOT NULL,
	"acknowledged_head_digest" "bytea" NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	CONSTRAINT "human_crypto_device_group_acknowledgements_human_id_lineage_generation_device_id_device_generation_pk" PRIMARY KEY("human_id","lineage_generation","device_id","device_generation"),
	CONSTRAINT "human_crypto_device_group_acknowledgements_human_id_portable" CHECK (octet_length("human_crypto_device_group_acknowledgements"."human_id") between 1
      and 128
      and "human_crypto_device_group_acknowledgements"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_acknowledgements_device_id_portable" CHECK (octet_length("human_crypto_device_group_acknowledgements"."device_id") between 1
      and 128
      and "human_crypto_device_group_acknowledgements"."device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_acknowledgements_lineage_safe" CHECK ("human_crypto_device_group_acknowledgements"."lineage_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_acknowledgements_device_generation_safe" CHECK ("human_crypto_device_group_acknowledgements"."device_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_acknowledgements_sequence_safe" CHECK ("human_crypto_device_group_acknowledgements"."acknowledged_sequence" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_acknowledgements_revision_safe" CHECK ("human_crypto_device_group_acknowledgements"."revision" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_acknowledgements_head_digest_size" CHECK (octet_length("human_crypto_device_group_acknowledgements"."acknowledged_head_digest") = 32)
);
--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "human_crypto_device_group_commits" (
	"human_id" text NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"lineage_generation" bigint NOT NULL,
	"sequence" bigint NOT NULL,
	"operation_id" text NOT NULL,
	"operation" text NOT NULL,
	"expected_head_digest" "bytea" NOT NULL,
	"next_head_digest" "bytea" NOT NULL,
	"next_epoch" bigint NOT NULL,
	"next_security_revision" bigint NOT NULL,
	"committer_device_id" text NOT NULL,
	"committer_device_generation" bigint NOT NULL,
	"target_device_id" text,
	"target_device_generation" bigint,
	"public_transition_bytes" "bytea" NOT NULL,
	"commit_bytes" "bytea" NOT NULL,
	"welcome_digest" "bytea",
	"roster_digest" "bytea" NOT NULL,
	"roster_bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "human_crypto_device_group_commits_human_id_lineage_generation_sequence_pk" PRIMARY KEY("human_id","lineage_generation","sequence"),
	CONSTRAINT "uq_human_crypto_device_group_commits_operation" UNIQUE("operation_id"),
	CONSTRAINT "uq_human_crypto_device_group_commits_next_head" UNIQUE("human_id","next_head_digest"),
	CONSTRAINT "human_crypto_device_group_commits_human_id_portable" CHECK (octet_length("human_crypto_device_group_commits"."human_id") between 1
      and 128
      and "human_crypto_device_group_commits"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_commits_operation_id_portable" CHECK (octet_length("human_crypto_device_group_commits"."operation_id") between 1
      and 128
      and "human_crypto_device_group_commits"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_commits_committer_id_portable" CHECK (octet_length("human_crypto_device_group_commits"."committer_device_id") between 1
      and 128
      and "human_crypto_device_group_commits"."committer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_commits_target_id_portable" CHECK (octet_length("human_crypto_device_group_commits"."target_device_id") between 1
      and 128
      and "human_crypto_device_group_commits"."target_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_commits_lineage_safe" CHECK ("human_crypto_device_group_commits"."lineage_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_commits_sequence_safe" CHECK ("human_crypto_device_group_commits"."sequence" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_commits_next_epoch_safe" CHECK ("human_crypto_device_group_commits"."next_epoch" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_commits_next_security_revision_safe" CHECK ("human_crypto_device_group_commits"."next_security_revision" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_commits_committer_generation_safe" CHECK ("human_crypto_device_group_commits"."committer_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_commits_target_generation_safe" CHECK ("human_crypto_device_group_commits"."target_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_commits_operation" CHECK ("human_crypto_device_group_commits"."operation" in ('add', 'update', 'remove', 'rebootstrap')),
	CONSTRAINT "human_crypto_device_group_commits_target_coherent" CHECK ((
        "human_crypto_device_group_commits"."operation" in ('add', 'remove')
        and "human_crypto_device_group_commits"."target_device_id" is not null
        and "human_crypto_device_group_commits"."target_device_generation" >= 1
      ) or (
        "human_crypto_device_group_commits"."operation" in ('update', 'rebootstrap')
        and "human_crypto_device_group_commits"."target_device_id" is null
        and "human_crypto_device_group_commits"."target_device_generation" is null
      )),
	CONSTRAINT "human_crypto_device_group_commits_expected_digest_size" CHECK (octet_length("human_crypto_device_group_commits"."expected_head_digest") = 32),
	CONSTRAINT "human_crypto_device_group_commits_next_digest_size" CHECK (octet_length("human_crypto_device_group_commits"."next_head_digest") = 32),
	CONSTRAINT "human_crypto_device_group_commits_transition_size" CHECK (octet_length("human_crypto_device_group_commits"."public_transition_bytes") between 1
      and 1048616),
	CONSTRAINT "human_crypto_device_group_commits_commit_size" CHECK (octet_length("human_crypto_device_group_commits"."commit_bytes") between 1
      and 1048616),
	CONSTRAINT "human_crypto_device_group_commits_welcome_digest_size" CHECK (octet_length("human_crypto_device_group_commits"."welcome_digest") = 32),
	CONSTRAINT "human_crypto_device_group_commits_roster_digest_size" CHECK (octet_length("human_crypto_device_group_commits"."roster_digest") = 32),
	CONSTRAINT "human_crypto_device_group_commits_roster_size" CHECK (octet_length("human_crypto_device_group_commits"."roster_bytes") between 1
      and 1048616),
	CONSTRAINT "human_crypto_device_group_commits_add_welcome" CHECK (("human_crypto_device_group_commits"."operation" = 'add' and octet_length("human_crypto_device_group_commits"."welcome_digest") = 32) or ("human_crypto_device_group_commits"."operation" <> 'add' and "human_crypto_device_group_commits"."welcome_digest" is null))
);
--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_commits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "human_crypto_device_group_heads" (
	"human_id" text PRIMARY KEY NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"lineage_generation" bigint NOT NULL,
	"provider_id" text NOT NULL,
	"group_id" text NOT NULL,
	"epoch" bigint NOT NULL,
	"state_hash" "bytea" NOT NULL,
	"roster_digest" "bytea" NOT NULL,
	"roster_bytes" "bytea" NOT NULL,
	"previous_head_digest" "bytea",
	"head_digest" "bytea" NOT NULL,
	"head_bytes" "bytea" NOT NULL,
	"security_revision" bigint NOT NULL,
	"commit_sequence" bigint NOT NULL,
	"committing_device_id" text NOT NULL,
	"committing_device_generation" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_human_crypto_device_group_heads_group_lineage" UNIQUE("server_instance_id","human_id","lineage_generation"),
	CONSTRAINT "uq_human_crypto_device_group_heads_digest" UNIQUE("human_id","head_digest"),
	CONSTRAINT "human_crypto_device_group_heads_human_id_portable" CHECK (octet_length("human_crypto_device_group_heads"."human_id") between 1
      and 128
      and "human_crypto_device_group_heads"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_heads_provider_id_portable" CHECK (octet_length("human_crypto_device_group_heads"."provider_id") between 1
      and 128
      and "human_crypto_device_group_heads"."provider_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_heads_group_id_portable" CHECK (octet_length("human_crypto_device_group_heads"."group_id") between 1
      and 128
      and "human_crypto_device_group_heads"."group_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_heads_lineage_safe" CHECK ("human_crypto_device_group_heads"."lineage_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_heads_epoch_safe" CHECK ("human_crypto_device_group_heads"."epoch" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_heads_security_revision_safe" CHECK ("human_crypto_device_group_heads"."security_revision" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_heads_commit_sequence_safe" CHECK ("human_crypto_device_group_heads"."commit_sequence" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_heads_committer_generation_safe" CHECK ("human_crypto_device_group_heads"."committing_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_heads_state_hash_size" CHECK (octet_length("human_crypto_device_group_heads"."state_hash") = 32),
	CONSTRAINT "human_crypto_device_group_heads_roster_digest_size" CHECK (octet_length("human_crypto_device_group_heads"."roster_digest") = 32),
	CONSTRAINT "human_crypto_device_group_heads_roster_size" CHECK (octet_length("human_crypto_device_group_heads"."roster_bytes") between 1
      and 1048616),
	CONSTRAINT "human_crypto_device_group_heads_previous_digest_size" CHECK (octet_length("human_crypto_device_group_heads"."previous_head_digest") = 32),
	CONSTRAINT "human_crypto_device_group_heads_head_digest_size" CHECK (octet_length("human_crypto_device_group_heads"."head_digest") = 32),
	CONSTRAINT "human_crypto_device_group_heads_head_size" CHECK (octet_length("human_crypto_device_group_heads"."head_bytes") between 1
      and 16384),
	CONSTRAINT "human_crypto_device_group_heads_genesis_coherent" CHECK ((
        "human_crypto_device_group_heads"."epoch" = 0
        and "human_crypto_device_group_heads"."commit_sequence" = 0
        and "human_crypto_device_group_heads"."security_revision" = 1
        and "human_crypto_device_group_heads"."previous_head_digest" is null
      ) or (
        "human_crypto_device_group_heads"."epoch" >= 1
        and "human_crypto_device_group_heads"."commit_sequence" >= 1
        and "human_crypto_device_group_heads"."security_revision" >= 2
        and octet_length("human_crypto_device_group_heads"."previous_head_digest") = 32
      )),
	CONSTRAINT "human_crypto_device_group_heads_time_order" CHECK ("human_crypto_device_group_heads"."updated_at" >= "human_crypto_device_group_heads"."created_at")
);
--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "human_crypto_device_group_welcomes" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"human_id" text NOT NULL,
	"lineage_generation" bigint NOT NULL,
	"sequence" bigint NOT NULL,
	"target_device_id" text NOT NULL,
	"target_device_generation" bigint NOT NULL,
	"welcome_digest" "bytea" NOT NULL,
	"welcome_bytes" "bytea" NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "human_crypto_device_group_welcomes_operation_id_portable" CHECK (octet_length("human_crypto_device_group_welcomes"."operation_id") between 1
      and 128
      and "human_crypto_device_group_welcomes"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_welcomes_human_id_portable" CHECK (octet_length("human_crypto_device_group_welcomes"."human_id") between 1
      and 128
      and "human_crypto_device_group_welcomes"."human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_welcomes_target_id_portable" CHECK (octet_length("human_crypto_device_group_welcomes"."target_device_id") between 1
      and 128
      and "human_crypto_device_group_welcomes"."target_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "human_crypto_device_group_welcomes_lineage_safe" CHECK ("human_crypto_device_group_welcomes"."lineage_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_welcomes_sequence_safe" CHECK ("human_crypto_device_group_welcomes"."sequence" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_welcomes_target_generation_safe" CHECK ("human_crypto_device_group_welcomes"."target_device_generation" between 0 and 9007199254740991),
	CONSTRAINT "human_crypto_device_group_welcomes_digest_size" CHECK (octet_length("human_crypto_device_group_welcomes"."welcome_digest") = 32),
	CONSTRAINT "human_crypto_device_group_welcomes_bytes_size" CHECK (octet_length("human_crypto_device_group_welcomes"."welcome_bytes") between 1
      and 1048616),
	CONSTRAINT "human_crypto_device_group_welcomes_state" CHECK ("human_crypto_device_group_welcomes"."state" in ('pending', 'delivered', 'acknowledged')),
	CONSTRAINT "human_crypto_device_group_welcomes_lifecycle_coherent" CHECK ((
        "human_crypto_device_group_welcomes"."state" = 'pending'
        and "human_crypto_device_group_welcomes"."delivered_at" is null
        and "human_crypto_device_group_welcomes"."acknowledged_at" is null
      ) or (
        "human_crypto_device_group_welcomes"."state" = 'delivered'
        and "human_crypto_device_group_welcomes"."delivered_at" >= "human_crypto_device_group_welcomes"."created_at"
        and "human_crypto_device_group_welcomes"."acknowledged_at" is null
      ) or (
        "human_crypto_device_group_welcomes"."state" = 'acknowledged'
        and "human_crypto_device_group_welcomes"."delivered_at" >= "human_crypto_device_group_welcomes"."created_at"
        and "human_crypto_device_group_welcomes"."acknowledged_at" >= "human_crypto_device_group_welcomes"."delivered_at"
      ))
);
--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_welcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD COLUMN "membership_state" text DEFAULT 'unbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD COLUMN "membership_server_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD COLUMN "membership_lineage_generation" bigint;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD COLUMN "membership_epoch" bigint;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD COLUMN "membership_security_revision" bigint;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD COLUMN "membership_leaf_index" integer;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD COLUMN "membership_head_digest" "bytea";--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD COLUMN "membership_acknowledged_sequence" bigint;--> statement-breakpoint
ALTER TABLE "nautilo_instance_identity" ADD CONSTRAINT "uq_nautilo_instance_identity_server_instance" UNIQUE("server_instance_id");--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "uq_human_crypto_devices_identity_generation" UNIQUE("device_id","device_generation");--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_acknowledgements" ADD CONSTRAINT "human_crypto_device_group_acknowledgements_custody_fk" FOREIGN KEY ("human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_acknowledgements" ADD CONSTRAINT "human_crypto_device_group_acknowledgements_device_fk" FOREIGN KEY ("device_id","device_generation") REFERENCES "public"."human_crypto_devices"("device_id","device_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_commits" ADD CONSTRAINT "human_crypto_device_group_commits_custody_fk" FOREIGN KEY ("human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_commits" ADD CONSTRAINT "human_crypto_device_group_commits_server_fk" FOREIGN KEY ("server_instance_id") REFERENCES "public"."nautilo_instance_identity"("server_instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_commits" ADD CONSTRAINT "human_crypto_device_group_commits_committer_fk" FOREIGN KEY ("committer_device_id","committer_device_generation") REFERENCES "public"."human_crypto_devices"("device_id","device_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_commits" ADD CONSTRAINT "human_crypto_device_group_commits_target_fk" FOREIGN KEY ("target_device_id","target_device_generation") REFERENCES "public"."human_crypto_devices"("device_id","device_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_heads" ADD CONSTRAINT "human_crypto_device_group_heads_custody_fk" FOREIGN KEY ("human_id") REFERENCES "public"."human_crypto_custodies"("human_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_heads" ADD CONSTRAINT "human_crypto_device_group_heads_server_fk" FOREIGN KEY ("server_instance_id") REFERENCES "public"."nautilo_instance_identity"("server_instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_heads" ADD CONSTRAINT "human_crypto_device_group_heads_committer_fk" FOREIGN KEY ("committing_device_id","committing_device_generation") REFERENCES "public"."human_crypto_devices"("device_id","device_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_welcomes" ADD CONSTRAINT "human_crypto_device_group_welcomes_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."human_crypto_device_group_commits"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_welcomes" ADD CONSTRAINT "human_crypto_device_group_welcomes_commit_fk" FOREIGN KEY ("human_id","lineage_generation","sequence") REFERENCES "public"."human_crypto_device_group_commits"("human_id","lineage_generation","sequence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_welcomes" ADD CONSTRAINT "human_crypto_device_group_welcomes_target_fk" FOREIGN KEY ("target_device_id","target_device_generation") REFERENCES "public"."human_crypto_devices"("device_id","device_generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_human_crypto_device_group_acknowledgements_retention" ON "human_crypto_device_group_acknowledgements" USING btree ("human_id","lineage_generation","acknowledged_sequence");--> statement-breakpoint
CREATE INDEX "idx_human_crypto_device_group_commits_catch_up" ON "human_crypto_device_group_commits" USING btree ("human_id","lineage_generation","sequence");--> statement-breakpoint
CREATE INDEX "idx_human_crypto_device_group_heads_server" ON "human_crypto_device_group_heads" USING btree ("server_instance_id","human_id");--> statement-breakpoint
CREATE INDEX "idx_human_crypto_device_group_welcomes_target" ON "human_crypto_device_group_welcomes" USING btree ("target_device_id","state");--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_membership_server_fk" FOREIGN KEY ("membership_server_instance_id") REFERENCES "public"."nautilo_instance_identity"("server_instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_membership_state" CHECK ("human_crypto_devices"."membership_state" in (
        'unbound', 'pending', 'welcome_pending', 'catching_up',
        'current', 'stale'
      ));--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_membership_lineage_safe" CHECK ("human_crypto_devices"."membership_lineage_generation" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_membership_epoch_safe" CHECK ("human_crypto_devices"."membership_epoch" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_membership_security_revision_safe" CHECK ("human_crypto_devices"."membership_security_revision" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_membership_leaf_safe" CHECK ("human_crypto_devices"."membership_leaf_index" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_membership_head_digest_size" CHECK (octet_length("human_crypto_devices"."membership_head_digest") = 32);--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_membership_ack_sequence_safe" CHECK ("human_crypto_devices"."membership_acknowledged_sequence" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "human_crypto_devices" ADD CONSTRAINT "human_crypto_devices_membership_coherent" CHECK ((
        "human_crypto_devices"."membership_state" = 'unbound'
        and "human_crypto_devices"."membership_server_instance_id" is null
        and "human_crypto_devices"."membership_lineage_generation" is null
        and "human_crypto_devices"."membership_epoch" is null
        and "human_crypto_devices"."membership_security_revision" is null
        and "human_crypto_devices"."membership_leaf_index" is null
        and "human_crypto_devices"."membership_head_digest" is null
        and "human_crypto_devices"."membership_acknowledged_sequence" is null
      ) or (
        "human_crypto_devices"."membership_state" in ('pending', 'welcome_pending')
        and "human_crypto_devices"."membership_server_instance_id" is not null
        and "human_crypto_devices"."membership_lineage_generation" >= 1
        and "human_crypto_devices"."membership_epoch" >= 0
        and "human_crypto_devices"."membership_security_revision" >= 1
        and "human_crypto_devices"."membership_leaf_index" is null
        and octet_length("human_crypto_devices"."membership_head_digest") = 32
        and "human_crypto_devices"."membership_acknowledged_sequence" >= 0
      ) or (
        "human_crypto_devices"."membership_state" in ('catching_up', 'current', 'stale')
        and "human_crypto_devices"."membership_server_instance_id" is not null
        and "human_crypto_devices"."membership_lineage_generation" >= 1
        and "human_crypto_devices"."membership_epoch" >= 0
        and "human_crypto_devices"."membership_security_revision" >= 1
        and "human_crypto_devices"."membership_leaf_index" >= 0
        and octet_length("human_crypto_devices"."membership_head_digest") = 32
        and "human_crypto_devices"."membership_acknowledged_sequence" >= 0
      ));--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_acknowledgements_crypto_sel" ON "human_crypto_device_group_acknowledgements" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_acknowledgements_crypto_ins" ON "human_crypto_device_group_acknowledgements" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_acknowledgements_crypto_upd" ON "human_crypto_device_group_acknowledgements" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_acknowledgements_crypto_del" ON "human_crypto_device_group_acknowledgements" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_commits_crypto_sel" ON "human_crypto_device_group_commits" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_commits_crypto_ins" ON "human_crypto_device_group_commits" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_commits_crypto_del" ON "human_crypto_device_group_commits" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_heads_crypto_sel" ON "human_crypto_device_group_heads" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_heads_crypto_ins" ON "human_crypto_device_group_heads" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_heads_crypto_upd" ON "human_crypto_device_group_heads" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_welcomes_crypto_sel" ON "human_crypto_device_group_welcomes" AS PERMISSIVE FOR SELECT TO "nautilo_crypto" USING (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_welcomes_crypto_ins" ON "human_crypto_device_group_welcomes" AS PERMISSIVE FOR INSERT TO "nautilo_crypto" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_welcomes_crypto_upd" ON "human_crypto_device_group_welcomes" AS PERMISSIVE FOR UPDATE TO "nautilo_crypto" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "human_crypto_device_group_welcomes_crypto_del" ON "human_crypto_device_group_welcomes" AS PERMISSIVE FOR DELETE TO "nautilo_crypto" USING (true);
--> statement-breakpoint
-- M232_CRYPTO_DELIVERY_AUTHORITY--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_heads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_commits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_welcomes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "human_crypto_device_group_acknowledgements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
  "human_crypto_device_group_heads",
  "human_crypto_device_group_commits",
  "human_crypto_device_group_welcomes",
  "human_crypto_device_group_acknowledgements"
FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  "human_crypto_device_group_heads"
TO "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE
  "human_crypto_device_group_commits"
TO "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "human_crypto_device_group_welcomes",
  "human_crypto_device_group_acknowledgements"
TO "nautilo_crypto";--> statement-breakpoint
-- M304_HUMAN_DEVICE_IDENTITY_READ
GRANT SELECT ("id", "server_instance_id") ON TABLE "nautilo_instance_identity"
TO "nautilo_crypto";
