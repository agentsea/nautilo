CREATE TABLE "server_model_config" (
	"id" text PRIMARY KEY DEFAULT 'server' NOT NULL,
	"default_chat_model" text,
	"conductor_model" text,
	"fallback_chain" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
