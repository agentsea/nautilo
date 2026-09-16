CREATE TABLE "session_message_ordinary_repairs" (
	"session_id" uuid NOT NULL,
	"message_id" integer NOT NULL,
	"edit_revision" integer NOT NULL,
	"crypto_object_id" text NOT NULL,
	"expected_key_class" text NOT NULL,
	"authority_actor_id" uuid NOT NULL,
	"repair_identity_digest" "bytea" NOT NULL,
	"attestation_digest" "bytea" NOT NULL,
	"publisher_kind" text NOT NULL,
	"publisher_id" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_message_ordinary_repairs_session_id_message_id_edit_revision_pk" PRIMARY KEY("session_id","message_id","edit_revision"),
	CONSTRAINT "uq_session_message_ordinary_repairs_identity" UNIQUE("repair_identity_digest"),
	CONSTRAINT "session_message_ordinary_repairs_revision_nonnegative" CHECK ("session_message_ordinary_repairs"."edit_revision" >= 0),
	CONSTRAINT "session_message_ordinary_repairs_key_class" CHECK ("session_message_ordinary_repairs"."expected_key_class" in ('ai', 'human')),
	CONSTRAINT "session_message_ordinary_repairs_identity_digest_size" CHECK (octet_length("session_message_ordinary_repairs"."repair_identity_digest") = 32),
	CONSTRAINT "session_message_ordinary_repairs_attestation_digest_size" CHECK (octet_length("session_message_ordinary_repairs"."attestation_digest") = 32),
	CONSTRAINT "session_message_ordinary_repairs_publisher_kind" CHECK ("session_message_ordinary_repairs"."publisher_kind" in ('authenticated_runtime', 'device_attested')),
	CONSTRAINT "session_message_ordinary_repairs_publisher_id" CHECK (length("session_message_ordinary_repairs"."publisher_id") between 1 and 255),
	CONSTRAINT "session_message_ordinary_repairs_policy_revision" CHECK ("session_message_ordinary_repairs"."policy_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "session_message_ordinary_repairs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_ordinary_repair_shape";--> statement-breakpoint
-- Drizzle emits the new-table FK before the existing-table UNIQUE it needs.
-- Keep the generated definitions, but create the referenced key first.
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "uq_session_message_crypto_revisions_coordinate_object" UNIQUE("session_id","message_id","edit_revision","crypto_object_id");--> statement-breakpoint
ALTER TABLE "session_message_ordinary_repairs" ADD CONSTRAINT "session_message_ordinary_repairs_revision_object_fk" FOREIGN KEY ("session_id","message_id","edit_revision","crypto_object_id") REFERENCES "public"."session_message_crypto_revisions"("session_id","message_id","edit_revision","crypto_object_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" DROP COLUMN "ordinary_repair_identity_digest";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" DROP COLUMN "ordinary_repair_attestation_digest";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" DROP COLUMN "ordinary_repair_publisher_kind";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" DROP COLUMN "ordinary_repair_publisher_id";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" DROP COLUMN "ordinary_repair_policy_revision";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" DROP COLUMN "ordinary_repaired_at";--> statement-breakpoint
CREATE POLICY "session_message_ordinary_repairs_product_all" ON "session_message_ordinary_repairs" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "session_message_ordinary_repairs_agent_select" ON "session_message_ordinary_repairs" AS PERMISSIVE FOR SELECT TO "nautilo_agent" USING ("session_message_ordinary_repairs"."publisher_kind" = 'authenticated_runtime'
      and "session_message_ordinary_repairs"."expected_key_class" = 'ai'
      and "session_message_ordinary_repairs"."authority_actor_id" = app_current_agent_id()
      and exists (
        select 1
          from "session_message_crypto_revisions" lifecycle
          join "sessions" session_row
            on session_row.id = lifecycle.session_id
         where lifecycle.session_id = "session_message_ordinary_repairs"."session_id"
           and lifecycle.message_id = "session_message_ordinary_repairs"."message_id"
           and lifecycle.edit_revision = "session_message_ordinary_repairs"."edit_revision"
           and lifecycle.crypto_object_id = "session_message_ordinary_repairs"."crypto_object_id"
           and lifecycle.key_class = "session_message_ordinary_repairs"."expected_key_class"
           and lifecycle.completion = 'complete'
           and lifecycle.disposition = 'mapped'
           and session_row.room_id = lifecycle.room_id
           and app_agent_in_room(lifecycle.room_id)
      ));--> statement-breakpoint
CREATE POLICY "session_message_ordinary_repairs_agent_insert" ON "session_message_ordinary_repairs" AS PERMISSIVE FOR INSERT TO "nautilo_agent" WITH CHECK ("session_message_ordinary_repairs"."publisher_kind" = 'authenticated_runtime'
      and "session_message_ordinary_repairs"."expected_key_class" = 'ai'
      and "session_message_ordinary_repairs"."authority_actor_id" = app_current_agent_id()
      and exists (
        select 1
          from "session_message_crypto_revisions" lifecycle
          join "sessions" session_row
            on session_row.id = lifecycle.session_id
         where lifecycle.session_id = "session_message_ordinary_repairs"."session_id"
           and lifecycle.message_id = "session_message_ordinary_repairs"."message_id"
           and lifecycle.edit_revision = "session_message_ordinary_repairs"."edit_revision"
           and lifecycle.crypto_object_id = "session_message_ordinary_repairs"."crypto_object_id"
           and lifecycle.key_class = "session_message_ordinary_repairs"."expected_key_class"
           and lifecycle.completion = 'complete'
           and lifecycle.disposition = 'mapped'
           and session_row.room_id = lifecycle.room_id
           and app_agent_in_room(lifecycle.room_id)
      ));
--> statement-breakpoint
-- M318_MESSAGE_ORDINARY_REPAIR_AUTHORITY
ALTER TABLE "session_message_ordinary_repairs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "session_message_ordinary_repairs"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "session_message_ordinary_repairs"
  TO "nautilo_agent";
