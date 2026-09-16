CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"host" text DEFAULT 'server' NOT NULL,
	"transport_kind" text NOT NULL,
	"transport" jsonb NOT NULL,
	"env_passthrough" text[],
	"env_literal" jsonb,
	"auth_ref" jsonb,
	"namespace_id" uuid,
	"include_tools" text[],
	"exclude_tools" text[],
	"enabled" boolean DEFAULT true NOT NULL,
	"trust_tier" text,
	"spawn_sandbox_profile" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
