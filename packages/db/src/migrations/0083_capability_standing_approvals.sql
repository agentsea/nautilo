ALTER TABLE "standing_approvals" ADD COLUMN "approval_kind" text DEFAULT 'tool' NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD COLUMN "capability_slug" text;--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD COLUMN "session_id" text;--> statement-breakpoint
CREATE INDEX "idx_standing_approvals_capability_lookup" ON "standing_approvals" USING btree ("created_by","scope","approval_kind","capability_slug");
