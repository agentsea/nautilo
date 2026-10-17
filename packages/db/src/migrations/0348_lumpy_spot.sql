CREATE TABLE "external_room_execution_claims" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"token" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_room_execution_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "external_room_execution_claims" ADD CONSTRAINT "external_room_execution_claims_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "external_room_execution_claim_owner" ON "external_room_execution_claims" AS PERMISSIVE FOR ALL TO "nautilo" USING ("external_room_execution_claims"."owner_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK ("external_room_execution_claims"."owner_user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
-- EXTERNAL_ROOM_EXECUTOR_QUIESCENCE_CLAIM
-- No Job/Human FK, expiry, terminal-status cleanup, or claim-token projection.
-- Only exact executor finally-release or Room deletion removes a claim.
ALTER TABLE public.external_room_execution_claims FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.external_room_execution_claims FROM PUBLIC, nautilo, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE public.external_room_execution_claims TO nautilo;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.external_room_job_start_allowed(p_owner uuid, p_room uuid, p_job uuid, p_token uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = p_room AND
    (NOT r.external_context OR (r.archived_at IS NULL
      AND p_owner = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND EXISTS (SELECT 1 FROM public.external_room_execution_claims c
        WHERE c.room_id = p_room AND c.job_id = p_job AND c.owner_user_id = p_owner AND c.token = p_token)
      AND EXISTS (SELECT 1 FROM public.jobs canonical_job WHERE canonical_job.id = p_job
        AND canonical_job.owner_id = p_owner AND canonical_job.room_id = p_room
        AND canonical_job.type = 'foreground' AND canonical_job.status = 'queued'
        AND canonical_job.started_at IS NULL AND canonical_job.completed_at IS NULL)
      AND EXISTS (SELECT 1 FROM public.room_members member JOIN public.actors actor ON actor.id = member.actor_id
        WHERE member.room_id = p_room AND actor.kind = 'user' AND actor.owner_id = p_owner))));
$$;--> statement-breakpoint
ALTER FUNCTION public.external_room_job_start_allowed(uuid,uuid,uuid,uuid) OWNER TO nautilo;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.external_room_job_start_allowed(uuid,uuid,uuid,uuid) FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_external_room_job_start()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.type = 'foreground' AND NEW.status = 'running' AND NEW.room_id IS NOT NULL
    AND NOT public.external_room_job_start_allowed(NEW.owner_id, NEW.room_id, NEW.id,
      nullif(current_setting('app.external_room_execution_token', true), '')::uuid) THEN
    RAISE EXCEPTION 'External Room execution claim is required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
ALTER FUNCTION public.guard_external_room_job_start() OWNER TO nautilo;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_external_room_job_start() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
CREATE TRIGGER external_room_job_start BEFORE INSERT OR UPDATE OF status, room_id, type, owner_id ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_external_room_job_start();
