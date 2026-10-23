CREATE TABLE "external_operator_sessions" (
	"binding_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_operator_sessions_identity" CHECK (length("external_operator_sessions"."session_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "external_operator_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT REFERENCES(user_id,id) ON TABLE public.bolter_room_bindings TO nautilo;--> statement-breakpoint
ALTER TABLE "external_operator_sessions" ADD CONSTRAINT "external_operator_sessions_binding_owner" FOREIGN KEY ("user_id","binding_id") REFERENCES "public"."bolter_room_bindings"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "external_operator_sessions_owner" ON "external_operator_sessions" AS PERMISSIVE FOR ALL TO "nautilo_agent" USING ("external_operator_sessions"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK ("external_operator_sessions"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
-- EXTERNAL_OPERATOR_SESSION_FENCE
REVOKE REFERENCES(user_id,id) ON TABLE public.bolter_room_bindings FROM nautilo;--> statement-breakpoint
ALTER TABLE public.external_operator_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.external_operator_sessions FROM PUBLIC, nautilo, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.external_operator_sessions TO nautilo_agent;--> statement-breakpoint
GRANT SELECT(user_id,binding_id), UPDATE(binding_id), DELETE ON TABLE public.external_operator_sessions TO nautilo;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_external_operator_session()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.user_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
    OR NOT EXISTS (SELECT 1 FROM public.bolter_room_bindings b WHERE b.id = NEW.binding_id
      AND b.user_id = NEW.user_id AND b.provider = 'magent' AND b.state = 'active') THEN
    RAISE EXCEPTION 'External operator context is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_external_operator_session() FROM PUBLIC, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT TRIGGER ON TABLE public.external_operator_sessions TO nautilo;--> statement-breakpoint
CREATE TRIGGER external_operator_session_immutable BEFORE INSERT OR UPDATE ON public.external_operator_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_external_operator_session();--> statement-breakpoint
REVOKE TRIGGER ON TABLE public.external_operator_sessions FROM nautilo;
