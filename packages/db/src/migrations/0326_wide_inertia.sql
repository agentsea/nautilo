CREATE TABLE "task_run_message_associations" (
	"task_run_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" integer NOT NULL,
	"published_revision" integer NOT NULL,
	"kind" text NOT NULL,
	"publication_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_task_run_message_associations_message" UNIQUE("message_id"),
	CONSTRAINT "uq_task_run_message_associations_publication" UNIQUE("task_run_id","kind","publication_key"),
	CONSTRAINT "task_run_message_associations_kind_valid" CHECK ("task_run_message_associations"."kind" IN ('transcript', 'raw_delivery', 'wake')),
	CONSTRAINT "task_run_message_associations_message_positive" CHECK ("task_run_message_associations"."message_id" > 0),
	CONSTRAINT "task_run_message_associations_revision_nonnegative" CHECK ("task_run_message_associations"."published_revision" >= 0),
	CONSTRAINT "task_run_message_associations_publication_key_bounded" CHECK (octet_length("task_run_message_associations"."publication_key") between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "task_run_message_associations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_run_message_associations" ADD CONSTRAINT "task_run_message_associations_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_task_run_message_associations_run_kind_message" ON "task_run_message_associations" USING btree ("task_run_id","kind","message_id");--> statement-breakpoint
CREATE POLICY "task_run_message_associations_product_select" ON "task_run_message_associations" AS PERMISSIVE FOR SELECT TO "nautilo" USING (true);--> statement-breakpoint
CREATE POLICY "task_run_message_associations_product_insert" ON "task_run_message_associations" AS PERMISSIVE FOR INSERT TO "nautilo" WITH CHECK (true);
--> statement-breakpoint
-- TASK_EXECUTION_EVIDENCE_AUTHORITY
ALTER TABLE "task_run_message_associations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "task_run_message_associations" FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "task_run_message_associations" TO "nautilo";
