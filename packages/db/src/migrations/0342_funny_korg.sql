-- Repair only existing protected mappings already proven to belong to the
-- requester. A different key custodian needs explicit content repair; changing
-- an owner must never silently change or broaden the encrypted audience.
UPDATE "tasks" AS task
SET "owner_id" = task."requestor_id"
FROM "task_definition_crypto_revisions" AS revision
JOIN "actors" AS requester ON requester."id" = revision."requester_human_id"
WHERE task."content_representation" IN ('dual', 'protected')
  AND task."owner_id" <> task."requestor_id"
  AND revision."task_id" = task."id"
  AND revision."content_namespace_id" = task."content_namespace_id"
  AND revision."content_revision" = task."content_revision"
  AND revision."crypto_object_id" = task."crypto_object_id"
  AND revision."required_namespace_fingerprint" = task."crypto_required_namespace_fingerprint"
  AND revision."representation" = task."content_representation"
  AND revision."completion" = 'complete'
  AND revision."disposition" = 'mapped'
  AND requester."kind" = 'user'
  AND requester."owner_id" = task."requestor_id";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "tasks"
    WHERE "content_representation" IN ('dual', 'protected')
      AND "owner_id" <> "requestor_id"
  ) THEN
    RAISE EXCEPTION 'Protected Task ownership repair requires verified requester-bound content';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_protected_requester_owns_content" CHECK ("tasks"."content_representation" = 'ordinary' or "tasks"."owner_id" = "tasks"."requestor_id");
