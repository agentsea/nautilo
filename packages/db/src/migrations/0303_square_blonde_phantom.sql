CREATE TABLE "server_provider_policy" (
	"id" text PRIMARY KEY DEFAULT 'server' NOT NULL,
	"allow_personal_provider_keys" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_provider_policy_singleton" CHECK ("server_provider_policy"."id" = 'server')
);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "server_provider_policy" TO "nautilo";--> statement-breakpoint
REVOKE ALL ON TABLE "server_provider_policy" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";
