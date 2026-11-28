CREATE TABLE "memory_review_model_recoveries" (
	"work_id" uuid PRIMARY KEY NOT NULL,
	"head_turn_id" uuid NOT NULL,
	"authorized_by" uuid NOT NULL,
	"authorized_at" timestamp with time zone NOT NULL,
	"blocked_attempt_id" uuid NOT NULL,
	"turn_ids" uuid[] NOT NULL,
	"spent_at" timestamp with time zone,
	"recovery_attempt_id" uuid
);
--> statement-breakpoint
ALTER TABLE "memory_review_model_recoveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_review_model_recoveries" ADD CONSTRAINT "memory_review_model_recoveries_head_turn_id_memory_review_turns_id_fk" FOREIGN KEY ("head_turn_id") REFERENCES "public"."memory_review_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_review_model_recovery_head_idx" ON "memory_review_model_recoveries" USING btree ("head_turn_id");--> statement-breakpoint
CREATE POLICY "memory_review_model_recoveries_product" ON "memory_review_model_recoveries" AS PERMISSIVE FOR ALL TO "nautilo" USING (true) WITH CHECK (true);