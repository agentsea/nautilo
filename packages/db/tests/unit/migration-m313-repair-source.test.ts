import {expect, test} from "bun:test";
import {finalizeM313RepairSourceMigration} from "../../scripts/finalize-m313-repair-source";

test("pending Tool source finalizer is scoped and idempotent", () => {
  const unrelated = 'ALTER TABLE "rooms" ADD COLUMN "example" text;';
  expect(finalizeM313RepairSourceMigration(unrelated)).toBe(unrelated);
  const generated = 'ALTER TABLE "session_message_crypto_revisions" ADD COLUMN "repair_source_digest" bytea;';
  const finalized = finalizeM313RepairSourceMigration(generated);
  expect(finalizeM313RepairSourceMigration(finalized)).toBe(finalized);
  expect(finalized).toContain("OLD.completion <> 'pending'");
  expect(finalized).toContain("NEW.repair_source_revision <= OLD.repair_source_revision");
  expect(finalized).toContain("current_user <> 'nautilo'");
});
