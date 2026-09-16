CREATE TABLE "conversation_human_peer_shadow_acknowledgements" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"subject_human_id" text NOT NULL,
	"committer_device_id" text NOT NULL,
	"committer_device_signing_key_generation" bigint NOT NULL,
	"host_authorization_revision" bigint NOT NULL,
	"acknowledgement_digest" "bytea" NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_human_peer_shadow_acknowledgements_shape" CHECK (octet_length("conversation_human_peer_shadow_acknowledgements"."operation_id") between 1 and 128
        and octet_length("conversation_human_peer_shadow_acknowledgements"."subject_human_id") between 1 and 128
        and octet_length("conversation_human_peer_shadow_acknowledgements"."committer_device_id") between 1 and 128
        and "conversation_human_peer_shadow_acknowledgements"."committer_device_signing_key_generation" >= 0
        and "conversation_human_peer_shadow_acknowledgements"."host_authorization_revision" >= 0
        and octet_length("conversation_human_peer_shadow_acknowledgements"."acknowledgement_digest") = 32
        and (("conversation_human_peer_shadow_acknowledgements"."status" = 'verified' and "conversation_human_peer_shadow_acknowledgements"."reason" = 'matched')
          or ("conversation_human_peer_shadow_acknowledgements"."status" = 'fallback' and "conversation_human_peer_shadow_acknowledgements"."reason" <> 'matched'))
        and "conversation_human_peer_shadow_acknowledgements"."deadline_at" > "conversation_human_peer_shadow_acknowledgements"."issued_at")
);
--> statement-breakpoint
ALTER TABLE "conversation_human_peer_shadow_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_human_peer_shadow_operations" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"client_idempotency_key" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"session_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"human_message_id" integer NOT NULL,
	"human_message_created_at" timestamp with time zone NOT NULL,
	"transcript_ordinal" integer NOT NULL,
	"subject_human_id" text NOT NULL,
	"committer_device_id" text NOT NULL,
	"committer_device_signing_key_generation" bigint NOT NULL,
	"host_authorization_revision" bigint NOT NULL,
	"namespace_id" uuid NOT NULL,
	"namespace_access_revision" integer NOT NULL,
	"namespace_key_generation" integer NOT NULL,
	"namespace_head_digest" "bytea" NOT NULL,
	"namespace_publication_digest" "bytea" NOT NULL,
	"namespace_publication_set_digest" "bytea" NOT NULL,
	"namespace_audience_fingerprint" "bytea" NOT NULL,
	"crypto_object_id" text NOT NULL,
	"attempt_coordinate" text NOT NULL,
	"plan_digest" "bytea" NOT NULL,
	"plan_bytes" "bytea" NOT NULL,
	"human_request_digest" "bytea",
	"human_request_bytes" "bytea",
	"protected_message_digest" "bytea",
	"final_event_digest" "bytea",
	"state" text DEFAULT 'planned' NOT NULL,
	"terminal_stage" text,
	"terminal_reason" text,
	"reconciliation_attempt_count" smallint DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"human_verified_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_conversation_human_peer_shadow_operations_id" UNIQUE("operation_id"),
	CONSTRAINT "uq_conversation_human_peer_shadow_operations_attempt" UNIQUE("attempt_coordinate"),
	CONSTRAINT "uq_conversation_human_peer_shadow_operations_object" UNIQUE("crypto_object_id"),
	CONSTRAINT "conversation_human_peer_shadow_operations_ids_portable" CHECK (octet_length("conversation_human_peer_shadow_operations"."operation_id") between 1 and 128
        and "conversation_human_peer_shadow_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_human_peer_shadow_operations"."client_idempotency_key") between 1 and 128
        and "conversation_human_peer_shadow_operations"."client_idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_human_peer_shadow_operations"."subject_human_id") between 1 and 128
        and "conversation_human_peer_shadow_operations"."subject_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_human_peer_shadow_operations"."committer_device_id") between 1 and 128
        and "conversation_human_peer_shadow_operations"."committer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_human_peer_shadow_operations"."crypto_object_id") between 1 and 128
        and "conversation_human_peer_shadow_operations"."crypto_object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_human_peer_shadow_operations"."attempt_coordinate") between 1 and 128
        and "conversation_human_peer_shadow_operations"."attempt_coordinate" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "conversation_human_peer_shadow_operations_coordinates" CHECK ("conversation_human_peer_shadow_operations"."policy_revision" > 0
        and "conversation_human_peer_shadow_operations"."human_message_id" > 0
        and "conversation_human_peer_shadow_operations"."transcript_ordinal" > 0
        and "conversation_human_peer_shadow_operations"."committer_device_signing_key_generation" >= 0
        and "conversation_human_peer_shadow_operations"."host_authorization_revision" >= 0
        and "conversation_human_peer_shadow_operations"."namespace_access_revision" >= 0
        and "conversation_human_peer_shadow_operations"."namespace_key_generation" >= 0
        and "conversation_human_peer_shadow_operations"."reconciliation_attempt_count" between 0 and 8),
	CONSTRAINT "conversation_human_peer_shadow_operations_digests" CHECK (octet_length("conversation_human_peer_shadow_operations"."namespace_head_digest") = 32
        and octet_length("conversation_human_peer_shadow_operations"."namespace_publication_digest") = 32
        and octet_length("conversation_human_peer_shadow_operations"."namespace_publication_set_digest") = 32
        and octet_length("conversation_human_peer_shadow_operations"."namespace_audience_fingerprint") = 32
        and octet_length("conversation_human_peer_shadow_operations"."plan_digest") = 32
        and ("conversation_human_peer_shadow_operations"."human_request_digest" is null
          or octet_length("conversation_human_peer_shadow_operations"."human_request_digest") = 32)
        and ("conversation_human_peer_shadow_operations"."protected_message_digest" is null
          or octet_length("conversation_human_peer_shadow_operations"."protected_message_digest") = 32)
        and ("conversation_human_peer_shadow_operations"."final_event_digest" is null
          or octet_length("conversation_human_peer_shadow_operations"."final_event_digest") = 32)),
	CONSTRAINT "conversation_human_peer_shadow_operations_receipts" CHECK ((
          "conversation_human_peer_shadow_operations"."state" = 'planned'
          and "conversation_human_peer_shadow_operations"."human_request_digest" is null
          and "conversation_human_peer_shadow_operations"."human_request_bytes" is null
          and "conversation_human_peer_shadow_operations"."protected_message_digest" is null
          and "conversation_human_peer_shadow_operations"."final_event_digest" is null
          and "conversation_human_peer_shadow_operations"."human_verified_at" is null
          and "conversation_human_peer_shadow_operations"."terminal_stage" is null
          and "conversation_human_peer_shadow_operations"."terminal_reason" is null
          and "conversation_human_peer_shadow_operations"."terminal_at" is null
        ) or (
          "conversation_human_peer_shadow_operations"."state" = 'human_verified'
          and "conversation_human_peer_shadow_operations"."human_request_digest" is not null
          and "conversation_human_peer_shadow_operations"."human_request_bytes" is not null
          and "conversation_human_peer_shadow_operations"."protected_message_digest" is null
          and "conversation_human_peer_shadow_operations"."final_event_digest" is null
          and "conversation_human_peer_shadow_operations"."human_verified_at" is not null
          and "conversation_human_peer_shadow_operations"."terminal_stage" is null
          and "conversation_human_peer_shadow_operations"."terminal_reason" is null
          and "conversation_human_peer_shadow_operations"."terminal_at" is null
        ) or (
          "conversation_human_peer_shadow_operations"."state" = 'published'
          and "conversation_human_peer_shadow_operations"."human_request_digest" is not null
          and "conversation_human_peer_shadow_operations"."human_request_bytes" is not null
          and "conversation_human_peer_shadow_operations"."protected_message_digest" is not null
          and "conversation_human_peer_shadow_operations"."final_event_digest" is not null
          and "conversation_human_peer_shadow_operations"."human_verified_at" is not null
          and "conversation_human_peer_shadow_operations"."terminal_stage" is null
          and "conversation_human_peer_shadow_operations"."terminal_reason" is null
          and "conversation_human_peer_shadow_operations"."terminal_at" is not null
        ) or (
          "conversation_human_peer_shadow_operations"."state" in ('fallback', 'failed')
          and "conversation_human_peer_shadow_operations"."terminal_stage" is not null
          and "conversation_human_peer_shadow_operations"."terminal_reason" is not null
          and "conversation_human_peer_shadow_operations"."terminal_at" is not null
        )),
	CONSTRAINT "conversation_human_peer_shadow_operations_time_order" CHECK ("conversation_human_peer_shadow_operations"."deadline_at" > "conversation_human_peer_shadow_operations"."created_at"
        and "conversation_human_peer_shadow_operations"."updated_at" >= "conversation_human_peer_shadow_operations"."created_at"
        and ("conversation_human_peer_shadow_operations"."human_verified_at" is null
          or "conversation_human_peer_shadow_operations"."human_verified_at" >= "conversation_human_peer_shadow_operations"."created_at")
        and ("conversation_human_peer_shadow_operations"."terminal_at" is null
          or "conversation_human_peer_shadow_operations"."terminal_at" >= "conversation_human_peer_shadow_operations"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "conversation_human_peer_shadow_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_human_peer_shadow_plan_attempts" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"client_idempotency_key" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"state" text DEFAULT 'checking' NOT NULL,
	"unavailable_reason" text,
	"operation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_human_peer_shadow_plan_attempts_shape" CHECK ("conversation_human_peer_shadow_plan_attempts"."policy_revision" > 0
        and octet_length("conversation_human_peer_shadow_plan_attempts"."client_idempotency_key") between 1 and 128
        and "conversation_human_peer_shadow_plan_attempts"."client_idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and (
          ("conversation_human_peer_shadow_plan_attempts"."state" = 'checking'
            and "conversation_human_peer_shadow_plan_attempts"."unavailable_reason" is null
            and "conversation_human_peer_shadow_plan_attempts"."operation_id" is null)
          or ("conversation_human_peer_shadow_plan_attempts"."state" = 'unavailable'
            and "conversation_human_peer_shadow_plan_attempts"."unavailable_reason" is not null
            and "conversation_human_peer_shadow_plan_attempts"."operation_id" is null)
          or ("conversation_human_peer_shadow_plan_attempts"."state" = 'planned'
            and "conversation_human_peer_shadow_plan_attempts"."unavailable_reason" is null
            and "conversation_human_peer_shadow_plan_attempts"."operation_id" is not null)
        )
        and "conversation_human_peer_shadow_plan_attempts"."updated_at" >= "conversation_human_peer_shadow_plan_attempts"."created_at")
);
--> statement-breakpoint
ALTER TABLE "conversation_human_peer_shadow_plan_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" DROP CONSTRAINT "session_message_crypto_revisions_object_id_scheme";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "human_peer_shadow_operation_id" text;--> statement-breakpoint
ALTER TABLE "conversation_human_peer_shadow_acknowledgements" ADD CONSTRAINT "conversation_human_peer_shadow_acknowledgements_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."conversation_human_peer_shadow_operations"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_human_peer_shadow_operations" ADD CONSTRAINT "conversation_human_peer_shadow_operations_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_human_peer_shadow_operations" ADD CONSTRAINT "conversation_human_peer_shadow_operations_room_namespace_fk" FOREIGN KEY ("room_id","namespace_id") REFERENCES "public"."rooms"("id","namespace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_human_peer_shadow_plan_attempts" ADD CONSTRAINT "conversation_human_peer_shadow_plan_attempts_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_human_peer_shadow_plan_attempts" ADD CONSTRAINT "conversation_human_peer_shadow_plan_attempts_room_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_human_peer_shadow_plan_attempts" ADD CONSTRAINT "conversation_human_peer_shadow_plan_attempts_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."conversation_human_peer_shadow_operations"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_human_peer_shadow_acknowledgements_device" ON "conversation_human_peer_shadow_acknowledgements" USING btree ("operation_id","committer_device_id","committer_device_signing_key_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_human_peer_shadow_operations_client_request" ON "conversation_human_peer_shadow_operations" USING btree ("session_id","client_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_human_peer_shadow_operations_message" ON "conversation_human_peer_shadow_operations" USING btree ("session_id","human_message_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_human_peer_shadow_operations_due" ON "conversation_human_peer_shadow_operations" USING btree ("state","deadline_at","sequence") WHERE "conversation_human_peer_shadow_operations"."state" in ('planned', 'human_verified');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_human_peer_shadow_plan_attempts_request" ON "conversation_human_peer_shadow_plan_attempts" USING btree ("session_id","client_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_human_peer_shadow_plan_attempts_operation" ON "conversation_human_peer_shadow_plan_attempts" USING btree ("operation_id") WHERE "conversation_human_peer_shadow_plan_attempts"."operation_id" is not null;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_human_peer_operation_fk" FOREIGN KEY ("human_peer_shadow_operation_id") REFERENCES "public"."conversation_human_peer_shadow_operations"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_message_crypto_revisions_human_peer_ordinal" ON "session_message_crypto_revisions" USING btree ("human_peer_shadow_operation_id","shadow_transcript_ordinal") WHERE "session_message_crypto_revisions"."human_peer_shadow_operation_id" is not null;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_human_peer_shape" CHECK ("session_message_crypto_revisions"."human_peer_shadow_operation_id" is null or (
          "session_message_crypto_revisions"."key_class" = 'human'
          and "session_message_crypto_revisions"."author_role" = 'user'
          and "session_message_crypto_revisions"."shadow_stream_id" is null
          and "session_message_crypto_revisions"."shadow_stream_start_digest" is null
          and "session_message_crypto_revisions"."shadow_stream_terminal_digest" is null
          and "session_message_crypto_revisions"."shadow_streamed_text_digest" is null
        ));--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_object_id_scheme" CHECK ((
          "session_message_crypto_revisions"."object_id_scheme" = 'message_v2'
          and "session_message_crypto_revisions"."shadow_operation_id" is null
          and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is null
          and "session_message_crypto_revisions"."shadow_transcript_ordinal" is null
          and "session_message_crypto_revisions"."shadow_reserved_created_at" is null
          and "session_message_crypto_revisions"."shadow_stream_id" is null
          and "session_message_crypto_revisions"."shadow_stream_start_digest" is null
          and "session_message_crypto_revisions"."shadow_stream_terminal_digest" is null
          and "session_message_crypto_revisions"."shadow_streamed_text_digest" is null
          and "session_message_crypto_revisions"."shadow_durable_event_digest" is null
        ) or (
          "session_message_crypto_revisions"."object_id_scheme" = 'live_shadow_v1'
          and (
            ("session_message_crypto_revisions"."shadow_operation_id" is not null
              and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is null)
            or ("session_message_crypto_revisions"."shadow_operation_id" is null
              and "session_message_crypto_revisions"."human_peer_shadow_operation_id" is not null)
          )
          and "session_message_crypto_revisions"."shadow_transcript_ordinal" > 0
          and "session_message_crypto_revisions"."shadow_reserved_created_at" is not null
        ));--> statement-breakpoint
CREATE POLICY "conversation_human_peer_shadow_acknowledgements_product_all" ON "conversation_human_peer_shadow_acknowledgements" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "conversation_human_peer_shadow_operations_product_all" ON "conversation_human_peer_shadow_operations" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "conversation_human_peer_shadow_plan_attempts_product_all" ON "conversation_human_peer_shadow_plan_attempts" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M295_HUMAN_PEER_SHADOW_AUTHORITY
ALTER TABLE "conversation_human_peer_shadow_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "conversation_human_peer_shadow_operations"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_human_peer_shadow_operations"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "conversation_human_peer_shadow_operations_sequence_seq"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "conversation_human_peer_shadow_operations_sequence_seq" TO "nautilo";--> statement-breakpoint

ALTER TABLE "conversation_human_peer_shadow_acknowledgements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "conversation_human_peer_shadow_acknowledgements"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "conversation_human_peer_shadow_acknowledgements" TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "conversation_human_peer_shadow_acknowledgements_sequence_seq"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "conversation_human_peer_shadow_acknowledgements_sequence_seq" TO "nautilo";--> statement-breakpoint

ALTER TABLE "conversation_human_peer_shadow_plan_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "conversation_human_peer_shadow_plan_attempts"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_human_peer_shadow_plan_attempts"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "conversation_human_peer_shadow_plan_attempts_sequence_seq"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "conversation_human_peer_shadow_plan_attempts_sequence_seq" TO "nautilo";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."validate_conversation_human_peer_shadow_operation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."sessions" AS session_row
   WHERE session_row.id = NEW.session_id
     AND session_row.room_id = NEW.room_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Human-peer Shadow Session/Room mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_human_peer_shadow_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_human_peer_shadow_operations_product_valid"
BEFORE INSERT ON "conversation_human_peer_shadow_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_conversation_human_peer_shadow_operation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_human_peer_shadow_operation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.sequence, NEW.operation_id, NEW.client_idempotency_key,
    NEW.policy_revision, NEW.session_id, NEW.room_id, NEW.human_message_id,
    NEW.human_message_created_at, NEW.transcript_ordinal,
    NEW.subject_human_id, NEW.committer_device_id,
    NEW.committer_device_signing_key_generation,
    NEW.host_authorization_revision, NEW.namespace_id,
    NEW.namespace_access_revision, NEW.namespace_key_generation,
    NEW.namespace_head_digest, NEW.namespace_publication_digest,
    NEW.namespace_publication_set_digest,
    NEW.namespace_audience_fingerprint, NEW.crypto_object_id,
    NEW.attempt_coordinate, NEW.plan_digest, NEW.plan_bytes,
    NEW.deadline_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.operation_id, OLD.client_idempotency_key,
    OLD.policy_revision, OLD.session_id, OLD.room_id, OLD.human_message_id,
    OLD.human_message_created_at, OLD.transcript_ordinal,
    OLD.subject_human_id, OLD.committer_device_id,
    OLD.committer_device_signing_key_generation,
    OLD.host_authorization_revision, OLD.namespace_id,
    OLD.namespace_access_revision, OLD.namespace_key_generation,
    OLD.namespace_head_digest, OLD.namespace_publication_digest,
    OLD.namespace_publication_set_digest,
    OLD.namespace_audience_fingerprint, OLD.crypto_object_id,
    OLD.attempt_coordinate, OLD.plan_digest, OLD.plan_bytes,
    OLD.deadline_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Human-peer Shadow operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.human_request_digest IS NOT NULL
        AND NEW.human_request_digest IS DISTINCT FROM OLD.human_request_digest)
    OR (OLD.human_request_bytes IS NOT NULL
        AND NEW.human_request_bytes IS DISTINCT FROM OLD.human_request_bytes)
    OR (OLD.protected_message_digest IS NOT NULL
        AND NEW.protected_message_digest IS DISTINCT FROM OLD.protected_message_digest)
    OR (OLD.final_event_digest IS NOT NULL
        AND NEW.final_event_digest IS DISTINCT FROM OLD.final_event_digest)
    OR (OLD.human_verified_at IS NOT NULL
        AND NEW.human_verified_at IS DISTINCT FROM OLD.human_verified_at)
    OR (OLD.terminal_at IS NOT NULL
        AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
  THEN
    RAISE EXCEPTION 'Human-peer Shadow receipt is immutable after publication'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'planned'
      AND NEW.state IN ('human_verified', 'fallback', 'failed'))
    OR (OLD.state = 'human_verified'
      AND NEW.state IN ('published', 'fallback', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Human-peer Shadow state transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.reconciliation_attempt_count < OLD.reconciliation_attempt_count
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Human-peer Shadow counters and time are monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."protect_conversation_human_peer_shadow_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_human_peer_shadow_operations_protected"
BEFORE UPDATE ON "conversation_human_peer_shadow_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_conversation_human_peer_shadow_operation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.disposition IN ('superseded', 'hard_delete')
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal session message crypto revision is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.sequence, NEW.session_id, NEW.message_id, NEW.edit_revision,
    NEW.room_id, NEW.namespace_id_at_allocation, NEW.crypto_object_id,
    NEW.object_id_scheme, NEW.shadow_operation_id,
    NEW.human_peer_shadow_operation_id, NEW.shadow_transcript_ordinal,
    NEW.shadow_reserved_created_at, NEW.payload_version, NEW.key_class,
    NEW.author_role, NEW.subthread_reply_classification,
    NEW.append_idempotency_key, NEW.allocation_request_digest, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.session_id, OLD.message_id, OLD.edit_revision,
    OLD.room_id, OLD.namespace_id_at_allocation, OLD.crypto_object_id,
    OLD.object_id_scheme, OLD.shadow_operation_id,
    OLD.human_peer_shadow_operation_id, OLD.shadow_transcript_ordinal,
    OLD.shadow_reserved_created_at, OLD.payload_version, OLD.key_class,
    OLD.author_role, OLD.subthread_reply_classification,
    OLD.append_idempotency_key, OLD.allocation_request_digest, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'session message crypto revision identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.shadow_stream_id IS NOT NULL
        AND NEW.shadow_stream_id IS DISTINCT FROM OLD.shadow_stream_id)
    OR (OLD.shadow_stream_start_digest IS NOT NULL
        AND NEW.shadow_stream_start_digest IS DISTINCT FROM OLD.shadow_stream_start_digest)
    OR (OLD.shadow_stream_terminal_digest IS NOT NULL
        AND NEW.shadow_stream_terminal_digest IS DISTINCT FROM OLD.shadow_stream_terminal_digest)
    OR (OLD.shadow_streamed_text_digest IS NOT NULL
        AND NEW.shadow_streamed_text_digest IS DISTINCT FROM OLD.shadow_streamed_text_digest)
    OR (OLD.shadow_durable_event_digest IS NOT NULL
        AND NEW.shadow_durable_event_digest IS DISTINCT FROM OLD.shadow_durable_event_digest)
  THEN
    RAISE EXCEPTION 'session message live Shadow evidence is immutable after publication'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_session_message_crypto_revision_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
