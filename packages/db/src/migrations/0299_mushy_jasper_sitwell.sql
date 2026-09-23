CREATE TABLE "task_definition_crypto_revisions" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"content_namespace_id" uuid NOT NULL,
	"content_revision" integer NOT NULL,
	"operation_id" text NOT NULL,
	"request_digest" "bytea" NOT NULL,
	"authority_fingerprint" "bytea" NOT NULL,
	"requester_human_id" uuid NOT NULL,
	"anchor_namespace_id" uuid NOT NULL,
	"crypto_object_id" text NOT NULL,
	"representation" text NOT NULL,
	"payload_version" smallint DEFAULT 1 NOT NULL,
	"crypto_access_revision" integer DEFAULT 0 NOT NULL,
	"required_namespace_fingerprint" "bytea" NOT NULL,
	"operational_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
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
	CONSTRAINT "uq_task_definition_crypto_revisions_coordinate" UNIQUE("task_id","content_revision"),
	CONSTRAINT "uq_task_definition_crypto_revisions_mapping" UNIQUE("task_id","content_namespace_id","content_revision","crypto_object_id","required_namespace_fingerprint"),
	CONSTRAINT "uq_task_definition_crypto_revisions_operation" UNIQUE("operation_id"),
	CONSTRAINT "uq_task_definition_crypto_revisions_object" UNIQUE("crypto_object_id"),
	CONSTRAINT "task_definition_crypto_revisions_revision_positive" CHECK ("task_definition_crypto_revisions"."content_revision" > 0),
	CONSTRAINT "task_definition_crypto_revisions_payload_version" CHECK ("task_definition_crypto_revisions"."payload_version" = 1),
	CONSTRAINT "task_definition_crypto_revisions_access_revision" CHECK ("task_definition_crypto_revisions"."crypto_access_revision" = 0),
	CONSTRAINT "task_definition_crypto_revisions_namespace_authority" CHECK ("task_definition_crypto_revisions"."content_namespace_id" = "task_definition_crypto_revisions"."anchor_namespace_id"),
	CONSTRAINT "task_definition_crypto_revisions_operation_portable" CHECK (octet_length("task_definition_crypto_revisions"."operation_id") between 1 and 128 and "task_definition_crypto_revisions"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "task_definition_crypto_revisions_object_shape" CHECK ("task_definition_crypto_revisions"."crypto_object_id" ~ '^task-definition:v1:[0-9a-f]{64}$'),
	CONSTRAINT "task_definition_crypto_revisions_digest_sizes" CHECK (octet_length("task_definition_crypto_revisions"."request_digest") = 32 and octet_length("task_definition_crypto_revisions"."authority_fingerprint") = 32 and octet_length("task_definition_crypto_revisions"."required_namespace_fingerprint") = 32),
	CONSTRAINT "task_definition_crypto_revisions_retry_coherent" CHECK ("task_definition_crypto_revisions"."attempt_count" between 0 and 8 and ("task_definition_crypto_revisions"."lease_token" is null) = ("task_definition_crypto_revisions"."lease_expires_at" is null)),
	CONSTRAINT "task_definition_crypto_revisions_lifecycle_coherent" CHECK ((
      "task_definition_crypto_revisions"."completion" = 'pending' and "task_definition_crypto_revisions"."crypto_completed_at" is null
      and "task_definition_crypto_revisions"."disposition" in ('active', 'quarantined')
    ) or (
      "task_definition_crypto_revisions"."completion" = 'complete' and "task_definition_crypto_revisions"."crypto_completed_at" is not null
      and "task_definition_crypto_revisions"."disposition" in ('active', 'mapped', 'quarantined', 'stale_mapping')
    )),
	CONSTRAINT "task_definition_crypto_revisions_failure_coherent" CHECK ((
      "task_definition_crypto_revisions"."disposition" in ('active', 'mapped') and "task_definition_crypto_revisions"."failure_code" is null
    ) or (
      "task_definition_crypto_revisions"."disposition" in ('quarantined', 'stale_mapping')
      and "task_definition_crypto_revisions"."failure_code" in (
        'authority_stale', 'crypto_absent', 'crypto_incomplete',
        'crypto_mismatch', 'storage_transient', 'mapping_conflict', 'retry_exhausted'
      )
    ))
);
--> statement-breakpoint
ALTER TABLE "task_definition_crypto_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task_run_result_crypto_revisions" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"task_run_id" uuid NOT NULL,
	"content_namespace_id" uuid NOT NULL,
	"result_revision" integer NOT NULL,
	"operation_id" text NOT NULL,
	"request_digest" "bytea" NOT NULL,
	"authority_fingerprint" "bytea" NOT NULL,
	"requester_human_id" uuid NOT NULL,
	"anchor_namespace_id" uuid NOT NULL,
	"crypto_object_id" text NOT NULL,
	"representation" text NOT NULL,
	"payload_version" smallint DEFAULT 1 NOT NULL,
	"crypto_access_revision" integer DEFAULT 0 NOT NULL,
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
	CONSTRAINT "uq_task_run_result_crypto_revisions_coordinate" UNIQUE("task_run_id","result_revision"),
	CONSTRAINT "uq_task_run_result_crypto_revisions_mapping" UNIQUE("task_id","task_run_id","content_namespace_id","result_revision","crypto_object_id","required_namespace_fingerprint"),
	CONSTRAINT "uq_task_run_result_crypto_revisions_operation" UNIQUE("operation_id"),
	CONSTRAINT "uq_task_run_result_crypto_revisions_object" UNIQUE("crypto_object_id"),
	CONSTRAINT "task_run_result_crypto_revisions_revision_positive" CHECK ("task_run_result_crypto_revisions"."result_revision" > 0),
	CONSTRAINT "task_run_result_crypto_revisions_payload_version" CHECK ("task_run_result_crypto_revisions"."payload_version" = 1),
	CONSTRAINT "task_run_result_crypto_revisions_access_revision" CHECK ("task_run_result_crypto_revisions"."crypto_access_revision" = 0),
	CONSTRAINT "task_run_result_crypto_revisions_namespace_authority" CHECK ("task_run_result_crypto_revisions"."content_namespace_id" = "task_run_result_crypto_revisions"."anchor_namespace_id"),
	CONSTRAINT "task_run_result_crypto_revisions_operation_portable" CHECK (octet_length("task_run_result_crypto_revisions"."operation_id") between 1 and 128 and "task_run_result_crypto_revisions"."operation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
	CONSTRAINT "task_run_result_crypto_revisions_object_shape" CHECK ("task_run_result_crypto_revisions"."crypto_object_id" ~ '^task-run-result:v1:[0-9a-f]{64}$'),
	CONSTRAINT "task_run_result_crypto_revisions_digest_sizes" CHECK (octet_length("task_run_result_crypto_revisions"."request_digest") = 32 and octet_length("task_run_result_crypto_revisions"."authority_fingerprint") = 32 and octet_length("task_run_result_crypto_revisions"."required_namespace_fingerprint") = 32),
	CONSTRAINT "task_run_result_crypto_revisions_retry_coherent" CHECK ("task_run_result_crypto_revisions"."attempt_count" between 0 and 8 and ("task_run_result_crypto_revisions"."lease_token" is null) = ("task_run_result_crypto_revisions"."lease_expires_at" is null)),
	CONSTRAINT "task_run_result_crypto_revisions_lifecycle_coherent" CHECK (("task_run_result_crypto_revisions"."completion" = 'pending' and "task_run_result_crypto_revisions"."crypto_completed_at" is null and "task_run_result_crypto_revisions"."disposition" in ('active', 'quarantined')) or ("task_run_result_crypto_revisions"."completion" = 'complete' and "task_run_result_crypto_revisions"."crypto_completed_at" is not null and "task_run_result_crypto_revisions"."disposition" in ('active', 'mapped', 'quarantined', 'stale_mapping'))),
	CONSTRAINT "task_run_result_crypto_revisions_failure_coherent" CHECK (("task_run_result_crypto_revisions"."disposition" in ('active', 'mapped') and "task_run_result_crypto_revisions"."failure_code" is null) or ("task_run_result_crypto_revisions"."disposition" in ('quarantined', 'stale_mapping') and "task_run_result_crypto_revisions"."failure_code" in ('authority_stale', 'crypto_absent', 'crypto_incomplete', 'crypto_mismatch', 'storage_transient', 'mapping_conflict', 'retry_exhausted')))
);
--> statement-breakpoint
ALTER TABLE "task_run_result_crypto_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "content_representation" text DEFAULT 'ordinary' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "content_namespace_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "content_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "crypto_object_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "crypto_access_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "crypto_required_namespace_fingerprint" "bytea";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "crypto_mapping_state" text DEFAULT 'unmapped' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "result_representation" text DEFAULT 'ordinary' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "result_content_namespace_id" uuid;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "result_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "result_crypto_object_id" text;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "result_crypto_access_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "result_crypto_required_namespace_fingerprint" "bytea";--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "result_crypto_mapping_state" text DEFAULT 'unmapped' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_definition_crypto_revisions" ADD CONSTRAINT "task_definition_crypto_revisions_anchor_namespace_id_namespaces_id_fk" FOREIGN KEY ("anchor_namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run_result_crypto_revisions" ADD CONSTRAINT "task_run_result_crypto_revisions_anchor_namespace_id_namespaces_id_fk" FOREIGN KEY ("anchor_namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_task_definition_crypto_revisions_due" ON "task_definition_crypto_revisions" USING btree ("disposition","next_attempt_at","sequence","completion") WHERE "task_definition_crypto_revisions"."disposition" = 'active';--> statement-breakpoint
CREATE INDEX "idx_task_run_result_crypto_revisions_due" ON "task_run_result_crypto_revisions" USING btree ("disposition","next_attempt_at","sequence","completion") WHERE "task_run_result_crypto_revisions"."disposition" = 'active';--> statement-breakpoint
CREATE INDEX "idx_task_run_result_crypto_revisions_task" ON "task_run_result_crypto_revisions" USING btree ("task_id","task_run_id","result_revision");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_content_namespace_id_namespaces_id_fk" FOREIGN KEY ("content_namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_crypto_object_id_crypto_objects_object_id_fk" FOREIGN KEY ("crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_crypto_revision_fk" FOREIGN KEY ("id","content_namespace_id","content_revision","crypto_object_id","crypto_required_namespace_fingerprint") REFERENCES "public"."task_definition_crypto_revisions"("task_id","content_namespace_id","content_revision","crypto_object_id","required_namespace_fingerprint") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_result_content_namespace_id_namespaces_id_fk" FOREIGN KEY ("result_content_namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_result_crypto_object_id_crypto_objects_object_id_fk" FOREIGN KEY ("result_crypto_object_id") REFERENCES "public"."crypto_objects"("object_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_current_crypto_result_revision_fk" FOREIGN KEY ("task_id","id","result_content_namespace_id","result_revision","result_crypto_object_id","result_crypto_required_namespace_fingerprint") REFERENCES "public"."task_run_result_crypto_revisions"("task_id","task_run_id","content_namespace_id","result_revision","crypto_object_id","required_namespace_fingerprint") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_content_revision_nonnegative" CHECK ("tasks"."content_revision" >= 0);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_crypto_access_revision_nonnegative" CHECK ("tasks"."crypto_access_revision" >= 0);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_crypto_mapping_coherent" CHECK ((
      "tasks"."content_representation" = 'ordinary'
      and "tasks"."content_namespace_id" is null
      and "tasks"."content_revision" = 0
      and "tasks"."crypto_object_id" is null
      and "tasks"."crypto_access_revision" = 0
      and "tasks"."crypto_required_namespace_fingerprint" is null
      and "tasks"."crypto_mapping_state" = 'unmapped'
    ) or (
      "tasks"."content_representation" in ('dual', 'protected')
      and "tasks"."content_namespace_id" is not null
      and "tasks"."content_revision" > 0
      and "tasks"."crypto_object_id" is not null
      and "tasks"."crypto_access_revision" >= 0
      and octet_length("tasks"."crypto_required_namespace_fingerprint") = 32
      and "tasks"."crypto_mapping_state" in ('verified', 'stale')
      and ("tasks"."content_representation" <> 'protected' or (
        "tasks"."prompt" = ''
        and "tasks"."expected_output" is null
        and "tasks"."last_error" is null
      ))
    ));--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_result_revision_nonnegative" CHECK ("task_runs"."result_revision" >= 0);--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_result_crypto_access_revision_nonnegative" CHECK ("task_runs"."result_crypto_access_revision" >= 0);--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_result_crypto_mapping_coherent" CHECK ((
      "task_runs"."result_representation" = 'ordinary'
      and "task_runs"."result_content_namespace_id" is null
      and "task_runs"."result_revision" = 0
      and "task_runs"."result_crypto_object_id" is null
      and "task_runs"."result_crypto_access_revision" = 0
      and "task_runs"."result_crypto_required_namespace_fingerprint" is null
      and "task_runs"."result_crypto_mapping_state" = 'unmapped'
    ) or (
      "task_runs"."result_representation" in ('dual', 'protected')
      and "task_runs"."result_content_namespace_id" is not null
      and "task_runs"."result_revision" > 0
      and "task_runs"."result_crypto_object_id" is not null
      and "task_runs"."result_crypto_access_revision" >= 0
      and octet_length("task_runs"."result_crypto_required_namespace_fingerprint") = 32
      and "task_runs"."result_crypto_mapping_state" in ('verified', 'stale')
      and ("task_runs"."result_representation" <> 'protected' or ("task_runs"."result_text" is null and "task_runs"."last_error" is null))
    ));--> statement-breakpoint
