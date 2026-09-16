-- D525 follow-up — bind a paid receipt to its initiating Genie/thread and
-- deliver one restart-safe completion wake after the Workspace artifact is ready.
ALTER TABLE "media_generations" ADD COLUMN "initiating_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "initiating_thread_id" text;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "completion_wake_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "completion_wake_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_initiating_agent_id_agents_id_fk" FOREIGN KEY ("initiating_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_initiator_shape" CHECK (("initiating_agent_id" is null) = ("initiating_thread_id" is null) and ("initiating_thread_id" is null or octet_length("initiating_thread_id") between 1 and 512));--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_completion_wake_shape" CHECK ("completion_wake_delivered_at" is null or "completion_wake_claimed_at" is not null);--> statement-breakpoint
CREATE INDEX "idx_media_generations_completion_wake_due" ON "media_generations" USING btree ("state","ready_at","created_at") WHERE "media_generations"."state" = 'ready' and "media_generations"."completion_wake_delivered_at" is null and "media_generations"."initiating_agent_id" is not null;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."media_generation_authority_and_lifecycle_guard"()
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
      NEW.initiating_agent_id, NEW.initiating_thread_id,
      NEW.kind, NEW.provider, NEW.provider_model, NEW.provider_account_fingerprint,
      NEW.approval_digest, NEW.quote_digest, NEW.safe_snapshot, NEW.request_payload, NEW.quoted_usd_micros,
      NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.receipt_id, OLD.owner_id,
      OLD.room_id, OLD.namespace_id, OLD.initiating_agent_id, OLD.initiating_thread_id,
      OLD.kind, OLD.provider, OLD.provider_model,
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
    IF OLD.completion_wake_delivered_at IS NOT NULL AND
       NEW.completion_wake_delivered_at IS DISTINCT FROM OLD.completion_wake_delivered_at THEN
      RAISE EXCEPTION 'Media generation completion wake delivery is immutable' USING ERRCODE = '23514';
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
REVOKE ALL ON FUNCTION "public"."media_generation_authority_and_lifecycle_guard"() FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
