ALTER POLICY "bolter_connections_owner" ON "bolter_connections" TO nautilo,nautilo_agent USING ("bolter_connections"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK ("bolter_connections"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "bolter_bindings_owner" ON "bolter_room_bindings" TO nautilo,nautilo_agent USING ("bolter_room_bindings"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK ("bolter_room_bindings"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
-- BOLTER_FACTORY_PRODUCT_AUTHORITY
-- The trusted product factory mints canonical Room membership. Its role has
-- BYPASSRLS; explicit owner query predicates and these GUC mutation guards
-- enforce its boundary. Agent table access remains owner-RLS restricted.
GRANT SELECT, UPDATE ON TABLE public.bolter_connections TO nautilo;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.bolter_room_bindings TO nautilo;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_bolter_connection()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF nullif(current_setting('app.current_user_id', true), '')::uuid IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Bolter owner context unavailable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.generation <> 1 OR NEW.revision <> 0 OR NOT NEW.enabled OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial Bolter connection' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(OLD) - ARRAY['desktop_session_id','pairing_generation_ref','generation','revision','enabled','revoked_at','updated_at'])
      IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['desktop_session_id','pairing_generation_ref','generation','revision','enabled','revoked_at','updated_at'])
      OR OLD.revoked_at IS NOT NULL OR NEW.generation <> OLD.generation + 1 OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'Bolter connection identity or generation is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
-- xmin is not mint provenance and fails for legitimate savepoint inserts.
-- The server-owned canonical creation callback establishes freshness.
CREATE OR REPLACE FUNCTION public.guard_bolter_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE c public.bolter_connections%ROWTYPE; r public.rooms%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.current_user_id', true), '')::uuid IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Bolter owner context unavailable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['state','revision','updated_at']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['state','revision','updated_at'])
      OR OLD.state = 'revoked' OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'Bolter binding routing coordinates are immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.revision <> 0 OR NEW.state <> 'active' THEN
      RAISE EXCEPTION 'Invalid initial Bolter binding' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO c FROM public.bolter_connections WHERE id = NEW.connection_id AND user_id = NEW.user_id FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO r FROM public.rooms WHERE id = NEW.room_id AND namespace_id = NEW.namespace_id FOR UPDATE;
    IF r.id IS NULL OR r.owner_id <> NEW.user_id OR NOT r.external_context OR r.kind <> 'private'
      OR r.archived_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.sessions s JOIN public.session_messages m ON m.session_id = s.id WHERE s.room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_events WHERE room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_event_rollups WHERE room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_journal_batches WHERE room_id = r.id)
      OR EXISTS (SELECT 1 FROM public.room_journal_state WHERE room_id = r.id AND last_processed_message_id <> 0) THEN
      RAISE EXCEPTION 'Bolter binding requires a factory-created empty external Room and namespace' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state = 'active' THEN
    IF c.id IS NULL OR NOT c.enabled OR c.revoked_at IS NOT NULL OR c.origin <> NEW.origin OR c.provider_agent_id <> NEW.provider_agent_id
      OR NOT coalesce(public.bolter_room_admission(NEW.user_id, NEW.room_id, NEW.namespace_id, NEW.agent_id), false) THEN
      RAISE EXCEPTION 'Bolter sponsor or Genie membership unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