CREATE POLICY "task_definition_crypto_revisions_product_all" ON "task_definition_crypto_revisions" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "task_run_result_crypto_revisions_product_all" ON "task_run_result_crypto_revisions" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- TASK_CRYPTO_LIFECYCLE_AUTHORITY
CREATE FUNCTION "public"."reject_task_definition_crypto_revision_identity_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(
    NEW.sequence,
    NEW.task_id,
    NEW.content_revision,
    NEW.content_namespace_id,
    NEW.operation_id,
    NEW.request_digest,
    NEW.authority_fingerprint,
    NEW.requester_human_id,
    NEW.anchor_namespace_id,
    NEW.crypto_object_id,
    NEW.representation,
    NEW.payload_version,
    NEW.crypto_access_revision,
    NEW.required_namespace_fingerprint,
    NEW.created_at,
    NEW.operational_metadata
  ) IS DISTINCT FROM ROW(
    OLD.sequence,
    OLD.task_id,
    OLD.content_revision,
    OLD.content_namespace_id,
    OLD.operation_id,
    OLD.request_digest,
    OLD.authority_fingerprint,
    OLD.requester_human_id,
    OLD.anchor_namespace_id,
    OLD.crypto_object_id,
    OLD.representation,
    OLD.payload_version,
    OLD.crypto_access_revision,
    OLD.required_namespace_fingerprint,
    OLD.created_at,
    OLD.operational_metadata
  ) THEN
    RAISE EXCEPTION 'protected Task crypto revision identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_task_definition_crypto_revision_identity_update"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reject_task_definition_crypto_revision_identity_update"() TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "task_definition_crypto_revisions_identity_immutable" BEFORE UPDATE ON "task_definition_crypto_revisions" FOR EACH ROW
