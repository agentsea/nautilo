ALTER TABLE "invites" ADD CONSTRAINT "invites_kind_chk"
  CHECK ("kind" IN ('claim', 'server', 'agent', 'room'));
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_agent_kind_chk"
  CHECK ("kind" IN ('claim', 'server') OR "target_agent_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_group_kind_chk"
  CHECK ("kind" IN ('claim', 'server') OR "target_group_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_room_kind_chk"
  CHECK ("kind" != 'room' OR "target_room_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_claim_creator_chk"
  CHECK (
    ("kind" = 'claim' AND "created_by" IS NULL)
    OR ("kind" != 'claim' AND "created_by" IS NOT NULL)
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invites_claim_unredeemed"
  ON "invites" ("kind")
  WHERE "kind" = 'claim' AND "used_count" = 0 AND "revoked_at" IS NULL;
