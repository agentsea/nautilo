CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"persona_id" text DEFAULT 'owner' NOT NULL,
	"namespace_id" uuid,
	"tier" integer DEFAULT 1 NOT NULL,
	"type" text DEFAULT 'general' NOT NULL,
	"content" text NOT NULL,
	"importance" real DEFAULT 0.5 NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"demoted_at" timestamp with time zone,
	"demoted_from" integer,
	"promoted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" text,
	"content_search" tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"persona_id" text DEFAULT 'owner' NOT NULL,
	"title" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(100) DEFAULT 'Nautilo' NOT NULL,
	"soul_file" text,
	"language" varchar(5) DEFAULT 'en' NOT NULL,
	"privacy_spectrum" integer,
	"work_life_mode" varchar(20),
	"voice_name" varchar(100),
	"voice_id" varchar(100),
	"mother_answer" text,
	"avatar_url" text,
	"personality_tone" varchar(50),
	"default_model" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memories_owner_persona_tier" ON "memories" USING btree ("owner_id","persona_id","tier");--> statement-breakpoint
CREATE INDEX "idx_memories_namespace" ON "memories" USING btree ("namespace_id");--> statement-breakpoint
CREATE INDEX "idx_session_messages_session_id" ON "session_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_session_messages_content_search" ON "session_messages" USING gin ("content_search");--> statement-breakpoint
CREATE INDEX "idx_sessions_thread_id" ON "sessions" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_owner_id" ON "sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_profiles_user_id" ON "profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_embedding_hnsw" ON "memories" USING hnsw ("embedding" vector_cosine_ops);