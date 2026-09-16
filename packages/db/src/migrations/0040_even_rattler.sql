ALTER TABLE "memory_scopes" ADD COLUMN "origin" text DEFAULT 'seed' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "transcript_origin" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "parent_thread_id" text;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "scope_id" uuid;