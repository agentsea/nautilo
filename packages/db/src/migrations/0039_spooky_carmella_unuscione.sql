CREATE TABLE "agent_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_agent_id" uuid NOT NULL,
	"speaker_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purpose" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_scopes" (
	"memory_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_scopes_memory_id_scope_id_pk" PRIMARY KEY("memory_id","scope_id")
);
--> statement-breakpoint
ALTER TABLE "agent_scopes" ADD CONSTRAINT "agent_scopes_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scopes" ADD CONSTRAINT "agent_scopes_speaker_user_id_users_id_fk" FOREIGN KEY ("speaker_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_scopes" ADD CONSTRAINT "memory_scopes_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_scopes" ADD CONSTRAINT "memory_scopes_scope_id_agent_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."agent_scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_agent_scopes_name" ON "agent_scopes" USING btree ("parent_agent_id","speaker_user_id","name");--> statement-breakpoint
CREATE INDEX "idx_agent_scopes_owner" ON "agent_scopes" USING btree ("parent_agent_id","speaker_user_id");--> statement-breakpoint
CREATE INDEX "idx_memory_scopes_scope" ON "memory_scopes" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "idx_memory_scopes_memory" ON "memory_scopes" USING btree ("memory_id");