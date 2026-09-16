CREATE TABLE "nautilo_instance_identity" (
	"id" text PRIMARY KEY DEFAULT 'self' NOT NULL,
	"instance_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE OR REPLACE FUNCTION public.nautilo_d374_allow_destructive()
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  raw text;
BEGIN
  raw := lower(coalesce(current_setting('nautilo.allow_destructive', true), ''));
  RETURN raw IN ('1', 'true', 'yes', 'on');
END;
$$;

CREATE OR REPLACE FUNCTION public.nautilo_d374_connected_db_is_default()
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  marker text;
BEGIN
  BEGIN
    SELECT instance_id INTO marker
    FROM public.nautilo_instance_identity
    WHERE id = 'self'
    LIMIT 1;
  EXCEPTION
    WHEN undefined_table OR invalid_schema_name THEN
      RETURN false;
  END;

  RETURN marker = '';
END;
$$;

CREATE OR REPLACE FUNCTION public.nautilo_d374_guard_default_drop_schema()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.nautilo_d374_allow_destructive() THEN
    RETURN;
  END IF;

  IF public.nautilo_d374_connected_db_is_default() THEN
    RAISE EXCEPTION
      'D374 seatbelt: refusing % on protected default DB without SET nautilo.allow_destructive=1',
      TG_TAG
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- CREATE EVENT TRIGGER requires superuser. Local dev migrates as the
-- `postgres` superuser and gets this layer; deployed migrations run as
-- the non-superuser `nautilo` DB owner (deploy compose template), where
-- this block skips cleanly instead of failing the whole migration.
-- Deploy still gets the table-trigger layer below plus the D129 P3
-- role split.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    EXECUTE 'DROP EVENT TRIGGER IF EXISTS nautilo_d374_guard_default_drop_schema';
    EXECUTE 'CREATE EVENT TRIGGER nautilo_d374_guard_default_drop_schema
      ON ddl_command_start
      WHEN TAG IN (''DROP SCHEMA'')
      EXECUTE FUNCTION public.nautilo_d374_guard_default_drop_schema()';
  ELSE
    RAISE NOTICE 'D374: skipping DROP SCHEMA event trigger (requires superuser; running as %)', current_user;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.nautilo_d374_guard_default_identity_table_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.nautilo_d374_allow_destructive() THEN
    RETURN NULL;
  END IF;

  IF public.nautilo_d374_connected_db_is_default() THEN
    RAISE EXCEPTION
      'D374 seatbelt: refusing % on %.% for protected default DB without SET nautilo.allow_destructive=1',
      TG_OP,
      TG_TABLE_SCHEMA,
      TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS nautilo_d374_guard_default_users_mutation ON public.users;
CREATE TRIGGER nautilo_d374_guard_default_users_mutation
  BEFORE DELETE OR TRUNCATE ON public.users
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.nautilo_d374_guard_default_identity_table_mutation();

-- TRUNCATE-only on credentials: legitimate live flows DELETE individual
-- credential rows on the default instance (recovery-code PIN rotation in
-- packages/trust/src/recovery-codes.ts, bin/nautilo-reset-pin), so a
-- DELETE guard here would break "forgot PIN". Mass wipes go through
-- TRUNCATE or DROP SCHEMA, both of which stay guarded.
DROP TRIGGER IF EXISTS nautilo_d374_guard_default_credentials_mutation ON public.credentials;
CREATE TRIGGER nautilo_d374_guard_default_credentials_mutation
  BEFORE TRUNCATE ON public.credentials
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.nautilo_d374_guard_default_identity_table_mutation();
