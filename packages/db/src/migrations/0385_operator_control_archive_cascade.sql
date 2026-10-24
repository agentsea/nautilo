-- Custom SQL migration file, put your code below! --
--> statement-breakpoint
-- EXTERNAL_OPERATOR_ARCHIVE_OWNER_CASCADE
CREATE OR REPLACE FUNCTION public.guard_external_operator_control_archive()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() >= 2 THEN
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = OLD.user_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Operator control archive is immutable' USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
GRANT TRIGGER ON TABLE public.external_operator_control_archive TO nautilo;--> statement-breakpoint
CREATE TRIGGER external_control_archive_immutable_row
BEFORE UPDATE OR DELETE ON public.external_operator_control_archive
FOR EACH ROW EXECUTE FUNCTION public.guard_external_operator_control_archive();--> statement-breakpoint
CREATE TRIGGER external_control_archive_immutable_table
BEFORE TRUNCATE ON public.external_operator_control_archive
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_external_operator_control_archive();--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.external_operator_control_archive FROM PUBLIC, nautilo, nautilo_agent, nautilo_crypto;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE public.external_operator_control_archive TO nautilo;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_external_operator_control_archive() FROM PUBLIC, nautilo_agent, nautilo_crypto;
