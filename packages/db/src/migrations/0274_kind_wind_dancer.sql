DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_feed_reader') THEN
    CREATE ROLE nautilo_feed_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_feed_reader'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'nautilo_feed_reader must be a restricted non-login role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'nautilo_feed_reader')) THEN
    RAISE EXCEPTION 'nautilo_feed_reader must not inherit other roles';
  END IF;
  IF NOT pg_has_role('nautilo', 'nautilo_feed_reader', 'MEMBER') THEN
    GRANT nautilo_feed_reader TO nautilo WITH INHERIT FALSE;
  END IF;
  IF NOT pg_has_role('nautilo', 'nautilo_feed_reader', 'SET')
    OR pg_has_role('nautilo_agent', 'nautilo_feed_reader', 'SET')
    OR pg_has_role('nautilo_crypto', 'nautilo_feed_reader', 'SET') THEN
    RAISE EXCEPTION 'Only the product role may assume nautilo_feed_reader';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "feed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_key" text NOT NULL,
	"type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"data" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feed_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "feed_recipients" (
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp (3) with time zone,
	CONSTRAINT "feed_recipients_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "feed_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feed_events" ADD CONSTRAINT "feed_events_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_recipients" ADD CONSTRAINT "feed_recipients_event_id_feed_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."feed_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_recipients" ADD CONSTRAINT "feed_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_events_occurrence_key_unique" ON "feed_events" USING btree ("occurrence_key");--> statement-breakpoint
CREATE INDEX "feed_events_page_idx" ON "feed_events" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "feed_recipients_user_idx" ON "feed_recipients" USING btree ("user_id","event_id");--> statement-breakpoint
CREATE INDEX "feed_recipients_unread_idx" ON "feed_recipients" USING btree ("user_id") WHERE "feed_recipients"."read_at" is null;--> statement-breakpoint
CREATE POLICY "feed_events_read" ON "feed_events" AS PERMISSIVE FOR SELECT TO "nautilo_feed_reader" USING (exists (select 1 from feed_recipients r where r.event_id = "feed_events"."id" and r.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "feed_events_record_read" ON "feed_events" AS PERMISSIVE FOR SELECT TO "nautilo" USING (current_setting('app.event_feed_writer', true) = 'on');--> statement-breakpoint
CREATE POLICY "feed_events_append" ON "feed_events" AS PERMISSIVE FOR INSERT TO "nautilo" WITH CHECK (current_setting('app.event_feed_writer', true) = 'on');--> statement-breakpoint
CREATE POLICY "feed_recipients_read" ON "feed_recipients" AS PERMISSIVE FOR SELECT TO "nautilo_feed_reader" USING ("feed_recipients"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "feed_recipients_record_read" ON "feed_recipients" AS PERMISSIVE FOR SELECT TO "nautilo" USING (current_setting('app.event_feed_writer', true) = 'on');--> statement-breakpoint
CREATE POLICY "feed_recipients_append" ON "feed_recipients" AS PERMISSIVE FOR INSERT TO "nautilo" WITH CHECK (current_setting('app.event_feed_writer', true) = 'on');--> statement-breakpoint
CREATE POLICY "feed_recipients_read_state" ON "feed_recipients" AS PERMISSIVE FOR UPDATE TO "nautilo_feed_reader" USING ("feed_recipients"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK ("feed_recipients"."user_id" = nullif(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
-- EVENT_FEED_AUTHORITY
ALTER TABLE "feed_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feed_recipients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "feed_events", "feed_recipients" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "feed_events" TO "nautilo";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "feed_recipients" TO "nautilo";--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "nautilo_feed_reader";--> statement-breakpoint
GRANT SELECT ON TABLE "feed_events", "feed_recipients" TO "nautilo_feed_reader";--> statement-breakpoint
GRANT UPDATE ("read_at") ON TABLE "feed_recipients" TO "nautilo_feed_reader";
