-- D458 pairing is retained. The abandoned parallel Remote execution model is
-- removed outright, including its mutation to ordinary work acceptance state.
-- These tables were present only on development databases that exercised the
-- unmerged Stack 236 implementation; fresh installations simply skip them.
DROP TABLE IF EXISTS "remote_run_jobs";--> statement-breakpoint
DROP TABLE IF EXISTS "remote_run_commands";--> statement-breakpoint
DROP TABLE IF EXISTS "remote_run_bindings";--> statement-breakpoint
DROP TABLE IF EXISTS "remote_host_selections";--> statement-breakpoint
DROP TABLE IF EXISTS "remote_controller_request_nonces";--> statement-breakpoint
ALTER TABLE "work_acceptances" DROP CONSTRAINT IF EXISTS "work_acceptances_virtual_acceptance_id_unique";--> statement-breakpoint
ALTER TABLE "work_acceptances" DROP COLUMN IF EXISTS "virtual_acceptance_id";--> statement-breakpoint
ALTER TABLE "work_acceptances" DROP CONSTRAINT IF EXISTS "work_acceptances_status_check";--> statement-breakpoint
ALTER TABLE "work_acceptances" ADD CONSTRAINT "work_acceptances_status_check" CHECK ("work_acceptances"."status" IN ('accepted', 'dispatched', 'user_cancelled', 'maintenance_cancelled'));--> statement-breakpoint

-- The pairing tables may already exist on a developer database because the
-- earlier unmerged migration was exercised locally. Preserve valid pairings
-- while making this migration the only source-owned D458 schema history.
CREATE TABLE IF NOT EXISTS "remote_controller_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"server_binding_generation" integer NOT NULL,
	"controller_installation_id" uuid NOT NULL,
	"installation_generation" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"relay_token_id" uuid NOT NULL,
	"host_installation_id" uuid NOT NULL,
	"desktop_session_id" text NOT NULL,
	"pairing_generation" uuid NOT NULL,
	"challenge_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "remote_controller_bindings_pairing_generation_matches_relay" CHECK ("pairing_generation" = "relay_token_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "remote_controller_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"server_binding_generation" integer NOT NULL,
	"installation_id" uuid NOT NULL,
	"installation_generation" integer DEFAULT 1 NOT NULL,
	"proof_key_algorithm" varchar(128) NOT NULL,
	"proof_key" varchar(8192) NOT NULL,
	"proof_key_fingerprint" varchar(256) NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "remote_pairing_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"server_binding_generation" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"relay_token_id" uuid NOT NULL,
	"host_installation_id" uuid NOT NULL,
	"desktop_session_id" text NOT NULL,
	"pairing_generation" uuid NOT NULL,
	"qr_verifier_digest" text NOT NULL,
	"manual_verifier_digest" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_pairing_challenges_pairing_generation_matches_relay" CHECK ("pairing_generation" = "relay_token_id")
);
--> statement-breakpoint
ALTER TABLE "nautilo_instance_identity" ADD COLUMN IF NOT EXISTS "server_instance_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "nautilo_instance_identity" ADD COLUMN IF NOT EXISTS "server_binding_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_controller_bindings" DROP CONSTRAINT IF EXISTS "remote_controller_bindings_controller_installation_id_remote_controller_installations_id_fk";--> statement-breakpoint
ALTER TABLE "remote_controller_bindings" ADD CONSTRAINT "remote_controller_bindings_controller_installation_id_remote_controller_installations_id_fk" FOREIGN KEY ("controller_installation_id") REFERENCES "public"."remote_controller_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_controller_bindings" DROP CONSTRAINT IF EXISTS "remote_controller_bindings_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "remote_controller_bindings" ADD CONSTRAINT "remote_controller_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_controller_bindings" DROP CONSTRAINT IF EXISTS "remote_controller_bindings_actor_id_actors_id_fk";--> statement-breakpoint
ALTER TABLE "remote_controller_bindings" ADD CONSTRAINT "remote_controller_bindings_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_controller_bindings" DROP CONSTRAINT IF EXISTS "remote_controller_bindings_relay_token_id_relay_tokens_id_fk";--> statement-breakpoint
ALTER TABLE "remote_controller_bindings" ADD CONSTRAINT "remote_controller_bindings_relay_token_id_relay_tokens_id_fk" FOREIGN KEY ("relay_token_id") REFERENCES "public"."relay_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_controller_bindings" DROP CONSTRAINT IF EXISTS "remote_controller_bindings_challenge_id_remote_pairing_challenges_id_fk";--> statement-breakpoint
ALTER TABLE "remote_controller_bindings" ADD CONSTRAINT "remote_controller_bindings_challenge_id_remote_pairing_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."remote_pairing_challenges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_controller_installations" DROP CONSTRAINT IF EXISTS "remote_controller_installations_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "remote_controller_installations" ADD CONSTRAINT "remote_controller_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_controller_installations" DROP CONSTRAINT IF EXISTS "remote_controller_installations_actor_id_actors_id_fk";--> statement-breakpoint
ALTER TABLE "remote_controller_installations" ADD CONSTRAINT "remote_controller_installations_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_pairing_challenges" DROP CONSTRAINT IF EXISTS "remote_pairing_challenges_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "remote_pairing_challenges" ADD CONSTRAINT "remote_pairing_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_pairing_challenges" DROP CONSTRAINT IF EXISTS "remote_pairing_challenges_actor_id_actors_id_fk";--> statement-breakpoint
ALTER TABLE "remote_pairing_challenges" ADD CONSTRAINT "remote_pairing_challenges_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_pairing_challenges" DROP CONSTRAINT IF EXISTS "remote_pairing_challenges_relay_token_id_relay_tokens_id_fk";--> statement-breakpoint
ALTER TABLE "remote_pairing_challenges" ADD CONSTRAINT "remote_pairing_challenges_relay_token_id_relay_tokens_id_fk" FOREIGN KEY ("relay_token_id") REFERENCES "public"."relay_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_remote_controller_bindings_challenge" ON "remote_controller_bindings" USING btree ("challenge_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_remote_controller_bindings_controller_active" ON "remote_controller_bindings" USING btree ("controller_installation_id") WHERE "remote_controller_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_remote_controller_bindings_relay_active" ON "remote_controller_bindings" USING btree ("relay_token_id") WHERE "remote_controller_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_remote_controller_bindings_user_active" ON "remote_controller_bindings" USING btree ("user_id") WHERE "remote_controller_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_remote_controller_installations_scoped_installation" ON "remote_controller_installations" USING btree ("user_id","server_instance_id","server_binding_generation","installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_remote_controller_installations_user_active" ON "remote_controller_installations" USING btree ("user_id") WHERE "remote_controller_installations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_remote_pairing_challenges_expiry" ON "remote_pairing_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_remote_pairing_challenges_relay_active" ON "remote_pairing_challenges" USING btree ("relay_token_id") WHERE "remote_pairing_challenges"."consumed_at" IS NULL AND "remote_pairing_challenges"."revoked_at" IS NULL;