EXECUTE FUNCTION "public"."reject_task_definition_crypto_revision_identity_update"();--> statement-breakpoint
CREATE FUNCTION "public"."reject_task_run_result_crypto_revision_identity_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(
    NEW.sequence,
    NEW.task_id,
    NEW.task_run_id,
    NEW.result_revision,
    NEW.content_namespace_id,
    NEW.operation_id,
    NEW.request_digest,
    NEW.authority_fingerprint,
    NEW.requester_human_id,
    NEW.anchor_namespace_id,
    NEW.crypto_object_id,
    NEW.representation,
    NEW.payload_version,
    NEW.crypto_access_revision,
    NEW.required_namespace_fingerprint,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sequence,
    OLD.task_id,
    OLD.task_run_id,
    OLD.result_revision,
    OLD.content_namespace_id,
    OLD.operation_id,
    OLD.request_digest,
    OLD.authority_fingerprint,
    OLD.requester_human_id,
    OLD.anchor_namespace_id,
    OLD.crypto_object_id,
    OLD.representation,
    OLD.payload_version,
    OLD.crypto_access_revision,
    OLD.required_namespace_fingerprint,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'protected Task crypto revision identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_task_run_result_crypto_revision_identity_update"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reject_task_run_result_crypto_revision_identity_update"() TO "nautilo";--> statement-breakpoint
