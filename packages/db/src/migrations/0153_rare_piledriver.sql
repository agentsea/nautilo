CREATE TABLE "memory_crypto_revisions" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"content_revision" integer NOT NULL,
	"anchor_namespace_id" uuid NOT NULL,
	"crypto_object_id" text NOT NULL,
	"payload_version" smallint DEFAULT 1 NOT NULL,
	"allocation_request_digest" "bytea" NOT NULL,
	"required_namespace_fingerprint" "bytea" NOT NULL,
	"completion" text DEFAULT 'pending' NOT NULL,
	"disposition" text DEFAULT 'active' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"failure_code" text,
	"crypto_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_memory_crypto_revisions_coordinate" UNIQUE("memory_id","content_revision"),
	CONSTRAINT "uq_memory_crypto_revisions_object" UNIQUE("crypto_object_id"),
	CONSTRAINT "memory_crypto_revisions_revision_positive" CHECK ("memory_crypto_revisions"."content_revision" > 0),
	CONSTRAINT "memory_crypto_revisions_payload_version" CHECK ("memory_crypto_revisions"."payload_version" = 1),
	CONSTRAINT "memory_crypto_revisions_allocation_digest_size" CHECK (octet_length("memory_crypto_revisions"."allocation_request_digest") = 32),
	CONSTRAINT "memory_crypto_revisions_namespace_fingerprint_size" CHECK (octet_length("memory_crypto_revisions"."required_namespace_fingerprint") = 32),
	CONSTRAINT "memory_crypto_revisions_completion_check" CHECK ("memory_crypto_revisions"."completion" in ('pending', 'complete')),
	CONSTRAINT "memory_crypto_revisions_disposition_check" CHECK ("memory_crypto_revisions"."disposition" in (
          'active', 'mapped', 'blocked', 'quarantined',
          'superseded', 'hard_delete', 'stale_mapping'
        )),
	CONSTRAINT "memory_crypto_revisions_completion_coherent" CHECK ((
          "memory_crypto_revisions"."completion" = 'pending'
          and "memory_crypto_revisions"."crypto_completed_at" is null
          and "memory_crypto_revisions"."disposition" not in ('mapped', 'stale_mapping')
        ) or (
          "memory_crypto_revisions"."completion" = 'complete'
          and "memory_crypto_revisions"."crypto_completed_at" is not null
        )),
	CONSTRAINT "memory_crypto_revisions_attempt_bound" CHECK ("memory_crypto_revisions"."attempt_count" between 0 and 8),
	CONSTRAINT "memory_crypto_revisions_lease_coherent" CHECK (("memory_crypto_revisions"."lease_token" is null) = ("memory_crypto_revisions"."lease_expires_at" is null)),
	CONSTRAINT "memory_crypto_revisions_object_id_portable" CHECK ("memory_crypto_revisions"."crypto_object_id" is null or (
      octet_length("memory_crypto_revisions"."crypto_object_id") between 1 and 128
      and "memory_crypto_revisions"."crypto_object_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    ))
);
--> statement-breakpoint
ALTER TABLE "memory_crypto_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_crypto_operations" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"memory_id" uuid NOT NULL,
	"anchor_namespace_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"expected_content_revision" integer NOT NULL,
	"result_content_revision" integer,
	"expected_access_revision" integer NOT NULL,
	"result_access_revision" integer,
	"request_digest" "bytea" NOT NULL,
	"target_required_namespace_fingerprint" "bytea",
	"completion" text DEFAULT 'pending' NOT NULL,
	"disposition" text DEFAULT 'active' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"failure_code" text,
	"crypto_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_memory_crypto_operations_id" UNIQUE("operation_id"),
	CONSTRAINT "memory_crypto_operations_id_portable" CHECK (octet_length("memory_crypto_operations"."operation_id") between 1 and 128
          and "memory_crypto_operations"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "memory_crypto_operations_revisions_nonnegative" CHECK ("memory_crypto_operations"."expected_content_revision" >= 0
          and "memory_crypto_operations"."expected_access_revision" >= 0
          and ("memory_crypto_operations"."result_content_revision" is null or "memory_crypto_operations"."result_content_revision" > 0)
          and ("memory_crypto_operations"."result_access_revision" is null or "memory_crypto_operations"."result_access_revision" >= 0)),
	CONSTRAINT "memory_crypto_operations_request_digest_size" CHECK (octet_length("memory_crypto_operations"."request_digest") = 32),
	CONSTRAINT "memory_crypto_operations_shape" CHECK ((
          "memory_crypto_operations"."operation_type" = 'update'
          and "memory_crypto_operations"."result_content_revision" = "memory_crypto_operations"."expected_content_revision" + 1
          and "memory_crypto_operations"."result_access_revision" is null
          and "memory_crypto_operations"."target_required_namespace_fingerprint" is null
        ) or (
          "memory_crypto_operations"."operation_type" = 'access'
          and "memory_crypto_operations"."result_content_revision" is null
          and "memory_crypto_operations"."result_access_revision" = "memory_crypto_operations"."expected_access_revision" + 1
          and octet_length("memory_crypto_operations"."target_required_namespace_fingerprint") = 32
        ) or (
          "memory_crypto_operations"."operation_type" = 'delete'
          and "memory_crypto_operations"."result_content_revision" is null
          and "memory_crypto_operations"."result_access_revision" is null
          and "memory_crypto_operations"."target_required_namespace_fingerprint" is null
        )),
	CONSTRAINT "memory_crypto_operations_completion_coherent" CHECK ((
          "memory_crypto_operations"."completion" = 'pending'
          and "memory_crypto_operations"."crypto_completed_at" is null
          and "memory_crypto_operations"."disposition" in ('active', 'blocked', 'quarantined')
        ) or (
          "memory_crypto_operations"."completion" = 'complete'
          and "memory_crypto_operations"."crypto_completed_at" is not null
          and "memory_crypto_operations"."disposition" = 'complete'
        )),
	CONSTRAINT "memory_crypto_operations_attempt_bound" CHECK ("memory_crypto_operations"."attempt_count" between 0 and 8),
	CONSTRAINT "memory_crypto_operations_lease_coherent" CHECK (("memory_crypto_operations"."lease_token" is null) = ("memory_crypto_operations"."lease_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "crypto_object_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "content_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "crypto_access_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "crypto_required_namespace_fingerprint" "bytea";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_revision" integer;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_provider" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_dimensions" integer;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_contract_version" integer;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "scope_origin_namespace_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_memory_crypto_revisions_due" ON "memory_crypto_revisions" USING btree ("disposition","next_attempt_at","sequence","completion") WHERE "memory_crypto_revisions"."disposition" = 'active';--> statement-breakpoint
CREATE INDEX "idx_memory_crypto_revisions_memory" ON "memory_crypto_revisions" USING btree ("memory_id","content_revision");--> statement-breakpoint
CREATE INDEX "idx_memory_crypto_operations_due" ON "memory_crypto_operations" USING btree ("disposition","next_attempt_at","sequence","completion") WHERE "memory_crypto_operations"."disposition" = 'active';--> statement-breakpoint
CREATE INDEX "idx_memory_crypto_operations_memory" ON "memory_crypto_operations" USING btree ("memory_id","sequence");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_crypto_object_id_crypto_objects_object_id_fk" FOREIGN KEY ("crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_scope_origin_namespace_id_namespaces_id_fk" FOREIGN KEY ("scope_origin_namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "uq_memories_crypto_object_id" UNIQUE("crypto_object_id");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_content_revision_nonnegative" CHECK ("memories"."content_revision" >= 0);--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_crypto_mapping_revision_coherent" CHECK ((
        "memories"."crypto_object_id" is null
        and "memories"."crypto_required_namespace_fingerprint" is null
      ) or (
        "memories"."crypto_object_id" is not null
        and "memories"."content_revision" > 0
        and "memories"."crypto_access_revision" >= 0
        and octet_length("memories"."crypto_required_namespace_fingerprint") = 32
      ));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_crypto_access_revision_nonnegative" CHECK ("memories"."crypto_access_revision" >= 0);--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_embedding_provenance_coherent" CHECK ((
        "memories"."embedding_revision" is null
        and "memories"."embedding_provider" is null
        and "memories"."embedding_model" is null
        and "memories"."embedding_dimensions" is null
        and "memories"."embedding_contract_version" is null
      ) or (
        "memories"."embedding" is not null
        and "memories"."embedding_revision" is not null
        and "memories"."embedding_revision" >= 0
        and "memories"."embedding_revision" <= "memories"."content_revision"
        and "memories"."embedding_provider" in ('openai', 'openrouter')
        and octet_length("memories"."embedding_model") between 1 and 256
        and "memories"."embedding_dimensions" = 1536
        and "memories"."embedding_contract_version" = 1
      ));--> statement-breakpoint
ALTER TABLE "memory_scopes" ADD CONSTRAINT "memory_scopes_origin_check" CHECK ("memory_scopes"."origin" in ('seed', 'scope'));--> statement-breakpoint
CREATE POLICY "memory_crypto_revisions_product_all" ON "memory_crypto_revisions" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "memory_crypto_revisions_agent_select" ON "memory_crypto_revisions" AS PERMISSIVE FOR SELECT TO "nautilo_agent" USING (app_current_user_id() is not null
    and exists (
      select 1
        from public.rooms memory_receipt_room
        join public.actors memory_receipt_actor
          on memory_receipt_actor.id = any(memory_receipt_room.human_actor_ids)
       where memory_receipt_room.namespace_id = "memory_crypto_revisions"."anchor_namespace_id"
         and memory_receipt_actor.owner_id = app_current_user_id()
         and memory_receipt_actor.kind = 'user'
         and app_agent_in_room(memory_receipt_room.id)
    ));--> statement-breakpoint
CREATE POLICY "memory_crypto_revisions_agent_insert" ON "memory_crypto_revisions" AS PERMISSIVE FOR INSERT TO "nautilo_agent" WITH CHECK (app_current_user_id() is not null
    and exists (
      select 1
        from public.rooms memory_receipt_room
        join public.actors memory_receipt_actor
          on memory_receipt_actor.id = any(memory_receipt_room.human_actor_ids)
       where memory_receipt_room.namespace_id = "memory_crypto_revisions"."anchor_namespace_id"
         and memory_receipt_actor.owner_id = app_current_user_id()
         and memory_receipt_actor.kind = 'user'
         and app_agent_in_room(memory_receipt_room.id)
    ));--> statement-breakpoint
CREATE POLICY "memory_crypto_revisions_agent_update" ON "memory_crypto_revisions" AS PERMISSIVE FOR UPDATE TO "nautilo_agent" USING (app_current_user_id() is not null
    and exists (
      select 1
        from public.rooms memory_receipt_room
        join public.actors memory_receipt_actor
          on memory_receipt_actor.id = any(memory_receipt_room.human_actor_ids)
       where memory_receipt_room.namespace_id = "memory_crypto_revisions"."anchor_namespace_id"
         and memory_receipt_actor.owner_id = app_current_user_id()
         and memory_receipt_actor.kind = 'user'
         and app_agent_in_room(memory_receipt_room.id)
    )) WITH CHECK (app_current_user_id() is not null
    and exists (
      select 1
        from public.rooms memory_receipt_room
        join public.actors memory_receipt_actor
          on memory_receipt_actor.id = any(memory_receipt_room.human_actor_ids)
       where memory_receipt_room.namespace_id = "memory_crypto_revisions"."anchor_namespace_id"
         and memory_receipt_actor.owner_id = app_current_user_id()
         and memory_receipt_actor.kind = 'user'
         and app_agent_in_room(memory_receipt_room.id)
    ));--> statement-breakpoint
CREATE POLICY "memory_crypto_operations_product_all" ON "memory_crypto_operations" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "memory_crypto_operations_agent_select" ON "memory_crypto_operations" AS PERMISSIVE FOR SELECT TO "nautilo_agent" USING (app_current_user_id() is not null
    and exists (
      select 1
        from public.rooms memory_operation_room
        join public.actors memory_operation_actor
          on memory_operation_actor.id = any(memory_operation_room.human_actor_ids)
       where memory_operation_room.namespace_id = "memory_crypto_operations"."anchor_namespace_id"
         and memory_operation_actor.owner_id = app_current_user_id()
         and memory_operation_actor.kind = 'user'
         and app_agent_in_room(memory_operation_room.id)
    ));--> statement-breakpoint
CREATE POLICY "memory_crypto_operations_agent_insert" ON "memory_crypto_operations" AS PERMISSIVE FOR INSERT TO "nautilo_agent" WITH CHECK (app_current_user_id() is not null
    and exists (
      select 1
        from public.rooms memory_operation_room
        join public.actors memory_operation_actor
          on memory_operation_actor.id = any(memory_operation_room.human_actor_ids)
       where memory_operation_room.namespace_id = "memory_crypto_operations"."anchor_namespace_id"
         and memory_operation_actor.owner_id = app_current_user_id()
         and memory_operation_actor.kind = 'user'
         and app_agent_in_room(memory_operation_room.id)
    ));--> statement-breakpoint
CREATE POLICY "memory_crypto_operations_agent_update" ON "memory_crypto_operations" AS PERMISSIVE FOR UPDATE TO "nautilo_agent" USING (app_current_user_id() is not null
    and exists (
      select 1
        from public.rooms memory_operation_room
        join public.actors memory_operation_actor
          on memory_operation_actor.id = any(memory_operation_room.human_actor_ids)
       where memory_operation_room.namespace_id = "memory_crypto_operations"."anchor_namespace_id"
         and memory_operation_actor.owner_id = app_current_user_id()
         and memory_operation_actor.kind = 'user'
         and app_agent_in_room(memory_operation_room.id)
    )) WITH CHECK (app_current_user_id() is not null
    and exists (
      select 1
        from public.rooms memory_operation_room
        join public.actors memory_operation_actor
          on memory_operation_actor.id = any(memory_operation_room.human_actor_ids)
       where memory_operation_room.namespace_id = "memory_crypto_operations"."anchor_namespace_id"
         and memory_operation_actor.owner_id = app_current_user_id()
         and memory_operation_actor.kind = 'user'
         and app_agent_in_room(memory_operation_room.id)
    ));
--> statement-breakpoint
-- M243_MEMORY_CRYPTO_LIFECYCLE_AUTHORITY
CREATE FUNCTION "public"."reject_memory_crypto_revision_identity_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.disposition IN ('superseded', 'hard_delete')
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal memory crypto revision is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.sequence,
    NEW.memory_id,
    NEW.content_revision,
    NEW.anchor_namespace_id,
    NEW.crypto_object_id,
    NEW.payload_version,
    NEW.allocation_request_digest,
    NEW.required_namespace_fingerprint,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence,
    OLD.memory_id,
    OLD.content_revision,
    OLD.anchor_namespace_id,
    OLD.crypto_object_id,
    OLD.payload_version,
    OLD.allocation_request_digest,
    OLD.required_namespace_fingerprint,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'memory crypto revision identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_memory_crypto_revision_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "memory_crypto_revisions_identity_immutable"
BEFORE UPDATE ON "memory_crypto_revisions"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_memory_crypto_revision_identity_update"();--> statement-breakpoint
CREATE FUNCTION "public"."reject_memory_crypto_operation_identity_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.disposition = 'complete' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed memory crypto operation is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.sequence,
    NEW.operation_id,
    NEW.memory_id,
    NEW.anchor_namespace_id,
    NEW.operation_type,
    NEW.expected_content_revision,
    NEW.result_content_revision,
    NEW.expected_access_revision,
    NEW.result_access_revision,
    NEW.request_digest,
    NEW.target_required_namespace_fingerprint,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence,
    OLD.operation_id,
    OLD.memory_id,
    OLD.anchor_namespace_id,
    OLD.operation_type,
    OLD.expected_content_revision,
    OLD.result_content_revision,
    OLD.expected_access_revision,
    OLD.result_access_revision,
    OLD.request_digest,
    OLD.target_required_namespace_fingerprint,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'memory crypto operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_memory_crypto_operation_identity_update"()
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "memory_crypto_operations_identity_immutable"
BEFORE UPDATE ON "memory_crypto_operations"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_memory_crypto_operation_identity_update"();--> statement-breakpoint
ALTER TABLE "memory_crypto_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_crypto_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "memory_crypto_revisions", "memory_crypto_operations"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "memory_crypto_revisions", "memory_crypto_operations"
  TO "nautilo_agent";--> statement-breakpoint
GRANT UPDATE (
  "completion",
  "disposition",
  "attempt_count",
  "next_attempt_at",
  "lease_token",
  "lease_expires_at",
  "failure_code",
  "crypto_completed_at",
  "updated_at"
) ON TABLE "memory_crypto_revisions"
  TO "nautilo_agent";--> statement-breakpoint
GRANT UPDATE (
  "completion",
  "disposition",
  "attempt_count",
  "next_attempt_at",
  "lease_token",
  "lease_expires_at",
  "failure_code",
  "crypto_completed_at",
  "updated_at"
) ON TABLE "memory_crypto_operations"
  TO "nautilo_agent";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE
  "memory_crypto_revisions_sequence_seq",
  "memory_crypto_operations_sequence_seq"
  FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE
  "memory_crypto_revisions_sequence_seq",
  "memory_crypto_operations_sequence_seq"
  TO "nautilo_agent";
