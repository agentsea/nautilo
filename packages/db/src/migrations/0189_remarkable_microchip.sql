CREATE TABLE "conversation_shadow_turn_operations" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"client_idempotency_key" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"session_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"human_message_id" integer NOT NULL,
	"human_message_created_at" timestamp with time zone NOT NULL,
	"subject_human_id" text NOT NULL,
	"committer_device_id" text NOT NULL,
	"host_authorization_revision" bigint NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_authorization_revision" bigint NOT NULL,
	"namespace_id" uuid NOT NULL,
	"namespace_binding_hash" "bytea" NOT NULL,
	"namespace_access_revision" integer NOT NULL,
	"namespace_key_generation" integer NOT NULL,
	"binding_revision_at_wrap" integer NOT NULL,
	"domain_id" text NOT NULL,
	"domain_epoch" bigint NOT NULL,
	"recipient_id" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"recipient_public_key" "bytea" NOT NULL,
	"attempt_coordinate" text NOT NULL,
	"plan_digest" "bytea" NOT NULL,
	"human_request_digest" "bytea",
	"grant_digest" "bytea",
	"final_causal_event_digest" "bytea",
	"client_verification_digest" "bytea",
	"job_id" uuid,
	"state" text DEFAULT 'planned' NOT NULL,
	"terminal_stage" text,
	"terminal_reason" text,
	"reconciliation_attempt_count" smallint DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_conversation_shadow_turn_operations_id" UNIQUE("operation_id"),
	CONSTRAINT "uq_conversation_shadow_turn_operations_attempt" UNIQUE("attempt_coordinate"),
	CONSTRAINT "conversation_shadow_turn_operations_ids_portable" CHECK (octet_length("conversation_shadow_turn_operations"."operation_id") between 1 and 128
        and "conversation_shadow_turn_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."client_idempotency_key") between 1 and 128
        and "conversation_shadow_turn_operations"."client_idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."subject_human_id") between 1 and 128
        and "conversation_shadow_turn_operations"."subject_human_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."committer_device_id") between 1 and 128
        and "conversation_shadow_turn_operations"."committer_device_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."domain_id") between 1 and 128
        and "conversation_shadow_turn_operations"."domain_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."recipient_id") between 1 and 128
        and "conversation_shadow_turn_operations"."recipient_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."recipient_key_id") between 1 and 128
        and "conversation_shadow_turn_operations"."recipient_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shadow_turn_operations"."attempt_coordinate") between 1 and 128
        and "conversation_shadow_turn_operations"."attempt_coordinate" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "conversation_shadow_turn_operations_coordinate_shape" CHECK ("conversation_shadow_turn_operations"."policy_revision" > 0
        and "conversation_shadow_turn_operations"."human_message_id" > 0
        and "conversation_shadow_turn_operations"."host_authorization_revision" >= 0
        and "conversation_shadow_turn_operations"."agent_authorization_revision" >= 0
        and "conversation_shadow_turn_operations"."namespace_access_revision" >= 0
        and "conversation_shadow_turn_operations"."namespace_key_generation" >= 0
        and "conversation_shadow_turn_operations"."binding_revision_at_wrap" >= 0
        and "conversation_shadow_turn_operations"."domain_epoch" >= 0),
	CONSTRAINT "conversation_shadow_turn_operations_digest_shape" CHECK (octet_length("conversation_shadow_turn_operations"."namespace_binding_hash") = 32
        and octet_length("conversation_shadow_turn_operations"."plan_digest") = 32
        and ("conversation_shadow_turn_operations"."human_request_digest" is null or octet_length("conversation_shadow_turn_operations"."human_request_digest") = 32)
        and ("conversation_shadow_turn_operations"."grant_digest" is null or octet_length("conversation_shadow_turn_operations"."grant_digest") = 32)
        and ("conversation_shadow_turn_operations"."final_causal_event_digest" is null or octet_length("conversation_shadow_turn_operations"."final_causal_event_digest") = 32)
        and ("conversation_shadow_turn_operations"."client_verification_digest" is null or octet_length("conversation_shadow_turn_operations"."client_verification_digest") = 32)),
	CONSTRAINT "conversation_shadow_turn_operations_recipient_key_shape" CHECK (octet_length("conversation_shadow_turn_operations"."recipient_public_key") = 65),
	CONSTRAINT "conversation_shadow_turn_operations_receipt_coherent" CHECK (("conversation_shadow_turn_operations"."human_request_digest" is null) = ("conversation_shadow_turn_operations"."grant_digest" is null)
        and ("conversation_shadow_turn_operations"."state" not in ('human_verified', 'running', 'completed', 'client_verified')
          or "conversation_shadow_turn_operations"."human_request_digest" is not null)
        and ("conversation_shadow_turn_operations"."client_verification_digest" is null
          or "conversation_shadow_turn_operations"."state" in ('client_verified', 'failed'))
        and ("conversation_shadow_turn_operations"."final_causal_event_digest" is null
          or "conversation_shadow_turn_operations"."state" in ('completed', 'client_verified'))),
	CONSTRAINT "conversation_shadow_turn_operations_terminal_coherent" CHECK ((
        "conversation_shadow_turn_operations"."state" in ('planned', 'human_verified', 'running')
        and "conversation_shadow_turn_operations"."terminal_stage" is null
        and "conversation_shadow_turn_operations"."terminal_reason" is null
        and "conversation_shadow_turn_operations"."terminal_at" is null
      ) or (
        "conversation_shadow_turn_operations"."state" in ('fallback', 'failed')
        and "conversation_shadow_turn_operations"."terminal_stage" is not null
        and "conversation_shadow_turn_operations"."terminal_reason" is not null
        and "conversation_shadow_turn_operations"."terminal_at" is not null
      ) or (
        "conversation_shadow_turn_operations"."state" in ('completed', 'client_verified')
        and "conversation_shadow_turn_operations"."terminal_stage" is null
        and "conversation_shadow_turn_operations"."terminal_reason" is null
        and "conversation_shadow_turn_operations"."terminal_at" is not null
      )),
	CONSTRAINT "conversation_shadow_turn_operations_attempt_bound" CHECK ("conversation_shadow_turn_operations"."reconciliation_attempt_count" between 0 and 8),
	CONSTRAINT "conversation_shadow_turn_operations_time_order" CHECK ("conversation_shadow_turn_operations"."deadline_at" > "conversation_shadow_turn_operations"."created_at"
        and ("conversation_shadow_turn_operations"."started_at" is null or "conversation_shadow_turn_operations"."started_at" >= "conversation_shadow_turn_operations"."created_at")
        and ("conversation_shadow_turn_operations"."terminal_at" is null or "conversation_shadow_turn_operations"."terminal_at" >= "conversation_shadow_turn_operations"."created_at")
        and "conversation_shadow_turn_operations"."updated_at" >= "conversation_shadow_turn_operations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encryption_transition_policy" RENAME COLUMN "shadow_writes_started_at" TO "shadow_encryption_started_at";--> statement-breakpoint
ALTER TABLE "encryption_transition_policy" DROP CONSTRAINT "encryption_transition_policy_mode_check";--> statement-breakpoint
ALTER TABLE "encryption_transition_policy" DROP CONSTRAINT "encryption_transition_policy_shadow_epoch_coherent";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "object_id_scheme" text DEFAULT 'message_v2' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "shadow_operation_id" text;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "shadow_transcript_ordinal" integer;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "shadow_reserved_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "shadow_stream_id" text;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "shadow_stream_start_digest" "bytea";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "shadow_stream_terminal_digest" "bytea";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "shadow_streamed_text_digest" "bytea";--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "shadow_durable_event_digest" "bytea";--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD CONSTRAINT "conversation_shadow_turn_operations_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shadow_turn_operations" ADD CONSTRAINT "conversation_shadow_turn_operations_room_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_shadow_turn_operations_client_request" ON "conversation_shadow_turn_operations" USING btree ("session_id","client_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_shadow_turn_operations_job" ON "conversation_shadow_turn_operations" USING btree ("job_id") WHERE "conversation_shadow_turn_operations"."job_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_conversation_shadow_turn_operations_due" ON "conversation_shadow_turn_operations" USING btree ("state","deadline_at","sequence") WHERE "conversation_shadow_turn_operations"."state" in ('planned', 'human_verified', 'running');--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_shadow_operation_fk" FOREIGN KEY ("shadow_operation_id") REFERENCES "public"."conversation_shadow_turn_operations"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_message_crypto_revisions_shadow_ordinal" ON "session_message_crypto_revisions" USING btree ("shadow_operation_id","shadow_transcript_ordinal") WHERE "session_message_crypto_revisions"."shadow_operation_id" is not null;--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_object_id_scheme" CHECK ((
          "session_message_crypto_revisions"."object_id_scheme" = 'message_v2'
          and "session_message_crypto_revisions"."shadow_operation_id" is null
          and "session_message_crypto_revisions"."shadow_transcript_ordinal" is null
          and "session_message_crypto_revisions"."shadow_reserved_created_at" is null
          and "session_message_crypto_revisions"."shadow_stream_id" is null
          and "session_message_crypto_revisions"."shadow_stream_start_digest" is null
          and "session_message_crypto_revisions"."shadow_stream_terminal_digest" is null
          and "session_message_crypto_revisions"."shadow_streamed_text_digest" is null
          and "session_message_crypto_revisions"."shadow_durable_event_digest" is null
        ) or (
          "session_message_crypto_revisions"."object_id_scheme" = 'live_shadow_v1'
          and "session_message_crypto_revisions"."shadow_operation_id" is not null
          and "session_message_crypto_revisions"."shadow_transcript_ordinal" > 0
          and "session_message_crypto_revisions"."shadow_reserved_created_at" is not null
        ));--> statement-breakpoint
ALTER TABLE "session_message_crypto_revisions" ADD CONSTRAINT "session_message_crypto_revisions_shadow_digest_shape" CHECK (("session_message_crypto_revisions"."shadow_stream_start_digest" is null
          or octet_length("session_message_crypto_revisions"."shadow_stream_start_digest") = 32)
          and ("session_message_crypto_revisions"."shadow_stream_terminal_digest" is null
          or octet_length("session_message_crypto_revisions"."shadow_stream_terminal_digest") = 32)
          and ("session_message_crypto_revisions"."shadow_streamed_text_digest" is null
            or octet_length("session_message_crypto_revisions"."shadow_streamed_text_digest") = 32)
          and ("session_message_crypto_revisions"."shadow_durable_event_digest" is null
            or octet_length("session_message_crypto_revisions"."shadow_durable_event_digest") = 32)
          and (("session_message_crypto_revisions"."shadow_stream_id" is null
              and "session_message_crypto_revisions"."shadow_stream_start_digest" is null
              and "session_message_crypto_revisions"."shadow_stream_terminal_digest" is null
              and "session_message_crypto_revisions"."shadow_streamed_text_digest" is null)
            or ("session_message_crypto_revisions"."shadow_stream_id" is not null
              and octet_length("session_message_crypto_revisions"."shadow_stream_id") between 1 and 128
              and "session_message_crypto_revisions"."shadow_stream_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
              and "session_message_crypto_revisions"."shadow_stream_start_digest" is not null
              and "session_message_crypto_revisions"."shadow_stream_terminal_digest" is not null
              and "session_message_crypto_revisions"."shadow_streamed_text_digest" is not null)));--> statement-breakpoint
-- M282_LIVE_SHADOW_POLICY_RESET
UPDATE "encryption_transition_policy"
SET "mode" = 'plaintext_only',
    "shadow_encryption_started_at" = NULL,
    "revision" = "revision" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "mode" IN ('shadow_writes', 'shadow_reads', 'encrypted_only');--> statement-breakpoint
ALTER TABLE "encryption_transition_policy" ADD CONSTRAINT "encryption_transition_policy_mode_check" CHECK ("encryption_transition_policy"."mode" in ('plaintext_only', 'shadow_encryption', 'encrypted_only'));--> statement-breakpoint
ALTER TABLE "encryption_transition_policy" ADD CONSTRAINT "encryption_transition_policy_shadow_epoch_coherent" CHECK (("encryption_transition_policy"."mode" = 'plaintext_only' and "encryption_transition_policy"."shadow_encryption_started_at" is null)
        or ("encryption_transition_policy"."mode" <> 'plaintext_only' and "encryption_transition_policy"."shadow_encryption_started_at" is not null));--> statement-breakpoint
CREATE POLICY "conversation_shadow_turn_operations_product_all" ON "conversation_shadow_turn_operations" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M282_LIVE_SHADOW_TURN_AUTHORITY
ALTER TABLE "conversation_shadow_turn_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "conversation_shadow_turn_operations"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_shadow_turn_operations"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "conversation_shadow_turn_operations_sequence_seq"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "conversation_shadow_turn_operations_sequence_seq" TO "nautilo";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."validate_conversation_shadow_turn_operation"()
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
     AND session_row.agent_id = NEW.agent_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation Shadow turn Session/Room/Agent mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_shadow_turn_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shadow_turn_operations_product_valid"
BEFORE INSERT ON "conversation_shadow_turn_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_conversation_shadow_turn_operation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_shadow_turn_operation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.sequence, NEW.operation_id, NEW.client_idempotency_key,
    NEW.policy_revision, NEW.session_id, NEW.room_id, NEW.human_message_id,
    NEW.human_message_created_at, NEW.subject_human_id,
    NEW.committer_device_id, NEW.host_authorization_revision,
    NEW.agent_id, NEW.agent_authorization_revision, NEW.namespace_id,
    NEW.namespace_binding_hash, NEW.namespace_access_revision,
    NEW.namespace_key_generation, NEW.binding_revision_at_wrap,
    NEW.domain_id, NEW.domain_epoch, NEW.recipient_id, NEW.recipient_key_id,
    NEW.recipient_public_key, NEW.attempt_coordinate, NEW.plan_digest,
    NEW.deadline_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.operation_id, OLD.client_idempotency_key,
    OLD.policy_revision, OLD.session_id, OLD.room_id, OLD.human_message_id,
    OLD.human_message_created_at, OLD.subject_human_id,
    OLD.committer_device_id, OLD.host_authorization_revision,
    OLD.agent_id, OLD.agent_authorization_revision, OLD.namespace_id,
    OLD.namespace_binding_hash, OLD.namespace_access_revision,
    OLD.namespace_key_generation, OLD.binding_revision_at_wrap,
    OLD.domain_id, OLD.domain_epoch, OLD.recipient_id, OLD.recipient_key_id,
    OLD.recipient_public_key, OLD.attempt_coordinate, OLD.plan_digest,
    OLD.deadline_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'conversation Shadow turn identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.human_request_digest IS NOT NULL
        AND NEW.human_request_digest IS DISTINCT FROM OLD.human_request_digest)
    OR (OLD.grant_digest IS NOT NULL
        AND NEW.grant_digest IS DISTINCT FROM OLD.grant_digest)
    OR (OLD.final_causal_event_digest IS NOT NULL
        AND NEW.final_causal_event_digest IS DISTINCT FROM OLD.final_causal_event_digest)
    OR (OLD.client_verification_digest IS NOT NULL
        AND NEW.client_verification_digest IS DISTINCT FROM OLD.client_verification_digest)
    OR (OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id)
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
    OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
  THEN
    RAISE EXCEPTION 'conversation Shadow turn receipt is immutable after publication'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'planned' AND NEW.state IN ('human_verified', 'fallback', 'failed'))
    OR (OLD.state = 'human_verified' AND NEW.state IN ('running', 'fallback', 'failed'))
    OR (OLD.state = 'running' AND NEW.state IN ('fallback', 'completed', 'failed'))
    OR (OLD.state = 'completed' AND NEW.state IN ('client_verified', 'failed'))
  ) THEN
    RAISE EXCEPTION 'conversation Shadow turn state transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reconciliation_attempt_count < OLD.reconciliation_attempt_count
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'conversation Shadow turn counters and time are monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."protect_conversation_shadow_turn_operation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shadow_turn_operations_protected"
BEFORE UPDATE ON "conversation_shadow_turn_operations"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_conversation_shadow_turn_operation"();--> statement-breakpoint

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
    NEW.shadow_transcript_ordinal, NEW.shadow_reserved_created_at,
    NEW.payload_version, NEW.key_class,
    NEW.author_role, NEW.subthread_reply_classification,
    NEW.append_idempotency_key, NEW.allocation_request_digest, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.session_id, OLD.message_id, OLD.edit_revision,
    OLD.room_id, OLD.namespace_id_at_allocation, OLD.crypto_object_id,
    OLD.object_id_scheme, OLD.shadow_operation_id,
    OLD.shadow_transcript_ordinal, OLD.shadow_reserved_created_at,
    OLD.payload_version, OLD.key_class,
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
