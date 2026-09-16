-- ISSUE-M076 Phase 5 — Drop legacy memories.namespace_id (M:N junction is canonical).
-- DOWN is unrecoverable: the column cannot be reconstructed from the junction alone.

BEGIN;

DROP INDEX IF EXISTS "idx_memories_namespace";

ALTER TABLE "memories" DROP COLUMN IF EXISTS "namespace_id";

COMMIT;
