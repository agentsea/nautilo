-- M132: enforce Profile↔Agent 1:1. profiles becomes agent-keyed.
-- Ownership of a personal Agent is the actors mirror:
--   actors.owner_id = users.id AND actors.kind = 'agent'.
-- See entity-model/relationships/REL-AGT-HUM.md (corrected in this issue).

-- 1. Add nullable first so existing rows survive.
ALTER TABLE "profiles" ADD COLUMN "agent_id" uuid;--> statement-breakpoint

-- 2. Backfill from the Actor mirror — oldest agent the user owns.
UPDATE "profiles" p
SET "agent_id" = sub.agent_id
FROM (
  SELECT DISTINCT ON (a.owner_id) a.owner_id, a.agent_id, ag.created_at
  FROM "actors" a
  JOIN "agents" ag ON ag.id = a.agent_id
  WHERE a.kind = 'agent' AND a.agent_id IS NOT NULL
  ORDER BY a.owner_id, ag.created_at ASC
) sub
WHERE p."user_id" = sub.owner_id;--> statement-breakpoint

-- 3. Delete orphan profiles (user has no agent — operator-CLI residue).
--    These cannot satisfy NOT NULL; the canonical model says a
--    non-federated user always has an agent, so an agent-less profile
--    is corrupt state.
DELETE FROM "profiles" WHERE "agent_id" IS NULL;--> statement-breakpoint

-- 4. Enforce the invariants.
ALTER TABLE "profiles" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 5. Swap the user_id index from UNIQUE to plain, add UNIQUE(agent_id).
DROP INDEX "idx_profiles_user_id";--> statement-breakpoint
CREATE INDEX "idx_profiles_user_id" ON "profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_profiles_agent_id" ON "profiles" USING btree ("agent_id");
