CREATE TABLE "agent_photo_selection_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"before_avatar_ref" jsonb,
	"after_avatar_ref" jsonb,
	"before_entry_id" uuid,
	"after_entry_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_photo_selection_revisions_revision_positive" CHECK ("agent_photo_selection_revisions"."revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "agent_photo_selection_revisions_origin_check" CHECK ("agent_photo_selection_revisions"."origin" IN ('workbench', 'mobile', 'desktop_wizard', 'manage_avatar', 'bundle_import')),
	CONSTRAINT "agent_photo_selection_revisions_before_ref_check" CHECK ((
    "agent_photo_selection_revisions"."before_avatar_ref" IS NULL
    OR (
      jsonb_typeof("agent_photo_selection_revisions"."before_avatar_ref") = 'object'
      AND (
        (
          "agent_photo_selection_revisions"."before_avatar_ref"->>'kind' = 'preset'
          AND jsonb_typeof("agent_photo_selection_revisions"."before_avatar_ref"->'id') = 'string'
          AND length(trim("agent_photo_selection_revisions"."before_avatar_ref"->>'id')) > 0
          AND "agent_photo_selection_revisions"."before_avatar_ref" - ARRAY['kind', 'id'] = '{}'::jsonb
        )
        OR (
          "agent_photo_selection_revisions"."before_avatar_ref"->>'kind' IN ('generated', 'uploaded')
          AND jsonb_typeof("agent_photo_selection_revisions"."before_avatar_ref"->'blobId') = 'string'
          AND "agent_photo_selection_revisions"."before_avatar_ref"->>'blobId' ~ '^[A-Za-z0-9._-]+$'
          AND "agent_photo_selection_revisions"."before_avatar_ref" - ARRAY['kind', 'blobId'] = '{}'::jsonb
        )
      )
    )
  )),
	CONSTRAINT "agent_photo_selection_revisions_after_ref_check" CHECK ((
    "agent_photo_selection_revisions"."after_avatar_ref" IS NULL
    OR (
      jsonb_typeof("agent_photo_selection_revisions"."after_avatar_ref") = 'object'
      AND (
        (
          "agent_photo_selection_revisions"."after_avatar_ref"->>'kind' = 'preset'
          AND jsonb_typeof("agent_photo_selection_revisions"."after_avatar_ref"->'id') = 'string'
          AND length(trim("agent_photo_selection_revisions"."after_avatar_ref"->>'id')) > 0
          AND "agent_photo_selection_revisions"."after_avatar_ref" - ARRAY['kind', 'id'] = '{}'::jsonb
        )
        OR (
          "agent_photo_selection_revisions"."after_avatar_ref"->>'kind' IN ('generated', 'uploaded')
          AND jsonb_typeof("agent_photo_selection_revisions"."after_avatar_ref"->'blobId') = 'string'
          AND "agent_photo_selection_revisions"."after_avatar_ref"->>'blobId' ~ '^[A-Za-z0-9._-]+$'
          AND "agent_photo_selection_revisions"."after_avatar_ref" - ARRAY['kind', 'blobId'] = '{}'::jsonb
        )
      )
    )
  ))
);
--> statement-breakpoint
CREATE TABLE "owned_photo_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"agent_id" uuid,
	"avatar_kind" text NOT NULL,
	"blob_id" text NOT NULL,
	"source" text NOT NULL,
	"origin" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"generation_prompt" text,
	"generation_provider" text,
	"generation_model" text,
	"generation_batch_ordinal" bigint,
	"media_mime_type" text NOT NULL,
	"media_byte_size" bigint NOT NULL,
	"media_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"gc_claim_token" uuid,
	"gc_claimed_at" timestamp with time zone,
	CONSTRAINT "owned_photo_entries_subject_check" CHECK ("owned_photo_entries"."subject_kind" IN ('agent', 'human')),
	CONSTRAINT "owned_photo_entries_subject_agent_check" CHECK ((
        ("owned_photo_entries"."subject_kind" = 'agent' AND "owned_photo_entries"."agent_id" IS NOT NULL)
        OR ("owned_photo_entries"."subject_kind" = 'human' AND "owned_photo_entries"."agent_id" IS NULL)
      )),
	CONSTRAINT "owned_photo_entries_avatar_kind_check" CHECK ("owned_photo_entries"."avatar_kind" IN ('generated', 'uploaded')),
	CONSTRAINT "owned_photo_entries_blob_id_check" CHECK (length("owned_photo_entries"."blob_id") BETWEEN 1 AND 256 AND "owned_photo_entries"."blob_id" ~ '^[A-Za-z0-9._-]+$'),
	CONSTRAINT "owned_photo_entries_source_check" CHECK ("owned_photo_entries"."source" IN ('upload', 'generation', 'bundle_import', 'legacy_backfill', 'operator_adoption')),
	CONSTRAINT "owned_photo_entries_origin_check" CHECK ("owned_photo_entries"."origin" IN ('workbench', 'mobile', 'desktop_wizard', 'manage_avatar', 'bundle_import', 'legacy_backfill', 'operator_adoption')),
	CONSTRAINT "owned_photo_entries_maintenance_origin_check" CHECK ((
        ("owned_photo_entries"."source" IN ('bundle_import', 'legacy_backfill', 'operator_adoption')
          AND "owned_photo_entries"."origin" = "owned_photo_entries"."source")
        OR ("owned_photo_entries"."source" NOT IN ('bundle_import', 'legacy_backfill', 'operator_adoption')
          AND "owned_photo_entries"."origin" IN ('workbench', 'mobile', 'desktop_wizard', 'manage_avatar'))
      )),
	CONSTRAINT "owned_photo_entries_request_fingerprint_check" CHECK ("owned_photo_entries"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "owned_photo_entries_generation_provenance_check" CHECK ((
        ("owned_photo_entries"."generation_prompt" IS NULL OR length("owned_photo_entries"."generation_prompt") <= 500)
        AND ("owned_photo_entries"."generation_provider" IS NULL OR length(trim("owned_photo_entries"."generation_provider")) BETWEEN 1 AND 100)
        AND ("owned_photo_entries"."generation_model" IS NULL OR length(trim("owned_photo_entries"."generation_model")) BETWEEN 1 AND 200)
        AND ("owned_photo_entries"."generation_batch_ordinal" IS NULL OR "owned_photo_entries"."generation_batch_ordinal" >= 0)
        AND (
          "owned_photo_entries"."source" <> 'generation'
          OR (
            "owned_photo_entries"."generation_provider" IS NOT NULL
            AND "owned_photo_entries"."generation_model" IS NOT NULL
          )
        )
      )),
	CONSTRAINT "owned_photo_entries_media_provenance_check" CHECK ((
        length(trim("owned_photo_entries"."media_mime_type")) BETWEEN 1 AND 255
        AND "owned_photo_entries"."media_byte_size" > 0
        AND "owned_photo_entries"."media_sha256" ~ '^[0-9a-f]{64}$'
      )),
	CONSTRAINT "owned_photo_entries_delete_lifecycle_check" CHECK ((
        ("owned_photo_entries"."deleted_at" IS NULL AND "owned_photo_entries"."purge_after" IS NULL)
        OR ("owned_photo_entries"."deleted_at" IS NOT NULL AND "owned_photo_entries"."purge_after" IS NOT NULL AND "owned_photo_entries"."purge_after" >= "owned_photo_entries"."deleted_at")
      )),
	CONSTRAINT "owned_photo_entries_gc_claim_lifecycle_check" CHECK ((
        ("owned_photo_entries"."gc_claim_token" IS NULL AND "owned_photo_entries"."gc_claimed_at" IS NULL)
        OR (
          "owned_photo_entries"."gc_claim_token" IS NOT NULL
          AND "owned_photo_entries"."gc_claimed_at" IS NOT NULL
          AND "owned_photo_entries"."deleted_at" IS NOT NULL
          AND "owned_photo_entries"."purge_after" IS NOT NULL
        )
      ))
);
--> statement-breakpoint
CREATE TABLE "photo_library_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"viewer_user_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"operation_kind" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL,
	CONSTRAINT "photo_library_operations_kind_check" CHECK ("photo_library_operations"."operation_kind" IN ('create', 'select', 'undo', 'delete', 'restore')),
	CONSTRAINT "photo_library_operations_fingerprint_check" CHECK ("photo_library_operations"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "photo_library_operations_state_check" CHECK ("photo_library_operations"."state" IN ('pending', 'completed', 'failed')),
	CONSTRAINT "photo_library_operations_result_lifecycle_check" CHECK ((
        ("photo_library_operations"."state" = 'pending' AND "photo_library_operations"."result" IS NULL AND "photo_library_operations"."completed_at" IS NULL)
        OR ("photo_library_operations"."state" IN ('completed', 'failed') AND "photo_library_operations"."result" IS NOT NULL AND "photo_library_operations"."completed_at" IS NOT NULL)
      )),
	CONSTRAINT "photo_library_operations_result_size_check" CHECK ("photo_library_operations"."result" IS NULL OR pg_column_size("photo_library_operations"."result") <= 65536),
	CONSTRAINT "photo_library_operations_expiry_check" CHECK ("photo_library_operations"."expires_at" = "photo_library_operations"."created_at" + interval '90 days')
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "avatar_selection_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "avatar_library_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_photo_selection_revisions" ADD CONSTRAINT "agent_photo_selection_revisions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_photo_selection_revisions" ADD CONSTRAINT "agent_photo_selection_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_photo_selection_revisions" ADD CONSTRAINT "agent_photo_selection_revisions_before_entry_id_owned_photo_entries_id_fk" FOREIGN KEY ("before_entry_id") REFERENCES "public"."owned_photo_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_photo_selection_revisions" ADD CONSTRAINT "agent_photo_selection_revisions_after_entry_id_owned_photo_entries_id_fk" FOREIGN KEY ("after_entry_id") REFERENCES "public"."owned_photo_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_photo_selection_revisions" ADD CONSTRAINT "agent_photo_selection_revisions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_photo_entries" ADD CONSTRAINT "owned_photo_entries_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_photo_entries" ADD CONSTRAINT "owned_photo_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_library_operations" ADD CONSTRAINT "photo_library_operations_viewer_user_id_users_id_fk" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_library_operations" ADD CONSTRAINT "photo_library_operations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_library_operations" ADD CONSTRAINT "photo_library_operations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_photo_selection_revisions_agent_revision" ON "agent_photo_selection_revisions" USING btree ("agent_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_photo_selection_revisions_scoped_operation" ON "agent_photo_selection_revisions" USING btree ("server_instance_id","owner_user_id","agent_id","operation_id");--> statement-breakpoint
CREATE INDEX "idx_agent_photo_selection_revisions_agent_recent" ON "agent_photo_selection_revisions" USING btree ("server_instance_id","owner_user_id","agent_id","revision" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_agent_photo_selection_revisions_before_entry" ON "agent_photo_selection_revisions" USING btree ("before_entry_id");--> statement-breakpoint
CREATE INDEX "idx_agent_photo_selection_revisions_after_entry" ON "agent_photo_selection_revisions" USING btree ("after_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_owned_photo_entries_server_blob" ON "owned_photo_entries" USING btree ("server_instance_id","avatar_kind","blob_id");--> statement-breakpoint
CREATE INDEX "idx_owned_photo_entries_agent_recent" ON "owned_photo_entries" USING btree ("server_instance_id","owner_user_id","agent_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "owned_photo_entries"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_owned_photo_entries_agent_deleted" ON "owned_photo_entries" USING btree ("server_instance_id","owner_user_id","agent_id","deleted_at","purge_after") WHERE "owned_photo_entries"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_owned_photo_entries_gc_claimable" ON "owned_photo_entries" USING btree ("purge_after","id") WHERE "owned_photo_entries"."deleted_at" IS NOT NULL AND "owned_photo_entries"."gc_claimed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_photo_library_operations_scoped_operation" ON "photo_library_operations" USING btree ("server_instance_id","viewer_user_id","owner_user_id","agent_id","operation_kind","operation_id");--> statement-breakpoint
CREATE INDEX "idx_photo_library_operations_agent_created" ON "photo_library_operations" USING btree ("server_instance_id","owner_user_id","agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_photo_library_operations_expiry" ON "photo_library_operations" USING btree ("expires_at","id");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_avatar_photo_revisions_nonnegative" CHECK ("profiles"."avatar_selection_revision" BETWEEN 0 AND 9007199254740991
        AND "profiles"."avatar_library_revision" BETWEEN 0 AND 9007199254740991);--> statement-breakpoint
CREATE FUNCTION "public"."reject_profile_avatar_photo_revision_decrease"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.avatar_selection_revision < OLD.avatar_selection_revision OR NEW.avatar_library_revision < OLD.avatar_library_revision THEN RAISE EXCEPTION 'profile avatar photo revisions are monotonic' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_profile_avatar_photo_revision_decrease"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "profiles_avatar_photo_revision_monotonic" BEFORE UPDATE OF "avatar_selection_revision", "avatar_library_revision" ON "profiles" FOR EACH ROW EXECUTE FUNCTION "public"."reject_profile_avatar_photo_revision_decrease"();--> statement-breakpoint
CREATE FUNCTION "public"."reject_owned_photo_entry_identity_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.id, NEW.server_instance_id, NEW.owner_user_id, NEW.subject_kind, NEW.agent_id, NEW.avatar_kind, NEW.blob_id, NEW.source, NEW.origin, NEW.operation_id, NEW.request_fingerprint, NEW.generation_prompt, NEW.generation_provider, NEW.generation_model, NEW.generation_batch_ordinal, NEW.media_mime_type, NEW.media_byte_size, NEW.media_sha256, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.server_instance_id, OLD.owner_user_id, OLD.subject_kind, OLD.agent_id, OLD.avatar_kind, OLD.blob_id, OLD.source, OLD.origin, OLD.operation_id, OLD.request_fingerprint, OLD.generation_prompt, OLD.generation_provider, OLD.generation_model, OLD.generation_batch_ordinal, OLD.media_mime_type, OLD.media_byte_size, OLD.media_sha256, OLD.created_at) THEN RAISE EXCEPTION 'owned photo entry identity is immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_owned_photo_entry_identity_update"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "owned_photo_entries_identity_immutable" BEFORE UPDATE ON "owned_photo_entries" FOR EACH ROW EXECUTE FUNCTION "public"."reject_owned_photo_entry_identity_update"();--> statement-breakpoint
-- History rows are immutable but retention may delete them later.
CREATE FUNCTION "public"."reject_agent_photo_selection_revision_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'agent photo selection revisions are append-only' USING ERRCODE = '23514'; END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_agent_photo_selection_revision_update"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "agent_photo_selection_revisions_append_only_update" BEFORE UPDATE ON "agent_photo_selection_revisions" FOR EACH ROW EXECUTE FUNCTION "public"."reject_agent_photo_selection_revision_update"();--> statement-breakpoint
CREATE FUNCTION "public"."reject_photo_library_operation_identity_update"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.state IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'completed photo library operation is immutable' USING ERRCODE = '23514'; END IF;
  IF ROW(NEW.id, NEW.server_instance_id, NEW.viewer_user_id, NEW.owner_user_id, NEW.agent_id, NEW.operation_id, NEW.operation_kind, NEW.request_fingerprint, NEW.created_at, NEW.expires_at) IS DISTINCT FROM ROW(OLD.id, OLD.server_instance_id, OLD.viewer_user_id, OLD.owner_user_id, OLD.agent_id, OLD.operation_id, OLD.operation_kind, OLD.request_fingerprint, OLD.created_at, OLD.expires_at) THEN RAISE EXCEPTION 'photo library operation identity is immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_photo_library_operation_identity_update"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "photo_library_operations_identity_immutable" BEFORE UPDATE ON "photo_library_operations" FOR EACH ROW EXECUTE FUNCTION "public"."reject_photo_library_operation_identity_update"();
