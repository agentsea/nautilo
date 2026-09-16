CREATE TABLE "push_installation_bindings" (
	"binding_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"platform" varchar(16) NOT NULL,
	"token_generation" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"permission" varchar(16) NOT NULL,
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"app_version" varchar(128) NOT NULL,
	"token_key_version" integer NOT NULL,
	"token_nonce_base64" varchar(64) NOT NULL,
	"token_ciphertext_base64" text NOT NULL,
	"token_auth_tag_base64" varchar(64) NOT NULL,
	"revoke_verifier_digest" varchar(64) NOT NULL,
	"disabled_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_installation_bindings_generation_check" CHECK ("push_installation_bindings"."token_generation" > 0),
	CONSTRAINT "push_installation_bindings_platform_check" CHECK ("push_installation_bindings"."platform" IN ('ios', 'android')),
	CONSTRAINT "push_installation_bindings_permission_check" CHECK ("push_installation_bindings"."permission" IN ('granted', 'denied', 'undetermined')),
	CONSTRAINT "push_installation_bindings_state_check" CHECK ("push_installation_bindings"."state" IN ('active', 'disabled', 'revoked')),
	CONSTRAINT "push_installation_bindings_revoke_digest_size_check" CHECK (octet_length("push_installation_bindings"."revoke_verifier_digest") = 64),
	CONSTRAINT "push_installation_bindings_state_shape_check" CHECK ((
        "push_installation_bindings"."state" = 'active'
        AND "push_installation_bindings"."enabled" = true
        AND "push_installation_bindings"."permission" = 'granted'
        AND "push_installation_bindings"."disabled_at" IS NULL
        AND "push_installation_bindings"."revoked_at" IS NULL
      ) OR (
        "push_installation_bindings"."state" = 'disabled'
        AND "push_installation_bindings"."enabled" = false
        AND "push_installation_bindings"."revoked_at" IS NULL
      ) OR (
        "push_installation_bindings"."state" = 'revoked'
        AND "push_installation_bindings"."enabled" = false
        AND "push_installation_bindings"."revoked_at" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "push_notification_test_intents" (
	"notification_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"token_generation" integer NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "push_notification_test_intents_generation_check" CHECK ("push_notification_test_intents"."token_generation" > 0),
	CONSTRAINT "push_notification_test_intents_state_check" CHECK ("push_notification_test_intents"."state" IN ('pending', 'terminal')),
	CONSTRAINT "push_notification_test_intents_terminal_shape_check" CHECK (("push_notification_test_intents"."state" = 'pending' AND "push_notification_test_intents"."terminal_at" IS NULL)
        OR ("push_notification_test_intents"."state" = 'terminal' AND "push_notification_test_intents"."terminal_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "push_installation_bindings" ADD CONSTRAINT "push_installation_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_notification_test_intents" ADD CONSTRAINT "push_notification_test_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_notification_test_intents" ADD CONSTRAINT "push_notification_test_intents_binding_id_push_installation_bindings_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."push_installation_bindings"("binding_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_push_installation_bindings_user_installation_live" ON "push_installation_bindings" USING btree ("user_id","installation_id") WHERE "push_installation_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_push_installation_bindings_user_live" ON "push_installation_bindings" USING btree ("user_id","updated_at") WHERE "push_installation_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_push_notification_test_intents_binding_created" ON "push_notification_test_intents" USING btree ("binding_id","created_at");--> statement-breakpoint

-- Push tokens are capability material.  The direct server role obtains access
-- only inside an owner-scoped RLS transaction; agents receive no grant.
ALTER TABLE "push_installation_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_installation_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "push_installation_bindings_owner" ON "push_installation_bindings"
  FOR ALL
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());--> statement-breakpoint

ALTER TABLE "push_notification_test_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_notification_test_intents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "push_notification_test_intents_owner" ON "push_notification_test_intents"
  FOR ALL
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
    REVOKE ALL ON TABLE "push_installation_bindings" FROM "nautilo_agent";
    REVOKE ALL ON TABLE "push_notification_test_intents" FROM "nautilo_agent";
  END IF;
END $$;--> statement-breakpoint

-- A removed Mobile client has no bearer session, but its revoke-only proof
-- may still retire one exact binding.  The app role receives this digest only
-- through the narrow function; the route compares it in constant time and
-- then performs the terminal owner-scoped update under RLS.  This function
-- cannot register, read status, rotate, or enqueue a test intent.
CREATE OR REPLACE FUNCTION app_read_push_installation_revoke_verifier(
  p_binding_id uuid
)
RETURNS TABLE(user_id uuid, revoke_verifier_digest text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT binding.user_id, binding.revoke_verifier_digest
  FROM push_installation_bindings AS binding
  WHERE binding.binding_id = p_binding_id
  LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_read_push_installation_revoke_verifier(uuid) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo') THEN
    GRANT EXECUTE ON FUNCTION app_read_push_installation_revoke_verifier(uuid) TO "nautilo";
  END IF;
END $$;
