CREATE TABLE "conversation_shared_agent_shadow_invocations" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"invocation_id" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"session_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"invoking_human_id" text NOT NULL,
	"invoking_device_id" text NOT NULL,
	"authorization_device_id" text NOT NULL,
	"client_action_session_id" text NOT NULL,
	"input_count" integer NOT NULL,
	"input_set_digest" "bytea" NOT NULL,
	"authorization_plan_bytes" "bytea",
	"authorization_plan_digest" "bytea",
	"recipient_key_id" text,
	"authorization_disposition" text,
	"authorization_digest" "bytea",
	"authorization_session_reference" text,
	"state" text DEFAULT 'awaiting_authorization' NOT NULL,
	"terminal_reason" text,
	"deadline_at" timestamp with time zone NOT NULL,
	"authorized_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_conversation_shared_agent_shadow_invocations_id" UNIQUE("invocation_id"),
	CONSTRAINT "conversation_shared_agent_shadow_invocations_shape" CHECK (octet_length("conversation_shared_agent_shadow_invocations"."invocation_id") between 1 and 128
        and "conversation_shared_agent_shadow_invocations"."invocation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shared_agent_shadow_invocations"."invoking_human_id") between 1 and 128
        and octet_length("conversation_shared_agent_shadow_invocations"."invoking_device_id") between 1 and 128
        and octet_length("conversation_shared_agent_shadow_invocations"."authorization_device_id") between 1 and 128
        and octet_length("conversation_shared_agent_shadow_invocations"."client_action_session_id") between 1 and 128
        and "conversation_shared_agent_shadow_invocations"."policy_revision" > 0
        and "conversation_shared_agent_shadow_invocations"."input_count" > 0
        and octet_length("conversation_shared_agent_shadow_invocations"."input_set_digest") = 32
        and ("conversation_shared_agent_shadow_invocations"."authorization_digest" is null
          or octet_length("conversation_shared_agent_shadow_invocations"."authorization_digest") = 32)
        and ("conversation_shared_agent_shadow_invocations"."authorization_plan_digest" is null
          or octet_length("conversation_shared_agent_shadow_invocations"."authorization_plan_digest") = 32)
        and "conversation_shared_agent_shadow_invocations"."deadline_at" > "conversation_shared_agent_shadow_invocations"."created_at"
        and "conversation_shared_agent_shadow_invocations"."updated_at" >= "conversation_shared_agent_shadow_invocations"."created_at"),
	CONSTRAINT "conversation_shared_agent_shadow_invocations_authorization" CHECK (("conversation_shared_agent_shadow_invocations"."state" = 'awaiting_authorization'
          and "conversation_shared_agent_shadow_invocations"."authorization_disposition" is null
          and "conversation_shared_agent_shadow_invocations"."authorization_digest" is null
          and "conversation_shared_agent_shadow_invocations"."authorization_session_reference" is null
          and "conversation_shared_agent_shadow_invocations"."authorized_at" is null
          and "conversation_shared_agent_shadow_invocations"."terminal_at" is null)
        or ("conversation_shared_agent_shadow_invocations"."state" in ('authorized', 'running')
          and "conversation_shared_agent_shadow_invocations"."authorization_disposition" is not null
          and "conversation_shared_agent_shadow_invocations"."authorization_digest" is not null
          and "conversation_shared_agent_shadow_invocations"."authorization_session_reference" is not null
          and "conversation_shared_agent_shadow_invocations"."authorized_at" is not null
          and "conversation_shared_agent_shadow_invocations"."terminal_at" is null)
        or ("conversation_shared_agent_shadow_invocations"."state" in ('completed', 'fallback', 'failed')
          and "conversation_shared_agent_shadow_invocations"."terminal_at" is not null)),
	CONSTRAINT "conversation_shared_agent_shadow_invocations_plan" CHECK (("conversation_shared_agent_shadow_invocations"."authorization_plan_bytes" is null
          and "conversation_shared_agent_shadow_invocations"."authorization_plan_digest" is null
          and "conversation_shared_agent_shadow_invocations"."recipient_key_id" is null)
        or ("conversation_shared_agent_shadow_invocations"."authorization_plan_bytes" is not null
          and "conversation_shared_agent_shadow_invocations"."authorization_plan_digest" is not null
          and "conversation_shared_agent_shadow_invocations"."recipient_key_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_invocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_executions" DROP CONSTRAINT "conversation_shared_agent_shadow_executions_shape";--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_executions" DROP CONSTRAINT "conversation_shared_agent_shadow_executions_authorization";--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_executions" DROP CONSTRAINT "conversation_shared_agent_shadow_executions_plan";--> statement-breakpoint
DROP INDEX "uq_conversation_shared_agent_shadow_execution_inputs_operation";--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_operations" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_executions" ADD COLUMN "invocation_id" text;--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_executions" ADD COLUMN "authorization_device_id" text;--> statement-breakpoint
UPDATE "conversation_shared_agent_shadow_executions" SET "authorization_device_id" = "invoking_device_id" WHERE "authorization_device_id" IS NULL;--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_executions" ALTER COLUMN "authorization_device_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_executions" ADD COLUMN "execution_kind" text DEFAULT 'turn' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_invocations" ADD CONSTRAINT "conversation_shared_agent_shadow_invocations_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_invocations" ADD CONSTRAINT "conversation_shared_agent_shadow_invocations_room_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversation_shared_agent_shadow_invocations_due" ON "conversation_shared_agent_shadow_invocations" USING btree ("state","deadline_at","sequence") WHERE "conversation_shared_agent_shadow_invocations"."state" in ('awaiting_authorization', 'authorized', 'running');--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_executions" ADD CONSTRAINT "conversation_shared_agent_shadow_executions_invocation_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."conversation_shared_agent_shadow_invocations"("invocation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversation_shared_agent_shadow_execution_inputs_operation" ON "conversation_shared_agent_shadow_execution_inputs" USING btree ("execution_id","human_operation_id");--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_executions" ADD CONSTRAINT "conversation_shared_agent_shadow_executions_shape" CHECK (octet_length("conversation_shared_agent_shadow_executions"."execution_id") between 1 and 128
        and "conversation_shared_agent_shadow_executions"."execution_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
        and octet_length("conversation_shared_agent_shadow_executions"."invoking_human_id") between 1 and 128
        and octet_length("conversation_shared_agent_shadow_executions"."invoking_device_id") between 1 and 128
        and octet_length("conversation_shared_agent_shadow_executions"."authorization_device_id") between 1 and 128
        and octet_length("conversation_shared_agent_shadow_executions"."client_action_session_id") between 1 and 128
        and "conversation_shared_agent_shadow_executions"."policy_revision" > 0
        and "conversation_shared_agent_shadow_executions"."input_count" > 0
        and octet_length("conversation_shared_agent_shadow_executions"."input_set_digest") = 32
        and ("conversation_shared_agent_shadow_executions"."authorization_digest" is null
          or octet_length("conversation_shared_agent_shadow_executions"."authorization_digest") = 32)
        and ("conversation_shared_agent_shadow_executions"."plan_digest" is null
          or octet_length("conversation_shared_agent_shadow_executions"."plan_digest") = 32)
        and ("conversation_shared_agent_shadow_executions"."authorization_plan_digest" is null
          or octet_length("conversation_shared_agent_shadow_executions"."authorization_plan_digest") = 32)
        and ("conversation_shared_agent_shadow_executions"."final_causal_event_digest" is null
          or octet_length("conversation_shared_agent_shadow_executions"."final_causal_event_digest") = 32)
        and ("conversation_shared_agent_shadow_executions"."agent_runtime_generation" is null
          or "conversation_shared_agent_shadow_executions"."agent_runtime_generation" >= 0)
        and "conversation_shared_agent_shadow_executions"."deadline_at" > "conversation_shared_agent_shadow_executions"."created_at"
        and "conversation_shared_agent_shadow_executions"."updated_at" >= "conversation_shared_agent_shadow_executions"."created_at");--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_executions" ADD CONSTRAINT "conversation_shared_agent_shadow_executions_authorization" CHECK (("conversation_shared_agent_shadow_executions"."state" = 'awaiting_authorization'
          and "conversation_shared_agent_shadow_executions"."authorization_disposition" is null
          and "conversation_shared_agent_shadow_executions"."authorization_digest" is null
          and "conversation_shared_agent_shadow_executions"."authorization_session_reference" is null
          and "conversation_shared_agent_shadow_executions"."authorized_at" is null
          and "conversation_shared_agent_shadow_executions"."terminal_at" is null)
        or ("conversation_shared_agent_shadow_executions"."state" in ('authorized', 'running')
          and (("conversation_shared_agent_shadow_executions"."invocation_id" is null
              and "conversation_shared_agent_shadow_executions"."authorization_disposition" is not null
              and "conversation_shared_agent_shadow_executions"."authorization_digest" is not null
              and "conversation_shared_agent_shadow_executions"."authorization_session_reference" is not null)
            or ("conversation_shared_agent_shadow_executions"."invocation_id" is not null
              and "conversation_shared_agent_shadow_executions"."authorization_disposition" is null
              and "conversation_shared_agent_shadow_executions"."authorization_digest" is null
              and "conversation_shared_agent_shadow_executions"."authorization_session_reference" is null))
          and "conversation_shared_agent_shadow_executions"."authorized_at" is not null
          and "conversation_shared_agent_shadow_executions"."terminal_at" is null)
        or ("conversation_shared_agent_shadow_executions"."state" in ('completed', 'fallback', 'failed')
          and "conversation_shared_agent_shadow_executions"."terminal_at" is not null));--> statement-breakpoint
