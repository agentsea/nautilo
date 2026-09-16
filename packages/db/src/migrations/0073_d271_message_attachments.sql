CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_id" uuid NOT NULL,
	"uploader_actor_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_uri" text NOT NULL,
	"claimed_mime" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "message_attachments_status_check" CHECK ("message_attachments"."status" IN ('pending', 'consumed', 'retained', 'deleted')),
	CONSTRAINT "message_attachments_lifecycle_check" CHECK ((
      ("message_attachments"."status" = 'pending' AND "message_attachments"."expires_at" IS NOT NULL AND "message_attachments"."resolved_at" IS NULL AND "message_attachments"."deleted_at" IS NULL)
      OR ("message_attachments"."status" = 'consumed' AND "message_attachments"."resolved_at" IS NOT NULL AND "message_attachments"."deleted_at" IS NULL)
      OR ("message_attachments"."status" = 'retained' AND "message_attachments"."resolved_at" IS NOT NULL AND "message_attachments"."deleted_at" IS NULL)
      OR ("message_attachments"."status" = 'deleted' AND "message_attachments"."deleted_at" IS NOT NULL)
    )),
	CONSTRAINT "message_attachments_size_nonnegative" CHECK ("message_attachments"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_namespace_id_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."namespaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_uploader_actor_id_actors_id_fk" FOREIGN KEY ("uploader_actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_attachments_pending_owner_expiry" ON "message_attachments" USING btree ("uploader_actor_id","expires_at") WHERE "message_attachments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_message_attachments_namespace_status" ON "message_attachments" USING btree ("namespace_id","status");--> statement-breakpoint
CREATE INDEX "idx_message_attachments_expired_pending" ON "message_attachments" USING btree ("expires_at") WHERE "message_attachments"."status" = 'pending';