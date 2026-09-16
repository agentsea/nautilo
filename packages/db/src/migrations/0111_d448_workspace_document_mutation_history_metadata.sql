ALTER TABLE "workspace_document_mutation_entries" ADD COLUMN "before_mime_type" text;--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entries" ADD COLUMN "after_mime_type" text;--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entries" ADD COLUMN "history_operation" text DEFAULT 'editor_save' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entries" ADD COLUMN "history_eligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entries" ADD COLUMN "restore_from_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" ADD COLUMN "editor_request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" ADD COLUMN "accessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entries" ADD CONSTRAINT "workspace_document_mutation_entries_restore_from_entry_fk" FOREIGN KEY ("restore_from_entry_id") REFERENCES "public"."workspace_document_mutation_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workspace_document_mutation_entries_history_artifact" ON "workspace_document_mutation_entries" USING btree ("artifact_internal_id","history_eligible","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_workspace_document_mutation_entries_redo" ON "workspace_document_mutation_entries" USING btree ("artifact_internal_id","restore_from_entry_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_workspace_document_mutations_agent_history" ON "workspace_document_mutations" USING btree ("agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_workspace_document_mutations_turn_history" ON "workspace_document_mutations" USING btree ("agent_id","turn_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entries" ADD CONSTRAINT "workspace_document_mutation_entries_history_operation_check" CHECK (length(trim("workspace_document_mutation_entries"."history_operation")) > 0);--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entries" ADD CONSTRAINT "workspace_document_mutation_entries_mime_type_check" CHECK ((
        ("workspace_document_mutation_entries"."before_mime_type" is null or length(trim("workspace_document_mutation_entries"."before_mime_type")) > 0) and
        ("workspace_document_mutation_entries"."after_mime_type" is null or length(trim("workspace_document_mutation_entries"."after_mime_type")) > 0) and
        (("workspace_document_mutation_entries"."before_mime_type" is null) = ("workspace_document_mutation_entries"."after_mime_type" is null))
      ));--> statement-breakpoint
ALTER TABLE "workspace_document_mutation_entries" ADD CONSTRAINT "workspace_document_mutation_entries_mime_update_only_check" CHECK ((
        "workspace_document_mutation_entries"."mutation_kind" = 'update' or
        ("workspace_document_mutation_entries"."before_mime_type" is null and "workspace_document_mutation_entries"."after_mime_type" is null)
      ));--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" ADD CONSTRAINT "workspace_document_mutations_editor_request_fingerprint_check" CHECK ("workspace_document_mutations"."editor_request_fingerprint" is null or "workspace_document_mutations"."editor_request_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "workspace_document_mutations" ADD CONSTRAINT "workspace_document_mutations_turn_id_check" CHECK ("workspace_document_mutations"."turn_id" is null or length(trim("workspace_document_mutations"."turn_id")) > 0);