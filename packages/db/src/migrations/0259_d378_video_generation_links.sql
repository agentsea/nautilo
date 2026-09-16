-- D378 — Video-project lineage is separate from D525's provider-opaque receipt.
CREATE TABLE "video_generation_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "take_id" text NOT NULL,
  "receipt_id" text NOT NULL,
  "owner_id" uuid NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "room_id" uuid NOT NULL,
  "namespace_id" uuid NOT NULL,
  "project_artifact_internal_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "shot_id" text NOT NULL,
  "shot_label" text NOT NULL,
  "brief_digest" text NOT NULL,
  "document_revision" integer NOT NULL,
  "admitted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "uq_video_generation_links_take_id" UNIQUE("take_id"),
  CONSTRAINT "uq_video_generation_links_receipt_id" UNIQUE("receipt_id"),
  CONSTRAINT "uq_video_generation_links_project_request" UNIQUE("owner_id","room_id","project_artifact_internal_id","request_id"),
  CONSTRAINT "video_generation_links_take_id" CHECK (octet_length("take_id") between 21 and 133 and "take_id" ~ '^take_[A-Za-z0-9_-]{16,128}$'),
  CONSTRAINT "video_generation_links_digest" CHECK ("brief_digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "video_generation_links_shot_id" CHECK (octet_length("shot_id") between 1 and 160),
  CONSTRAINT "video_generation_links_shot_label" CHECK (octet_length("shot_label") between 1 and 240),
  CONSTRAINT "video_generation_links_revision" CHECK ("document_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "video_generation_links" ADD CONSTRAINT "video_generation_links_receipt_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."media_generations"("receipt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_generation_links" ADD CONSTRAINT "video_generation_links_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_generation_links" ADD CONSTRAINT "video_generation_links_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_generation_links" ADD CONSTRAINT "video_generation_links_namespace_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_generation_links" ADD CONSTRAINT "video_generation_links_project_artifact_fk" FOREIGN KEY ("project_artifact_internal_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_generation_links" ADD CONSTRAINT "video_generation_links_room_namespace_fk" FOREIGN KEY ("room_id","namespace_id") REFERENCES "public"."rooms"("id","namespace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_video_generation_links_project_created" ON "video_generation_links" USING btree ("owner_id","room_id","namespace_id","project_artifact_internal_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_video_generation_links_project_admitted" ON "video_generation_links" USING btree ("owner_id","room_id","namespace_id","project_artifact_internal_id","admitted_at");--> statement-breakpoint
ALTER TABLE "video_generation_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "video_generation_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "video_generation_links_product_all" ON "video_generation_links" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE "video_generation_links" FROM PUBLIC, "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "video_generation_links" TO "nautilo";
