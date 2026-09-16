-- D104 Phase 4 — separate PIN recovery codes from Logto account recovery codes.
ALTER TABLE "recovery_codes" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'pin' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_recovery_codes_user_used";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recovery_codes_user_purpose_used" ON "recovery_codes" USING btree ("user_id","purpose","used");
