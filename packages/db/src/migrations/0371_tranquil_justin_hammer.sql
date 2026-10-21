CREATE TABLE "task_content_backfill_failures" (
	"kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"task_run_id" uuid,
	"source_revision" integer NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"source_status" text NOT NULL,
	"source_completed_at" timestamp with time zone,
	"policy_revision" integer NOT NULL,
	"reason" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_content_backfill_failures_kind_entity_id_pk" PRIMARY KEY("kind","entity_id"),
	CONSTRAINT "task_content_backfill_failures_coordinate" CHECK ((
    "task_content_backfill_failures"."kind" = 'definition' and "task_content_backfill_failures"."entity_id" = "task_content_backfill_failures"."task_id" and "task_content_backfill_failures"."task_run_id" is null
  ) or (
    "task_content_backfill_failures"."kind" = 'result' and "task_content_backfill_failures"."entity_id" = "task_content_backfill_failures"."task_run_id" and "task_content_backfill_failures"."task_run_id" is not null
  )),
	CONSTRAINT "task_content_backfill_failures_revision" CHECK ("task_content_backfill_failures"."source_revision" >= 0 and "task_content_backfill_failures"."policy_revision" > 0),
	CONSTRAINT "task_content_backfill_failures_reason" CHECK ("task_content_backfill_failures"."reason" in ('unsupported', 'no_content', 'integrity', 'waiting_parent'))
);
--> statement-breakpoint
ALTER TABLE "task_content_backfill_failures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task_content_backfill_scans" (
	"human_actor_id" uuid PRIMARY KEY NOT NULL,
	"phase" text DEFAULT 'definition' NOT NULL,
	"cursor_at" timestamp with time zone,
	"cursor_task_id" uuid,
	"cursor_task_run_id" uuid,
	"through_at" timestamp with time zone,
	"through_task_id" uuid,
	"through_task_run_id" uuid,
	"sweep_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sweep_at" timestamp with time zone,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resume_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_device_id" text,
	"lease_expires_at" timestamp with time zone,
	"claim" jsonb,
	CONSTRAINT "task_content_backfill_scans_phase" CHECK ("task_content_backfill_scans"."phase" in ('definition', 'result')),
	CONSTRAINT "task_content_backfill_scans_cursor" CHECK ((
    ("task_content_backfill_scans"."cursor_at" is null and "task_content_backfill_scans"."cursor_task_id" is null and "task_content_backfill_scans"."cursor_task_run_id" is null)
    or ("task_content_backfill_scans"."phase" = 'definition' and "task_content_backfill_scans"."cursor_at" is not null
      and "task_content_backfill_scans"."cursor_task_id" is not null and "task_content_backfill_scans"."cursor_task_run_id" is null)
    or ("task_content_backfill_scans"."phase" = 'result' and "task_content_backfill_scans"."cursor_at" is not null
      and "task_content_backfill_scans"."cursor_task_id" is not null and "task_content_backfill_scans"."cursor_task_run_id" is not null)
  )),
	CONSTRAINT "task_content_backfill_scans_through" CHECK ((
    ("task_content_backfill_scans"."through_at" is null and "task_content_backfill_scans"."through_task_id" is null and "task_content_backfill_scans"."through_task_run_id" is null)
    or ("task_content_backfill_scans"."phase" = 'definition' and "task_content_backfill_scans"."through_at" is not null
      and "task_content_backfill_scans"."through_task_id" is not null and "task_content_backfill_scans"."through_task_run_id" is null)
    or ("task_content_backfill_scans"."phase" = 'result' and "task_content_backfill_scans"."through_at" is not null
      and "task_content_backfill_scans"."through_task_id" is not null and "task_content_backfill_scans"."through_task_run_id" is not null)
  )),
	CONSTRAINT "task_content_backfill_scans_lease" CHECK (case when "task_content_backfill_scans"."lease_token" is null
    then "task_content_backfill_scans"."lease_device_id" is null and "task_content_backfill_scans"."lease_expires_at" is null and "task_content_backfill_scans"."claim" is null
    else "task_content_backfill_scans"."lease_device_id" is not null and "task_content_backfill_scans"."lease_expires_at" is not null and "task_content_backfill_scans"."claim" is not null end)
);
--> statement-breakpoint
ALTER TABLE "task_content_backfill_scans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_definition_crypto_revisions" ADD COLUMN "historical_repair" jsonb;--> statement-breakpoint
ALTER TABLE "task_run_result_crypto_revisions" ADD COLUMN "historical_repair" jsonb;--> statement-breakpoint
ALTER TABLE "task_content_backfill_scans" ADD CONSTRAINT "task_content_backfill_scans_human_actor_id_actors_id_fk" FOREIGN KEY ("human_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_task_content_backfill_failures_task" ON "task_content_backfill_failures" USING btree ("task_id","task_run_id");--> statement-breakpoint
ALTER TABLE "task_definition_crypto_revisions" ADD CONSTRAINT "task_definition_crypto_revisions_historical_repair" CHECK ("task_definition_crypto_revisions"."historical_repair" is null or ((
      "task_definition_crypto_revisions"."representation" = 'dual' and "task_definition_crypto_revisions"."content_revision" = 1
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair") = 'object'
      and "task_definition_crypto_revisions"."historical_repair" ?& ARRAY['version','claimId','publisherDeviceId','signedRequestDigest','sourceDigest','sourcePayloadHash','sourceRevision']
      and ("task_definition_crypto_revisions"."historical_repair" - ARRAY['version','claimId','publisherDeviceId','signedRequestDigest','sourceDigest','sourcePayloadHash','sourceRevision']) = '{}'::jsonb
      and "task_definition_crypto_revisions"."historical_repair"->'version' = '1'::jsonb
      and "task_definition_crypto_revisions"."historical_repair"->'sourceRevision' = '0'::jsonb
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair"->'claimId') = 'string'
      and "task_definition_crypto_revisions"."historical_repair"->>'claimId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and octet_length("task_definition_crypto_revisions"."historical_repair"->>'publisherDeviceId') between 1 and 128
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair"->'publisherDeviceId') = 'string'
      and "task_definition_crypto_revisions"."historical_repair"->>'publisherDeviceId' ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair"->'signedRequestDigest') = 'string'
      and "task_definition_crypto_revisions"."historical_repair"->>'signedRequestDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair"->'sourceDigest') = 'string'
      and "task_definition_crypto_revisions"."historical_repair"->>'sourceDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof("task_definition_crypto_revisions"."historical_repair"->'sourcePayloadHash') = 'string'
      and "task_definition_crypto_revisions"."historical_repair"->>'sourcePayloadHash' ~ '^[0-9a-f]{64}$'
    ) is true));--> statement-breakpoint
ALTER TABLE "task_run_result_crypto_revisions" ADD CONSTRAINT "task_run_result_crypto_revisions_historical_repair" CHECK ("task_run_result_crypto_revisions"."historical_repair" is null or ((
      "task_run_result_crypto_revisions"."representation" = 'dual' and "task_run_result_crypto_revisions"."result_revision" = 1
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair") = 'object'
      and "task_run_result_crypto_revisions"."historical_repair" ?& ARRAY['version','claimId','publisherDeviceId','signedRequestDigest','sourceDigest','sourcePayloadHash','sourceRevision']
      and ("task_run_result_crypto_revisions"."historical_repair" - ARRAY['version','claimId','publisherDeviceId','signedRequestDigest','sourceDigest','sourcePayloadHash','sourceRevision']) = '{}'::jsonb
      and "task_run_result_crypto_revisions"."historical_repair"->'version' = '1'::jsonb
      and "task_run_result_crypto_revisions"."historical_repair"->'sourceRevision' = '0'::jsonb
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair"->'claimId') = 'string'
      and "task_run_result_crypto_revisions"."historical_repair"->>'claimId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and octet_length("task_run_result_crypto_revisions"."historical_repair"->>'publisherDeviceId') between 1 and 128
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair"->'publisherDeviceId') = 'string'
      and "task_run_result_crypto_revisions"."historical_repair"->>'publisherDeviceId' ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair"->'signedRequestDigest') = 'string'
      and "task_run_result_crypto_revisions"."historical_repair"->>'signedRequestDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair"->'sourceDigest') = 'string'
      and "task_run_result_crypto_revisions"."historical_repair"->>'sourceDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof("task_run_result_crypto_revisions"."historical_repair"->'sourcePayloadHash') = 'string'
      and "task_run_result_crypto_revisions"."historical_repair"->>'sourcePayloadHash' ~ '^[0-9a-f]{64}$'
    ) is true));--> statement-breakpoint
CREATE POLICY "task_content_backfill_failures_product" ON "task_content_backfill_failures" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "task_content_backfill_scans_product" ON "task_content_backfill_scans" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- TASK_HISTORICAL_REPAIR_AUTHORITY
CREATE OR REPLACE FUNCTION "public"."reject_task_definition_crypto_revision_identity_update"()
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
    NEW.historical_repair,
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
    OLD.historical_repair,
    OLD.operational_metadata
  ) THEN
    RAISE EXCEPTION 'protected Task crypto revision identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_task_definition_crypto_revision_identity_update"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reject_task_definition_crypto_revision_identity_update"() TO "nautilo";--> statement-breakpoint

--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."reject_task_run_result_crypto_revision_identity_update"()
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
    NEW.created_at,
    NEW.historical_repair
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
    OLD.created_at,
    OLD.historical_repair
  ) THEN
    RAISE EXCEPTION 'protected Task crypto revision identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_task_run_result_crypto_revision_identity_update"() FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."reject_task_run_result_crypto_revision_identity_update"() TO "nautilo";--> statement-breakpoint

--> statement-breakpoint
ALTER TABLE "task_content_backfill_scans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "task_content_backfill_scans" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "task_content_backfill_scans" TO "nautilo";
--> statement-breakpoint
ALTER TABLE "task_content_backfill_failures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "task_content_backfill_failures" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "task_content_backfill_failures" TO "nautilo";
