-- D525 — canonical durable receipt for Venice video/music work.
-- The approved prompt/lyrics live only inside the protected internal request_payload
-- needed for restart-safe admission. Public projections exclude that payload, provider
-- bodies, API keys, and signed URLs.
CREATE TABLE "media_generations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "receipt_id" text NOT NULL,
  "owner_id" uuid NOT NULL,
  "room_id" uuid NOT NULL,
  "namespace_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "provider" text DEFAULT 'venice' NOT NULL,
  "provider_model" text NOT NULL,
  "provider_account_fingerprint" text NOT NULL,
  "provider_queue_id" text,
  "admission_token" uuid,
  "admission_started_at" timestamp with time zone,
  "approval_digest" text NOT NULL,
  "quote_digest" text NOT NULL,
  "safe_snapshot" jsonb NOT NULL,
  "request_payload" jsonb NOT NULL,
  "quoted_usd_micros" integer NOT NULL,
  "state" text DEFAULT 'prequeue' NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "safe_failure" jsonb,
  "artifact_internal_id" uuid,
  "cleanup_state" text DEFAULT 'pending' NOT NULL,
  "cleanup_completed_at" timestamp with time zone,
  "claim_owner" text,
  "claim_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "accepted_at" timestamp with time zone,
  "ready_at" timestamp with time zone,
  "terminal_at" timestamp with time zone,
  "retain_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "uq_media_generations_receipt_id" UNIQUE("receipt_id"),
  CONSTRAINT "media_generations_receipt_portable" CHECK (octet_length("receipt_id") between 1 and 128 and "receipt_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'),
  CONSTRAINT "media_generations_provider_fixed" CHECK ("provider" = 'venice' and octet_length("provider_model") between 1 and 256 and octet_length("provider_account_fingerprint") between 16 and 128),
  CONSTRAINT "media_generations_kind_check" CHECK ("kind" in ('video', 'music')),
  CONSTRAINT "media_generations_digests" CHECK ("approval_digest" ~ '^[0-9a-f]{64}$' and "quote_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "media_generations_quote_nonnegative" CHECK ("quoted_usd_micros" >= 0),
  CONSTRAINT "media_generations_state_check" CHECK ("state" in ('prequeue', 'admitting', 'queued', 'retrieving', 'saving', 'ready', 'needs_action', 'failed', 'unknown')),
  CONSTRAINT "media_generations_revision_nonnegative" CHECK ("revision" >= 0),
  CONSTRAINT "media_generations_admission_shape" CHECK (("admission_token" is null) = ("admission_started_at" is null)
    and ("provider_queue_id" is null) = ("accepted_at" is null)
    and ("provider_queue_id" is null or "admission_token" is not null)
    and ("state" <> 'prequeue' or ("admission_token" is null and "provider_queue_id" is null))
    and ("state" <> 'admitting' or ("admission_token" is not null and "provider_queue_id" is null))
    and ("state" not in ('queued', 'retrieving', 'saving', 'ready') or ("admission_token" is not null and "provider_queue_id" is not null))
    and ("state" <> 'unknown' or "admission_token" is not null)),
  CONSTRAINT "media_generations_safe_json" CHECK (jsonb_typeof("safe_snapshot") = 'object'
    and "safe_snapshot" ?& array['version', 'normalizedSettings', 'inputSummary']
    and "safe_snapshot" - 'version' - 'normalizedSettings' - 'inputSummary' = '{}'::jsonb
    and "safe_snapshot"->>'version' = '1'
    and jsonb_typeof("safe_snapshot"->'normalizedSettings') = 'object'
    and ("safe_snapshot"->'normalizedSettings') - 'durationSeconds' - 'resolution' - 'aspectRatio' - 'audioEnabled' - 'instrumental' = '{}'::jsonb
    and (not ("safe_snapshot"->'normalizedSettings' ? 'durationSeconds') or (jsonb_typeof("safe_snapshot"->'normalizedSettings'->'durationSeconds') = 'number' and ("safe_snapshot"->'normalizedSettings'->>'durationSeconds')::numeric > 0))
    and (not ("safe_snapshot"->'normalizedSettings' ? 'resolution') or (jsonb_typeof("safe_snapshot"->'normalizedSettings'->'resolution') = 'string' and "safe_snapshot"->'normalizedSettings'->>'resolution' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
    and (not ("safe_snapshot"->'normalizedSettings' ? 'aspectRatio') or (jsonb_typeof("safe_snapshot"->'normalizedSettings'->'aspectRatio') = 'string' and "safe_snapshot"->'normalizedSettings'->>'aspectRatio' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
    and (not ("safe_snapshot"->'normalizedSettings' ? 'audioEnabled') or jsonb_typeof("safe_snapshot"->'normalizedSettings'->'audioEnabled') = 'boolean')
    and (not ("safe_snapshot"->'normalizedSettings' ? 'instrumental') or jsonb_typeof("safe_snapshot"->'normalizedSettings'->'instrumental') = 'boolean')
    and jsonb_typeof("safe_snapshot"->'inputSummary') = 'object'
    and "safe_snapshot"->'inputSummary' ? 'promptCharacters'
    and ("safe_snapshot"->'inputSummary') - 'promptCharacters' - 'lyricsCharacters' = '{}'::jsonb
    and jsonb_typeof("safe_snapshot"->'inputSummary'->'promptCharacters') = 'number'
    and ("safe_snapshot"->'inputSummary'->>'promptCharacters')::numeric >= 0
    and (not ("safe_snapshot"->'inputSummary' ? 'lyricsCharacters') or (jsonb_typeof("safe_snapshot"->'inputSummary'->'lyricsCharacters') = 'number' and ("safe_snapshot"->'inputSummary'->>'lyricsCharacters')::numeric >= 0))
    and ("safe_failure" is null or not ("safe_failure" ?| array['raw', 'body', 'prompt', 'lyrics', 'download_url', 'signed_url', 'api_key', 'authorization']))),
  CONSTRAINT "media_generations_request_payload_shape" CHECK (jsonb_typeof("request_payload") = 'object'
    and "request_payload" ?& array['version', 'model', 'prompt', 'normalizedSettings']
    and "request_payload" - 'version' - 'model' - 'prompt' - 'lyrics' - 'normalizedSettings' = '{}'::jsonb
    and "request_payload"->>'version' = '1'
    and jsonb_typeof("request_payload"->'model') = 'string'
    and "request_payload"->>'model' = "provider_model"
    and "request_payload"->>'model' ~ '^[A-Za-z0-9._:+-]+$'
    and jsonb_typeof("request_payload"->'prompt') = 'string'
    and (not ("request_payload" ? 'lyrics') or jsonb_typeof("request_payload"->'lyrics') = 'string')
    and jsonb_typeof("request_payload"->'normalizedSettings') = 'object'
    and ("request_payload"->'normalizedSettings') - 'durationSeconds' - 'resolution' - 'aspectRatio' - 'audioEnabled' - 'instrumental' = '{}'::jsonb
    and (not ("request_payload"->'normalizedSettings' ? 'durationSeconds') or (jsonb_typeof("request_payload"->'normalizedSettings'->'durationSeconds') = 'number' and ("request_payload"->'normalizedSettings'->>'durationSeconds')::numeric > 0))
    and (not ("request_payload"->'normalizedSettings' ? 'resolution') or (jsonb_typeof("request_payload"->'normalizedSettings'->'resolution') = 'string' and "request_payload"->'normalizedSettings'->>'resolution' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
    and (not ("request_payload"->'normalizedSettings' ? 'aspectRatio') or (jsonb_typeof("request_payload"->'normalizedSettings'->'aspectRatio') = 'string' and "request_payload"->'normalizedSettings'->>'aspectRatio' ~ '^[A-Za-z0-9._:+-]{1,64}$'))
    and (not ("request_payload"->'normalizedSettings' ? 'audioEnabled') or jsonb_typeof("request_payload"->'normalizedSettings'->'audioEnabled') = 'boolean')
    and (not ("request_payload"->'normalizedSettings' ? 'instrumental') or jsonb_typeof("request_payload"->'normalizedSettings'->'instrumental') = 'boolean')
    and "request_payload"->'normalizedSettings' = "safe_snapshot"->'normalizedSettings'),
  CONSTRAINT "media_generations_claim_shape" CHECK (("claim_owner" is null) = ("claim_expires_at" is null)),
  CONSTRAINT "media_generations_cleanup_shape" CHECK (("cleanup_state" = 'pending' and "cleanup_completed_at" is null) or ("cleanup_state" = 'completed' and "cleanup_completed_at" is not null)),
  CONSTRAINT "media_generations_cleanup_state_check" CHECK ("cleanup_state" in ('pending', 'completed')),
  CONSTRAINT "media_generations_artifact_ready_shape" CHECK ("state" <> 'ready' or "artifact_internal_id" is not null),
  CONSTRAINT "media_generations_retention_shape" CHECK ("retain_until" is null or "retain_until" >= "created_at")
);
--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_room_namespace_fk" FOREIGN KEY ("room_id","namespace_id") REFERENCES "public"."rooms"("id","namespace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_artifact_internal_id_artifacts_id_fk" FOREIGN KEY ("artifact_internal_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_media_generations_scope_created" ON "media_generations" USING btree ("owner_id","room_id","namespace_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_media_generations_reconcile_due" ON "media_generations" USING btree ("state","next_attempt_at","created_at") WHERE "media_generations"."state" in ('queued', 'retrieving', 'saving');--> statement-breakpoint
CREATE INDEX "idx_media_generations_cleanup_due" ON "media_generations" USING btree ("cleanup_state","next_attempt_at","created_at") WHERE "media_generations"."cleanup_state" = 'pending' and "media_generations"."state" = 'ready';--> statement-breakpoint
ALTER TABLE "media_generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "media_generations_product_all" ON "media_generations" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER TABLE "media_generations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "media_generations" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "media_generations" TO "nautilo";--> statement-breakpoint
CREATE FUNCTION "public"."media_generation_authority_and_lifecycle_guard"()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.room_members membership
    INNER JOIN public.actors actor ON actor.id = membership.actor_id
    WHERE membership.room_id = NEW.room_id
      AND actor.owner_id = NEW.owner_id
      AND actor.kind = 'user'
  ) THEN
    RAISE EXCEPTION 'Media generation owner/Room/Namespace binding is invalid' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.receipt_id, NEW.owner_id, NEW.room_id, NEW.namespace_id,
      NEW.kind, NEW.provider, NEW.provider_model, NEW.provider_account_fingerprint,
      NEW.approval_digest, NEW.quote_digest, NEW.safe_snapshot, NEW.request_payload, NEW.quoted_usd_micros,
      NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.receipt_id, OLD.owner_id,
      OLD.room_id, OLD.namespace_id, OLD.kind, OLD.provider, OLD.provider_model,
      OLD.provider_account_fingerprint, OLD.approval_digest, OLD.quote_digest,
      OLD.safe_snapshot, OLD.request_payload, OLD.quoted_usd_micros, OLD.created_at) THEN
      RAISE EXCEPTION 'Media generation receipt identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.provider_queue_id IS NOT NULL AND NEW.provider_queue_id IS DISTINCT FROM OLD.provider_queue_id THEN
      RAISE EXCEPTION 'Accepted provider queue identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.admission_token IS NOT NULL AND
       (NEW.admission_token IS DISTINCT FROM OLD.admission_token OR
        NEW.admission_started_at IS DISTINCT FROM OLD.admission_started_at) THEN
      RAISE EXCEPTION 'Media generation admission proof is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'Media generation revision must advance exactly once' USING ERRCODE = '23514';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'prequeue' AND NEW.state in ('admitting', 'needs_action', 'failed')) OR
      (OLD.state = 'admitting' AND NEW.state in ('queued', 'unknown', 'needs_action', 'failed')) OR
      (OLD.state = 'queued' AND NEW.state in ('retrieving', 'needs_action', 'failed', 'unknown')) OR
      (OLD.state = 'retrieving' AND NEW.state in ('saving', 'needs_action', 'failed', 'unknown')) OR
      (OLD.state = 'saving' AND NEW.state in ('ready', 'needs_action', 'failed', 'unknown')) OR
      (OLD.state = 'unknown' AND NEW.state = 'needs_action')
    ) THEN
      RAISE EXCEPTION 'Illegal media generation lifecycle transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."media_generation_authority_and_lifecycle_guard"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
CREATE TRIGGER "media_generations_authority_and_lifecycle_guard"
BEFORE INSERT OR UPDATE ON "media_generations" FOR EACH ROW
EXECUTE FUNCTION "public"."media_generation_authority_and_lifecycle_guard"();
