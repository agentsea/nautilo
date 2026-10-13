-- Custom SQL migration file, put your code below! --
--> statement-breakpoint
-- EXTERNAL_ROOM_NAMESPACE_EXECUTION_BOUNDARY
CREATE OR REPLACE FUNCTION public.external_room_job_start_allowed(p_owner uuid, p_room uuid, p_job uuid, p_token uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = p_room AND
    (NOT EXISTS (SELECT 1 FROM public.rooms boundary WHERE boundary.namespace_id = r.namespace_id AND boundary.external_context) OR (r.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.rooms ancestor WHERE ancestor.namespace_id = r.namespace_id AND ancestor.kind <> 'subthread' AND ancestor.archived_at IS NOT NULL) AND public.moderation_access_allowed(p_owner, p_room)
      AND p_owner = nullif(current_setting('app.current_user_id', true), '')::uuid
      AND EXISTS (SELECT 1 FROM public.external_room_execution_claims c
        WHERE c.room_id = p_room AND c.job_id = p_job AND c.owner_user_id = p_owner AND c.token = p_token)
      AND EXISTS (SELECT 1 FROM public.jobs canonical_job WHERE canonical_job.id = p_job
        AND canonical_job.owner_id = p_owner AND canonical_job.room_id = p_room
        AND canonical_job.type = 'foreground' AND canonical_job.status = 'queued'
        AND canonical_job.started_at IS NULL AND canonical_job.completed_at IS NULL)
      AND EXISTS (SELECT 1 FROM public.room_members member JOIN public.actors actor ON actor.id = member.actor_id JOIN public.users subject ON subject.id = actor.owner_id
        WHERE member.room_id = p_room AND actor.kind = 'user' AND actor.owner_id = p_owner AND subject.disabled_at IS NULL))));
$$;
