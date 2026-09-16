CREATE TABLE "server_context_config" (
	"id" text PRIMARY KEY DEFAULT 'server' NOT NULL,
	"recent_conversation_limit" integer DEFAULT 50 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_context_config_recent_conversation_limit_range" CHECK ("server_context_config"."recent_conversation_limit" BETWEEN 10 AND 100)
);
