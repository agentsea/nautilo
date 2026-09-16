CREATE TABLE "account_deletion_photo_cleanup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"avatar_kind" text NOT NULL,
	"blob_id" text NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletion_photo_cleanup_avatar_kind_check" CHECK ("account_deletion_photo_cleanup"."avatar_kind" IN ('generated', 'uploaded')),
	CONSTRAINT "account_deletion_photo_cleanup_blob_id_check" CHECK (length("account_deletion_photo_cleanup"."blob_id") BETWEEN 1 AND 256 AND "account_deletion_photo_cleanup"."blob_id" ~ '^[A-Za-z0-9._-]+$'),
	CONSTRAINT "account_deletion_photo_cleanup_claim_shape_check" CHECK (("account_deletion_photo_cleanup"."claimed_at" IS NULL) = ("account_deletion_photo_cleanup"."claim_token" IS NULL)),
	CONSTRAINT "account_deletion_photo_cleanup_attempts_check" CHECK ("account_deletion_photo_cleanup"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_photo_selection_revisions" DROP CONSTRAINT "agent_photo_selection_revisions_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "photo_library_operations" DROP CONSTRAINT "photo_library_operations_viewer_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" DROP CONSTRAINT "workspace_document_mutations_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "member_rollouts" DROP CONSTRAINT "member_rollouts_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "media_generations" DROP CONSTRAINT "media_generations_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_photo_selection_revisions" ALTER COLUMN "actor_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "photo_library_operations" ALTER COLUMN "viewer_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "member_rollouts" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_generations" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_account_deletion_photo_cleanup_blob" ON "account_deletion_photo_cleanup" USING btree ("server_instance_id","avatar_kind","blob_id");--> statement-breakpoint
CREATE INDEX "idx_account_deletion_photo_cleanup_pending" ON "account_deletion_photo_cleanup" USING btree ("created_at","id");--> statement-breakpoint
ALTER TABLE "agent_photo_selection_revisions" ADD CONSTRAINT "agent_photo_selection_revisions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_library_operations" ADD CONSTRAINT "photo_library_operations_viewer_user_id_users_id_fk" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" ADD CONSTRAINT "workspace_document_mutations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_rollouts" ADD CONSTRAINT "member_rollouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;