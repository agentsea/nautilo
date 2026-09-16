CREATE TABLE "file_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"room_id" uuid,
	"turn_id" text NOT NULL,
	"absolute_path" text NOT NULL,
	"workspace_path" text,
	"pre_sha256" text NOT NULL,
	"pre_size" bigint NOT NULL,
	"kind" text NOT NULL,
	"diff_text" text,
	"blob_ref" text,
	"blob_size" bigint,
	"operation" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "file_revisions" ADD CONSTRAINT "file_revisions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_revisions" ADD CONSTRAINT "file_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_revisions" ADD CONSTRAINT "file_revisions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_file_revisions_path_newest" ON "file_revisions" USING btree ("agent_id","absolute_path","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_file_revisions_turn" ON "file_revisions" USING btree ("agent_id","turn_id");--> statement-breakpoint
CREATE INDEX "idx_file_revisions_gc" ON "file_revisions" USING btree ("pinned","accessed_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_file_revisions_blob_ref" ON "file_revisions" USING btree ("blob_ref");