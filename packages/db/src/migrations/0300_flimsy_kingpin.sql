CREATE TABLE "group_moderation_scopes" (
	"group_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	CONSTRAINT "group_moderation_scopes_group_id_room_id_pk" PRIMARY KEY("group_id","room_id")
);
--> statement-breakpoint
ALTER TABLE "group_moderation_scopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"request_digest" text NOT NULL,
	"requester_user_id" uuid,
	"subject_id" uuid NOT NULL,
	"room_id" uuid,
	"action" text NOT NULL,
	"restriction_id" uuid,
	"reason" text,
	"private_note" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"audit_recorded_at" timestamp with time zone,
	"converged_at" timestamp with time zone,
	CONSTRAINT "moderation_actions_digest_check" CHECK ("moderation_actions"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "moderation_actions_kind_check" CHECK ("moderation_actions"."action" IN ('ban', 'kick', 'timeout', 'mute', 'lift')),
	CONSTRAINT "moderation_actions_restriction_check" CHECK (("moderation_actions"."action" = 'kick') = ("moderation_actions"."restriction_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "moderation_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "moderation_restrictions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_id" uuid NOT NULL,
	"room_id" uuid,
	"kind" text NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"create_operation_id" uuid NOT NULL,
	"lift_operation_id" uuid,
	CONSTRAINT "moderation_restrictions_kind_check" CHECK ("moderation_restrictions"."kind" IN ('access', 'participation')),
	CONSTRAINT "moderation_restrictions_times_check" CHECK ("moderation_restrictions"."expires_at" IS NULL OR "moderation_restrictions"."expires_at" > "moderation_restrictions"."starts_at"),
	CONSTRAINT "moderation_restrictions_revision_check" CHECK ("moderation_restrictions"."revision" > 0),
	CONSTRAINT "moderation_restrictions_lift_check" CHECK (("moderation_restrictions"."lifted_at" IS NULL) = ("moderation_restrictions"."lift_operation_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "moderation_restrictions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "moderation_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"identity_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_subjects_digest_check" CHECK ("moderation_subjects"."identity_digest" IS NULL OR "moderation_subjects"."identity_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "moderation_subjects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "server_admission" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"admitted" boolean DEFAULT false NOT NULL,
	"operation_id" uuid,
	CONSTRAINT "server_admission_epoch_check" CHECK ("server_admission"."epoch" >= 0)
);
--> statement-breakpoint
ALTER TABLE "server_admission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "server_moderation_policy" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"joins_paused" boolean DEFAULT false NOT NULL,
	"approval_required" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_moderation_policy_singleton" CHECK ("server_moderation_policy"."singleton"),
	CONSTRAINT "server_moderation_policy_revision" CHECK ("server_moderation_policy"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "server_moderation_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invite_redemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD COLUMN "bound_admission_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD COLUMN "completion_admission_epoch" integer;--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD COLUMN "join_message" text;--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD COLUMN "review_state" text;--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD COLUMN "review_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_moderation_scopes" ADD CONSTRAINT "group_moderation_scopes_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_moderation_scopes" ADD CONSTRAINT "group_moderation_scopes_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_subject_id_moderation_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."moderation_subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_restrictions" ADD CONSTRAINT "moderation_restrictions_subject_id_moderation_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."moderation_subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_restrictions" ADD CONSTRAINT "moderation_restrictions_create_operation_id_moderation_actions_operation_id_fk" FOREIGN KEY ("create_operation_id") REFERENCES "public"."moderation_actions"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_restrictions" ADD CONSTRAINT "moderation_restrictions_lift_operation_id_moderation_actions_operation_id_fk" FOREIGN KEY ("lift_operation_id") REFERENCES "public"."moderation_actions"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_subjects" ADD CONSTRAINT "moderation_subjects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_admission" ADD CONSTRAINT "server_admission_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_admission" ADD CONSTRAINT "server_admission_operation_id_moderation_actions_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."moderation_actions"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_moderation_policy" ADD CONSTRAINT "server_moderation_policy_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_moderation_scopes_room_idx" ON "group_moderation_scopes" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_subject_cursor_idx" ON "moderation_actions" USING btree ("subject_id","created_at","operation_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_scope_cursor_idx" ON "moderation_actions" USING btree ("room_id","created_at","operation_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_pending_audit_idx" ON "moderation_actions" USING btree ("created_at","operation_id") WHERE "moderation_actions"."audit_recorded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "moderation_actions_pending_convergence_idx" ON "moderation_actions" USING btree ("created_at","operation_id") WHERE "moderation_actions"."converged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "moderation_restrictions_active_idx" ON "moderation_restrictions" USING btree ("subject_id","room_id","kind","expires_at") WHERE "moderation_restrictions"."lifted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_subjects_user_idx" ON "moderation_subjects" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_subjects_identity_idx" ON "moderation_subjects" USING btree ("identity_digest");--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD CONSTRAINT "invite_redemptions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_redemptions_review_idx" ON "invite_redemptions" USING btree ("review_state","invite_id","user_id");--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD CONSTRAINT "invite_redemptions_review_message" CHECK (("invite_redemptions"."review_state" IS NULL AND "invite_redemptions"."join_message" IS NULL AND "invite_redemptions"."review_revision" = 0)
      OR ("invite_redemptions"."review_state" IS NOT NULL AND "invite_redemptions"."review_state" IN ('pending', 'approved', 'rejected') AND "invite_redemptions"."join_message" IS NOT NULL
        AND length(btrim("invite_redemptions"."join_message")) > 0 AND "invite_redemptions"."review_revision" > 0));--> statement-breakpoint
CREATE POLICY "invite_redemptions_product" ON "invite_redemptions" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "group_moderation_scopes_product" ON "group_moderation_scopes" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "moderation_actions_product" ON "moderation_actions" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "moderation_restrictions_product" ON "moderation_restrictions" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "moderation_subjects_product" ON "moderation_subjects" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "server_admission_product" ON "server_admission" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "server_moderation_policy_product" ON "server_moderation_policy" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- MODERATION_AUTHORITY
ALTER TABLE "group_moderation_scopes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "group_moderation_scopes" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "group_moderation_scopes" TO "nautilo";
--> statement-breakpoint
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "group_moderation_scopes" FROM "nautilo";
--> statement-breakpoint
ALTER TABLE "moderation_subjects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "moderation_subjects" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "moderation_subjects" TO "nautilo";
--> statement-breakpoint
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "moderation_subjects" FROM "nautilo";
--> statement-breakpoint
ALTER TABLE "moderation_actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "moderation_actions" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "moderation_actions" TO "nautilo";
--> statement-breakpoint
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "moderation_actions" FROM "nautilo";
--> statement-breakpoint
ALTER TABLE "moderation_restrictions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "moderation_restrictions" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "moderation_restrictions" TO "nautilo";
--> statement-breakpoint
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "moderation_restrictions" FROM "nautilo";
--> statement-breakpoint
ALTER TABLE "server_admission" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "server_admission" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "server_admission" TO "nautilo";
--> statement-breakpoint
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "server_admission" FROM "nautilo";
--> statement-breakpoint
INSERT INTO "server_admission" ("user_id", "admitted")
SELECT u.id, NOT EXISTS (
  SELECT 1 FROM invite_redemptions r WHERE r.user_id = u.id AND r.completed_at IS NULL
) OR EXISTS (
  SELECT 1 FROM invite_redemptions r WHERE r.user_id = u.id AND r.completed_at IS NOT NULL
) FROM users u;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_moderation_action()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND (to_jsonb(NEW) - 'reason' - 'private_note' - 'audit_recorded_at' - 'converged_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'reason' - 'private_note' - 'audit_recorded_at' - 'converged_at')
    AND (NEW.reason IS NOT DISTINCT FROM OLD.reason OR NEW.reason IS NULL)
    AND (NEW.private_note IS NOT DISTINCT FROM OLD.private_note OR NEW.private_note IS NULL)
    AND (OLD.audit_recorded_at IS NULL OR NEW.audit_recorded_at IS NOT DISTINCT FROM OLD.audit_recorded_at)
    AND (OLD.converged_at IS NULL OR NEW.converged_at IS NOT DISTINCT FROM OLD.converged_at)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Moderation action identity and outcome are immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER moderation_action_immutable_row BEFORE UPDATE OR DELETE ON moderation_actions
FOR EACH ROW EXECUTE FUNCTION public.guard_moderation_action();
--> statement-breakpoint
CREATE TRIGGER moderation_action_immutable_table BEFORE TRUNCATE ON moderation_actions
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_moderation_action();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_moderation_action() FROM PUBLIC, nautilo_agent, nautilo_crypto;

--> statement-breakpoint
-- MODERATION_RECIPIENT_ACCESS
CREATE OR REPLACE FUNCTION public.moderation_access_allowed(subject_user_id uuid, source_room_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.server_admission admission
    WHERE admission.user_id = subject_user_id AND admission.admitted)
  AND NOT EXISTS (
    SELECT 1 FROM public.moderation_subjects subject
    JOIN public.moderation_restrictions restriction ON restriction.subject_id = subject.id
    WHERE subject.user_id = subject_user_id AND restriction.kind = 'access'
      AND restriction.lifted_at IS NULL AND restriction.starts_at <= statement_timestamp()
      AND (restriction.expires_at IS NULL OR restriction.expires_at > statement_timestamp())
      AND (restriction.room_id IS NULL OR restriction.room_id = source_room_id
        OR restriction.room_id = (SELECT parent_room_id FROM public.rooms WHERE id = source_room_id))
  );
$$;--> statement-breakpoint
ALTER FUNCTION public.moderation_access_allowed(uuid, uuid) OWNER TO nautilo;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.moderation_access_allowed(uuid, uuid) FROM PUBLIC, nautilo_agent;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.moderation_access_allowed(uuid, uuid) TO nautilo, nautilo_crypto;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.moderation_effective_humans(candidate_ids uuid[], source_room_id uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT ARRAY(SELECT actor.id FROM public.actors actor
    WHERE actor.id = ANY(candidate_ids) AND actor.kind = 'user'
      AND public.moderation_access_allowed(actor.owner_id, source_room_id)
    ORDER BY actor.id);
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.moderation_effective_humans(uuid[], uuid) FROM PUBLIC, nautilo_agent;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.moderation_effective_humans(uuid[], uuid) TO nautilo, nautilo_crypto;

--> statement-breakpoint
-- MODERATION_POLICY_PRIVILEGES
ALTER TABLE server_moderation_policy FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE server_moderation_policy FROM PUBLIC, nautilo_agent, nautilo_crypto;
GRANT SELECT, INSERT, UPDATE ON TABLE server_moderation_policy TO nautilo;
INSERT INTO server_moderation_policy (singleton) VALUES (true) ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- ENROLLMENT_REVIEW_PRIVILEGES
ALTER TABLE invite_redemptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE invite_redemptions FROM PUBLIC, nautilo_agent, nautilo_crypto;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invite_redemptions TO nautilo;
