ALTER TABLE "memories" DROP CONSTRAINT "memories_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_agent_id_agents_id_fk";
--> statement-breakpoint
DROP INDEX "uniq_artifacts_agent_artifact_id";--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_artifacts_artifact_id" ON "artifacts" USING btree ("artifact_id");--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "artifacts" DROP COLUMN "agent_id";