CREATE TRIGGER "task_run_result_crypto_revisions_identity_immutable" BEFORE UPDATE ON "task_run_result_crypto_revisions" FOR EACH ROW
EXECUTE FUNCTION "public"."reject_task_run_result_crypto_revision_identity_update"();--> statement-breakpoint
CREATE FUNCTION "public"."guard_task_content_namespace_stability"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.content_namespace_id IS NOT NULL AND NEW.content_namespace_id IS DISTINCT FROM OLD.content_namespace_id THEN
    RAISE EXCEPTION 'Task content Namespace is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."guard_task_content_namespace_stability"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "tasks_content_namespace_stable" BEFORE UPDATE ON "tasks" FOR EACH ROW
EXECUTE FUNCTION "public"."guard_task_content_namespace_stability"();--> statement-breakpoint
CREATE FUNCTION "public"."guard_task_run_result_namespace_stability"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.result_content_namespace_id IS NOT NULL AND NEW.result_content_namespace_id IS DISTINCT FROM OLD.result_content_namespace_id THEN
    RAISE EXCEPTION 'TaskRun result content Namespace is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."guard_task_run_result_namespace_stability"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "task_runs_result_content_namespace_stable" BEFORE UPDATE ON "task_runs" FOR EACH ROW
EXECUTE FUNCTION "public"."guard_task_run_result_namespace_stability"();--> statement-breakpoint
ALTER TABLE "task_definition_crypto_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_run_result_crypto_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "task_definition_crypto_revisions", "task_run_result_crypto_revisions" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "task_definition_crypto_revisions", "task_run_result_crypto_revisions" TO "nautilo";--> statement-breakpoint
GRANT UPDATE ("completion", "disposition", "attempt_count", "next_attempt_at", "lease_token", "lease_expires_at", "failure_code", "crypto_completed_at", "updated_at") ON TABLE "task_definition_crypto_revisions" TO "nautilo";--> statement-breakpoint
GRANT UPDATE ("completion", "disposition", "attempt_count", "next_attempt_at", "lease_token", "lease_expires_at", "failure_code", "crypto_completed_at", "updated_at") ON TABLE "task_run_result_crypto_revisions" TO "nautilo";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE "task_definition_crypto_revisions_sequence_seq", "task_run_result_crypto_revisions_sequence_seq" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "task_definition_crypto_revisions_sequence_seq", "task_run_result_crypto_revisions_sequence_seq" TO "nautilo";