ALTER TABLE "conversation_shared_agent_shadow_executions" ADD CONSTRAINT "conversation_shared_agent_shadow_executions_plan" CHECK (("conversation_shared_agent_shadow_executions"."invocation_id" is null
          and (("conversation_shared_agent_shadow_executions"."plan_bytes" is null
          and "conversation_shared_agent_shadow_executions"."plan_digest" is null
          and "conversation_shared_agent_shadow_executions"."authorization_plan_bytes" is null
          and "conversation_shared_agent_shadow_executions"."authorization_plan_digest" is null
          and "conversation_shared_agent_shadow_executions"."recipient_key_id" is null
          and "conversation_shared_agent_shadow_executions"."agent_runtime_generation" is null
          and "conversation_shared_agent_shadow_executions"."agent_signer_key_id" is null
          and "conversation_shared_agent_shadow_executions"."agent_signer_public_key" is null)
        or ("conversation_shared_agent_shadow_executions"."plan_bytes" is not null
          and "conversation_shared_agent_shadow_executions"."plan_digest" is not null
          and "conversation_shared_agent_shadow_executions"."authorization_plan_bytes" is not null
          and "conversation_shared_agent_shadow_executions"."authorization_plan_digest" is not null
          and "conversation_shared_agent_shadow_executions"."recipient_key_id" is not null
          and "conversation_shared_agent_shadow_executions"."agent_runtime_generation" is not null
          and "conversation_shared_agent_shadow_executions"."agent_signer_key_id" is not null
          and "conversation_shared_agent_shadow_executions"."agent_signer_public_key" is not null
          and octet_length("conversation_shared_agent_shadow_executions"."agent_signer_public_key") > 0))
        or ("conversation_shared_agent_shadow_executions"."invocation_id" is not null
          and "conversation_shared_agent_shadow_executions"."authorization_plan_bytes" is null
          and "conversation_shared_agent_shadow_executions"."authorization_plan_digest" is null
          and "conversation_shared_agent_shadow_executions"."recipient_key_id" is null
          and (("conversation_shared_agent_shadow_executions"."plan_bytes" is null
              and "conversation_shared_agent_shadow_executions"."plan_digest" is null
              and "conversation_shared_agent_shadow_executions"."agent_runtime_generation" is null
              and "conversation_shared_agent_shadow_executions"."agent_signer_key_id" is null
              and "conversation_shared_agent_shadow_executions"."agent_signer_public_key" is null)
            or ("conversation_shared_agent_shadow_executions"."plan_bytes" is not null
              and "conversation_shared_agent_shadow_executions"."plan_digest" is not null
              and "conversation_shared_agent_shadow_executions"."agent_runtime_generation" is not null
              and "conversation_shared_agent_shadow_executions"."agent_signer_key_id" is not null
              and "conversation_shared_agent_shadow_executions"."agent_signer_public_key" is not null
              and octet_length("conversation_shared_agent_shadow_executions"."agent_signer_public_key") > 0)))));--> statement-breakpoint
