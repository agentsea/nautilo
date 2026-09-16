-- D219 — retire the legacy M061 `users.server_role` enum (server-wide
-- authority is now derived purely from Capabilities) and add the
-- soft-delete (account disable) columns on REL-HUM-SRV.
--
-- The `users_public` view (created by infra/postgres-init.sh /
-- agent-role-grants.ts, declared `.existing()` in Drizzle) SELECTs
-- `server_role`, so Postgres refuses to drop the column while the view
-- depends on it. Drop the view first, drop the column, then recreate the
-- view WITHOUT `server_role` and re-grant to nautilo_agent when that role
-- exists (test DBs may lack it).
DROP VIEW IF EXISTS "public"."users_public";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_server_role_check";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "server_role";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'users' AND n.nspname = 'public' AND c.relkind = 'r'
  ) THEN
    EXECUTE 'CREATE VIEW public.users_public AS '
            'SELECT id, handle, name, server, created_at, updated_at '
            'FROM public.users';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
      EXECUTE 'GRANT SELECT ON public.users_public TO nautilo_agent';
      EXECUTE 'REVOKE ALL ON TABLE public.users FROM nautilo_agent';
    END IF;
  END IF;
END $$;
