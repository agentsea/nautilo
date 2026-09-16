ALTER TABLE "memories" DROP CONSTRAINT "memories_owner_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_memories_owner_persona_tier";--> statement-breakpoint
CREATE INDEX "idx_memories_tier_created" ON "memories" USING btree ("tier","created_at");--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "persona_id";