CREATE POLICY "conversation_shared_agent_shadow_invocations_product_all" ON "conversation_shared_agent_shadow_invocations" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- M298_RUNTIME_FOREGROUND_AUTHORITY
ALTER TABLE "conversation_shared_agent_shadow_invocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "conversation_shared_agent_shadow_invocations"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_shared_agent_shadow_invocations"
  TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "conversation_shared_agent_shadow_invocations_sequence_seq"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "conversation_shared_agent_shadow_invocations_sequence_seq" TO "nautilo";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."validate_conversation_shared_agent_shadow_invocation"()
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
    RAISE EXCEPTION 'Shared-Agent Runtime invocation Session/Room mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_shared_agent_shadow_invocation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shared_agent_shadow_invocations_product_valid"
BEFORE INSERT ON "conversation_shared_agent_shadow_invocations"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_conversation_shared_agent_shadow_invocation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."validate_conversation_shared_agent_shadow_execution"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."sessions" AS session_row
    JOIN "public"."rooms" AS source_room
      ON source_room.id = NEW.room_id
    JOIN "public"."rooms" AS authority_room
      ON authority_room.id = COALESCE(source_room.parent_room_id, source_room.id)
    JOIN "public"."room_members" AS member
      ON member.room_id = authority_room.id
    JOIN "public"."actors" AS agent_actor
      ON agent_actor.id = member.actor_id
     AND agent_actor.kind = 'agent'
     AND agent_actor.agent_id = NEW.agent_id
   WHERE session_row.id = NEW.session_id
     AND session_row.room_id = NEW.room_id
     AND session_row.agent_id = NEW.agent_id
     AND (
       (source_room.parent_room_id IS NULL
         AND source_room.kind IN ('private', 'group'))
       OR (source_room.parent_room_id IS NOT NULL
         AND source_room.kind = 'subthread'
         AND authority_room.kind IN ('private', 'group'))
     )
   FOR SHARE OF session_row, source_room, authority_room, member, agent_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-Agent execution Session/Room/Agent mismatch'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.invocation_id IS NOT NULL THEN
    PERFORM 1
      FROM "public"."conversation_shared_agent_shadow_invocations" AS invocation
     WHERE invocation.invocation_id = NEW.invocation_id
       AND invocation.room_id = NEW.room_id
       AND invocation.invoking_human_id = NEW.invoking_human_id
       AND invocation.invoking_device_id = NEW.invoking_device_id
       AND invocation.client_action_session_id = NEW.client_action_session_id
       AND invocation.policy_revision = NEW.policy_revision
       AND invocation.input_count = NEW.input_count
       AND invocation.input_set_digest = NEW.input_set_digest
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shared-Agent execution Runtime invocation mismatch'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_shared_agent_shadow_execution"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shared_agent_shadow_executions_product_valid"
BEFORE INSERT ON "conversation_shared_agent_shadow_executions"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_conversation_shared_agent_shadow_execution"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_shared_agent_shadow_invocation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.sequence, NEW.invocation_id, NEW.policy_revision,
    NEW.session_id, NEW.room_id, NEW.invoking_human_id,
    NEW.invoking_device_id, NEW.client_action_session_id,
    NEW.input_count, NEW.input_set_digest, NEW.deadline_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.invocation_id, OLD.policy_revision,
    OLD.session_id, OLD.room_id, OLD.invoking_human_id,
    OLD.invoking_device_id, OLD.client_action_session_id,
    OLD.input_count, OLD.input_set_digest, OLD.deadline_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'awaiting_authorization'
      AND NEW.state IN ('authorized', 'fallback', 'failed'))
    OR (OLD.state = 'authorized'
      AND NEW.state IN ('running', 'completed', 'fallback', 'failed'))
    OR (OLD.state = 'running'
      AND NEW.state IN ('completed', 'fallback', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.authorization_plan_bytes IS NOT NULL
        AND NEW.authorization_plan_bytes IS DISTINCT FROM OLD.authorization_plan_bytes)
    OR (OLD.authorization_plan_digest IS NOT NULL
        AND NEW.authorization_plan_digest IS DISTINCT FROM OLD.authorization_plan_digest)
    OR (OLD.recipient_key_id IS NOT NULL
        AND NEW.recipient_key_id IS DISTINCT FROM OLD.recipient_key_id)
    OR (OLD.authorization_disposition IS NOT NULL
        AND NEW.authorization_disposition IS DISTINCT FROM OLD.authorization_disposition)
    OR (OLD.authorization_digest IS NOT NULL
        AND NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest)
    OR (OLD.authorization_session_reference IS NOT NULL
        AND NEW.authorization_session_reference IS DISTINCT FROM OLD.authorization_session_reference)
    OR (OLD.authorized_at IS NOT NULL
        AND NEW.authorized_at IS DISTINCT FROM OLD.authorized_at)
    OR (OLD.terminal_at IS NOT NULL
        AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
    OR (OLD.terminal_reason IS NOT NULL
        AND NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason)
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation receipts are immutable and monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."protect_conversation_shared_agent_shadow_invocation"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "conversation_shared_agent_shadow_invocations_protected"
BEFORE UPDATE ON "conversation_shared_agent_shadow_invocations"
FOR EACH ROW EXECUTE FUNCTION "public"."protect_conversation_shared_agent_shadow_invocation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_shared_agent_shadow_execution"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(
    NEW.sequence, NEW.execution_id, NEW.invocation_id, NEW.policy_revision,
    NEW.session_id, NEW.room_id,
    NEW.agent_id, NEW.invoking_human_id, NEW.invoking_device_id,
    NEW.client_action_session_id,
    NEW.input_count, NEW.input_set_digest, NEW.deadline_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence, OLD.execution_id, OLD.invocation_id, OLD.policy_revision,
    OLD.session_id, OLD.room_id,
    OLD.agent_id, OLD.invoking_human_id, OLD.invoking_device_id,
    OLD.client_action_session_id,
    OLD.input_count, OLD.input_set_digest, OLD.deadline_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Shared-Agent execution identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'awaiting_authorization'
      AND NEW.state IN ('authorized', 'fallback', 'failed'))
    OR (OLD.state = 'authorized'
      AND NEW.state IN ('running', 'fallback', 'failed'))
    OR (OLD.state = 'running'
      AND NEW.state IN ('completed', 'fallback', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Shared-Agent execution transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.plan_bytes IS NOT NULL
        AND NEW.plan_bytes IS DISTINCT FROM OLD.plan_bytes)
    OR (OLD.plan_digest IS NOT NULL
        AND NEW.plan_digest IS DISTINCT FROM OLD.plan_digest)
    OR (OLD.authorization_plan_bytes IS NOT NULL
        AND NEW.authorization_plan_bytes IS DISTINCT FROM OLD.authorization_plan_bytes)
    OR (OLD.authorization_plan_digest IS NOT NULL
        AND NEW.authorization_plan_digest IS DISTINCT FROM OLD.authorization_plan_digest)
    OR (OLD.recipient_key_id IS NOT NULL
        AND NEW.recipient_key_id IS DISTINCT FROM OLD.recipient_key_id)
    OR (OLD.agent_runtime_generation IS NOT NULL
        AND NEW.agent_runtime_generation IS DISTINCT FROM OLD.agent_runtime_generation)
    OR (OLD.agent_signer_key_id IS NOT NULL
        AND NEW.agent_signer_key_id IS DISTINCT FROM OLD.agent_signer_key_id)
    OR (OLD.agent_signer_public_key IS NOT NULL
        AND NEW.agent_signer_public_key IS DISTINCT FROM OLD.agent_signer_public_key)
    OR (OLD.authorization_disposition IS NOT NULL
        AND NEW.authorization_disposition IS DISTINCT FROM OLD.authorization_disposition)
    OR (OLD.authorization_digest IS NOT NULL
        AND NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest)
    OR (OLD.authorization_session_reference IS NOT NULL
        AND NEW.authorization_session_reference IS DISTINCT FROM OLD.authorization_session_reference)
    OR (OLD.authorized_at IS NOT NULL
        AND NEW.authorized_at IS DISTINCT FROM OLD.authorized_at)
    OR (OLD.terminal_at IS NOT NULL
        AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
    OR (OLD.terminal_reason IS NOT NULL
        AND NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason)
    OR (OLD.final_causal_event_digest IS NOT NULL
        AND NEW.final_causal_event_digest IS DISTINCT FROM OLD.final_causal_event_digest)
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Shared-Agent execution receipts are immutable and monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."protect_conversation_shared_agent_shadow_execution"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."validate_conversation_shared_agent_shadow_execution_input"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."conversation_shared_agent_shadow_executions" AS execution
    JOIN "public"."conversation_shared_agent_shadow_operations" AS operation
      ON operation.operation_id = NEW.human_operation_id
   WHERE execution.execution_id = NEW.execution_id
     AND operation.room_id = execution.room_id
     AND operation.subject_human_id = execution.invoking_human_id
     AND operation.committer_device_id = execution.invoking_device_id
     AND operation.human_message_id = NEW.message_id
     AND operation.state = 'published'
     AND ((execution.invocation_id IS NULL
            AND operation.agent_id = execution.agent_id)
       OR (execution.invocation_id IS NOT NULL
            AND operation.agent_id IS NULL
            AND EXISTS (
              SELECT 1
                FROM "public"."conversation_shared_agent_shadow_invocations" AS invocation
               WHERE invocation.invocation_id = execution.invocation_id
                 AND invocation.room_id = execution.room_id
                 AND invocation.invoking_human_id = execution.invoking_human_id
                 AND invocation.invoking_device_id = execution.invoking_device_id
                 AND invocation.client_action_session_id
                   = execution.client_action_session_id
                 AND invocation.policy_revision = execution.policy_revision
                 AND invocation.input_count = execution.input_count
                 AND invocation.input_set_digest = execution.input_set_digest)))
   FOR SHARE OF execution, operation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-Agent execution input authority mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."validate_conversation_shared_agent_shadow_execution_input"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint

-- M298_RUNTIME_HUMAN_AUDIENCE_REVISION
CREATE OR REPLACE FUNCTION "public"."advance_room_namespace_access_revision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  old_is_human boolean := false;
  new_is_human boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1 FROM "public"."actors"
       WHERE id = OLD.actor_id AND kind = 'user'
    ) INTO old_is_human;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT EXISTS (
      SELECT 1 FROM "public"."actors"
       WHERE id = NEW.actor_id AND kind = 'user'
    ) INTO new_is_human;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF old_is_human THEN
      UPDATE "public"."rooms"
         SET namespace_access_revision = namespace_access_revision + 1
       WHERE id = OLD.room_id;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF new_is_human THEN
      UPDATE "public"."rooms"
         SET namespace_access_revision = namespace_access_revision + 1
       WHERE id = NEW.room_id;
    END IF;
  ELSIF NEW.room_id IS DISTINCT FROM OLD.room_id THEN
    UPDATE "public"."rooms"
       SET namespace_access_revision = namespace_access_revision + 1
     WHERE (old_is_human AND id = OLD.room_id)
        OR (new_is_human AND id = NEW.room_id);
  ELSIF NEW.actor_id IS DISTINCT FROM OLD.actor_id
      AND (old_is_human OR new_is_human) THEN
    UPDATE "public"."rooms"
       SET namespace_access_revision = namespace_access_revision + 1
     WHERE id = NEW.room_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."advance_room_namespace_access_revision"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."advance_room_namespace_access_revision"()
  TO "nautilo";
--> statement-breakpoint
-- M298_RUNTIME_FOREGROUND_RESUME_AUTHORITY
CREATE OR REPLACE FUNCTION "public"."validate_conversation_shared_agent_shadow_execution"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM 1
    FROM "public"."sessions" AS session_row
    JOIN "public"."rooms" AS source_room ON source_room.id = NEW.room_id
    JOIN "public"."rooms" AS authority_room
      ON authority_room.id = COALESCE(source_room.parent_room_id, source_room.id)
    JOIN "public"."room_members" AS member ON member.room_id = authority_room.id
    JOIN "public"."actors" AS agent_actor
      ON agent_actor.id = member.actor_id
     AND agent_actor.kind = 'agent'
     AND agent_actor.agent_id = NEW.agent_id
   WHERE session_row.id = NEW.session_id
     AND session_row.room_id = NEW.room_id
     AND session_row.agent_id = NEW.agent_id
     AND ((source_room.parent_room_id IS NULL
            AND source_room.kind IN ('private', 'group'))
       OR (source_room.parent_room_id IS NOT NULL
            AND source_room.kind = 'subthread'
            AND authority_room.kind IN ('private', 'group')))
   FOR SHARE OF session_row, source_room, authority_room, member, agent_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared-Agent execution Session/Room/Agent mismatch'
      USING ERRCODE = '23503';
  END IF;
  IF NEW.invocation_id IS NOT NULL THEN
    PERFORM 1
      FROM "public"."conversation_shared_agent_shadow_invocations" AS invocation
     WHERE invocation.invocation_id = NEW.invocation_id
       AND invocation.room_id = NEW.room_id
       AND invocation.invoking_human_id = NEW.invoking_human_id
       AND invocation.invoking_device_id = NEW.invoking_device_id
       AND invocation.authorization_device_id = NEW.authorization_device_id
       AND invocation.client_action_session_id = NEW.client_action_session_id
       AND invocation.policy_revision = NEW.policy_revision
       AND invocation.input_count = NEW.input_count
       AND invocation.input_set_digest = NEW.input_set_digest
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shared-Agent execution Runtime invocation mismatch'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_shared_agent_shadow_invocation"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.sequence, NEW.invocation_id, NEW.policy_revision, NEW.session_id,
    NEW.room_id, NEW.invoking_human_id, NEW.invoking_device_id,
    NEW.authorization_device_id, NEW.client_action_session_id, NEW.input_count,
    NEW.input_set_digest, NEW.deadline_at, NEW.created_at)
  IS DISTINCT FROM
  ROW(OLD.sequence, OLD.invocation_id, OLD.policy_revision, OLD.session_id,
    OLD.room_id, OLD.invoking_human_id, OLD.invoking_device_id,
    OLD.authorization_device_id, OLD.client_action_session_id, OLD.input_count,
    OLD.input_set_digest, OLD.deadline_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.state = OLD.state
    OR (OLD.state = 'awaiting_authorization' AND NEW.state IN ('authorized', 'fallback', 'failed'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('running', 'completed', 'fallback', 'failed'))
    OR (OLD.state = 'running' AND NEW.state IN ('completed', 'fallback', 'failed'))) THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.authorization_plan_bytes IS NOT NULL AND NEW.authorization_plan_bytes IS DISTINCT FROM OLD.authorization_plan_bytes)
    OR (OLD.authorization_plan_digest IS NOT NULL AND NEW.authorization_plan_digest IS DISTINCT FROM OLD.authorization_plan_digest)
    OR (OLD.recipient_key_id IS NOT NULL AND NEW.recipient_key_id IS DISTINCT FROM OLD.recipient_key_id)
    OR (OLD.authorization_disposition IS NOT NULL AND NEW.authorization_disposition IS DISTINCT FROM OLD.authorization_disposition)
    OR (OLD.authorization_digest IS NOT NULL AND NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest)
    OR (OLD.authorization_session_reference IS NOT NULL AND NEW.authorization_session_reference IS DISTINCT FROM OLD.authorization_session_reference)
    OR (OLD.authorized_at IS NOT NULL AND NEW.authorized_at IS DISTINCT FROM OLD.authorized_at)
    OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
    OR (OLD.terminal_reason IS NOT NULL AND NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason)
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Shared-Agent Runtime invocation receipts are immutable and monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."protect_conversation_shared_agent_shadow_execution"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.sequence, NEW.execution_id, NEW.invocation_id, NEW.policy_revision,
    NEW.session_id, NEW.room_id, NEW.agent_id, NEW.invoking_human_id,
    NEW.invoking_device_id, NEW.authorization_device_id, NEW.execution_kind,
    NEW.client_action_session_id, NEW.input_count, NEW.input_set_digest,
    NEW.deadline_at, NEW.created_at)
  IS DISTINCT FROM
  ROW(OLD.sequence, OLD.execution_id, OLD.invocation_id, OLD.policy_revision,
    OLD.session_id, OLD.room_id, OLD.agent_id, OLD.invoking_human_id,
    OLD.invoking_device_id, OLD.authorization_device_id, OLD.execution_kind,
    OLD.client_action_session_id, OLD.input_count, OLD.input_set_digest,
    OLD.deadline_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Shared-Agent execution identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.state = OLD.state
    OR (OLD.state = 'awaiting_authorization' AND NEW.state IN ('authorized', 'fallback', 'failed'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('running', 'completed', 'fallback', 'failed'))
    OR (OLD.state = 'running' AND NEW.state IN ('completed', 'fallback', 'failed'))) THEN
    RAISE EXCEPTION 'Shared-Agent execution transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.plan_bytes IS NOT NULL AND NEW.plan_bytes IS DISTINCT FROM OLD.plan_bytes)
    OR (OLD.plan_digest IS NOT NULL AND NEW.plan_digest IS DISTINCT FROM OLD.plan_digest)
    OR (OLD.authorization_plan_bytes IS NOT NULL AND NEW.authorization_plan_bytes IS DISTINCT FROM OLD.authorization_plan_bytes)
    OR (OLD.authorization_plan_digest IS NOT NULL AND NEW.authorization_plan_digest IS DISTINCT FROM OLD.authorization_plan_digest)
    OR (OLD.recipient_key_id IS NOT NULL AND NEW.recipient_key_id IS DISTINCT FROM OLD.recipient_key_id)
    OR (OLD.agent_runtime_generation IS NOT NULL AND NEW.agent_runtime_generation IS DISTINCT FROM OLD.agent_runtime_generation)
    OR (OLD.agent_signer_key_id IS NOT NULL AND NEW.agent_signer_key_id IS DISTINCT FROM OLD.agent_signer_key_id)
    OR (OLD.agent_signer_public_key IS NOT NULL AND NEW.agent_signer_public_key IS DISTINCT FROM OLD.agent_signer_public_key)
    OR (OLD.authorization_disposition IS NOT NULL AND NEW.authorization_disposition IS DISTINCT FROM OLD.authorization_disposition)
    OR (OLD.authorization_digest IS NOT NULL AND NEW.authorization_digest IS DISTINCT FROM OLD.authorization_digest)
    OR (OLD.authorization_session_reference IS NOT NULL AND NEW.authorization_session_reference IS DISTINCT FROM OLD.authorization_session_reference)
    OR (OLD.authorized_at IS NOT NULL AND NEW.authorized_at IS DISTINCT FROM OLD.authorized_at)
    OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
    OR (OLD.terminal_reason IS NOT NULL AND NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason)
    OR (OLD.final_causal_event_digest IS NOT NULL AND NEW.final_causal_event_digest IS DISTINCT FROM OLD.final_causal_event_digest)
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Shared-Agent execution receipts are immutable and monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
