ALTER TABLE "standing_approvals" ADD COLUMN "scope" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD COLUMN "signature" jsonb;--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD COLUMN "signature_key" text;--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD CONSTRAINT "standing_approvals_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_standing_approvals_lookup" ON "standing_approvals" USING btree ("created_by","scope","tool_pattern","signature_key");