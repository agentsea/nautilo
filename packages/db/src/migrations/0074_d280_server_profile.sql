CREATE TABLE "server_profile" (
	"id" text PRIMARY KEY DEFAULT 'server' NOT NULL,
	"name" text,
	"description" text,
	"description_visibility" text DEFAULT 'public' NOT NULL,
	"icon" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
