ALTER TABLE "file_revisions" ADD COLUMN "workspace_artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "file_revisions" ADD COLUMN "workspace_path_before" text;--> statement-breakpoint
ALTER TABLE "file_revisions" ADD COLUMN "workspace_path_after" text;--> statement-breakpoint
ALTER TABLE "file_revisions" ADD COLUMN "workspace_operation_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_file_revisions_workspace_operation" ON "file_revisions" USING btree ("agent_id","workspace_operation_id");--> statement-breakpoint
