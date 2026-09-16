CREATE TABLE "connected_app_oauth_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"namespace_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"driver_kind" text NOT NULL,
	"connection_request_id" text NOT NULL,
	"provider_config_id" text NOT NULL,
	"connection_name" text NOT NULL,
	"status" text DEFAULT 'connecting' NOT NULL,
	"error_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_app_oauth_provider_check" CHECK ("connected_app_oauth_attempts"."provider_id" ~ '^[a-z][a-z0-9_-]*$'),
	CONSTRAINT "connected_app_oauth_driver_check" CHECK ("connected_app_oauth_attempts"."driver_kind" IN ('oomol_hosted', 'openconnector_local')),
	CONSTRAINT "connected_app_oauth_status_check" CHECK ("connected_app_oauth_attempts"."status" IN ('connecting', 'connected', 'failed', 'expired')),
	CONSTRAINT "connected_app_oauth_terminal_check" CHECK (("connected_app_oauth_attempts"."status" = 'connecting' AND "connected_app_oauth_attempts"."completed_at" IS NULL)
        OR ("connected_app_oauth_attempts"."status" <> 'connecting' AND "connected_app_oauth_attempts"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "connected_app_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"namespace_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"driver_kind" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"connected_account_id" text NOT NULL,
	"provider_config_id" text NOT NULL,
	"connection_name" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"provider_workspace_identity" text NOT NULL,
	"provider_user_kind" text NOT NULL,
	"account_username" text,
	"account_display_name" text,
	"account_email" text,
	"account_avatar_url" text,
	"account_workspace_name" text,
	"driver_credential_ref_id" text,
	"driver_credential_namespace_id" uuid,
	"driver_credential_agent_id" text,
	"driver_credential_record_id" text,
	"last_error_code" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_app_profiles_provider_check" CHECK ("connected_app_profiles"."provider_id" ~ '^[a-z][a-z0-9_-]*$'),
	CONSTRAINT "connected_app_profiles_driver_check" CHECK ("connected_app_profiles"."driver_kind" IN ('oomol_hosted', 'openconnector_local', 'nautilo_native')),
	CONSTRAINT "connected_app_profiles_status_check" CHECK ("connected_app_profiles"."status" IN ('connected', 'reconnect_required', 'error')),
	CONSTRAINT "connected_app_profiles_revision_check" CHECK ("connected_app_profiles"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "connected_app_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"driver_kind" text NOT NULL,
	"status" text DEFAULT 'setup_required' NOT NULL,
	"client_id" text,
	"admin_credential_ref_id" text,
	"admin_credential_namespace_id" uuid,
	"admin_credential_agent_id" text,
	"last_error_code" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_app_provider_configs_provider_check" CHECK ("connected_app_provider_configs"."provider_id" ~ '^[a-z][a-z0-9_-]*$'),
	CONSTRAINT "connected_app_provider_configs_driver_check" CHECK ("connected_app_provider_configs"."driver_kind" = 'openconnector_local'),
	CONSTRAINT "connected_app_provider_configs_status_check" CHECK ("connected_app_provider_configs"."status" IN ('setup_required', 'ready', 'error')),
	CONSTRAINT "connected_app_provider_configs_revision_check" CHECK ("connected_app_provider_configs"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "connected_app_oauth_attempts" ADD CONSTRAINT "connected_app_oauth_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_app_oauth_attempts" ADD CONSTRAINT "connected_app_oauth_attempts_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_app_profiles" ADD CONSTRAINT "connected_app_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_app_profiles" ADD CONSTRAINT "connected_app_profiles_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_app_profiles" ADD CONSTRAINT "connected_app_profiles_driver_credential_namespace_id_namespaces_id_fk" FOREIGN KEY ("driver_credential_namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_app_provider_configs" ADD CONSTRAINT "connected_app_provider_configs_admin_credential_namespace_id_namespaces_id_fk" FOREIGN KEY ("admin_credential_namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connected_app_oauth_driver_request" ON "connected_app_oauth_attempts" USING btree ("driver_kind","connection_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connected_app_oauth_active_actor_provider" ON "connected_app_oauth_attempts" USING btree ("user_id","namespace_id","provider_id","driver_kind") WHERE "connected_app_oauth_attempts"."status" = 'connecting';--> statement-breakpoint
CREATE INDEX "idx_connected_app_oauth_actor" ON "connected_app_oauth_attempts" USING btree ("user_id","namespace_id","provider_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connected_app_profile_actor_provider_driver" ON "connected_app_profiles" USING btree ("user_id","namespace_id","provider_id","driver_kind");--> statement-breakpoint
CREATE INDEX "idx_connected_app_profiles_user_namespace" ON "connected_app_profiles" USING btree ("user_id","namespace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connected_app_provider_config_provider_driver" ON "connected_app_provider_configs" USING btree ("provider_id","driver_kind");