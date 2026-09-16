import {describe, expect, test} from "bun:test";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";

const source = readFileSync(new URL("../../scripts/finalize-m258-reflection-authority.ts", import.meta.url), "utf8");

describe("M327 canonical authority receipt finalizer", () => {
  test("updates only a new additive migration and is idempotent while preserving applied history", () => {
    const directory = mkdtempSync(join(tmpdir(), "m327-authority-finalizer-"));
    try {
      mkdirSync(join(directory, "scripts")); mkdirSync(join(directory, "src/migrations"), {recursive: true});
      const script = join(directory, "scripts/finalize.ts"); writeFileSync(script, source);
      const old = 'CREATE TABLE "reflection_record_authority_projections" ();\n-- M258 REFLECTION AUTHORITY SECURITY FINALIZER\n';
      const additive = 'ALTER TABLE "reflection_record_authority_reconciliations" ADD COLUMN "target_access_namespace_ids" text[];\n';
      const oldPath = join(directory, "src/migrations/0163_existing.sql"), nextPath = join(directory, "src/migrations/0200_additive.sql");
      writeFileSync(oldPath, old); writeFileSync(nextPath, additive);
      const run = () => spawnSync(process.execPath, [script], {encoding: "utf8"});
      expect(run().status).toBe(0);
      expect(readFileSync(oldPath, "utf8")).toBe(old);
      const generated = readFileSync(nextPath, "utf8");
      expect(generated).toContain("M327 REFLECTION AUTHORITY RECEIPT AUGMENTATION FINALIZER");
      expect(generated).toContain('CREATE OR REPLACE FUNCTION "public"."reflection_authority_guard_reconciliation_mutation"()');
      expect(generated).not.toContain("CREATE TRIGGER");
      expect(generated).toContain("augmenting := OLD.state = 'complete' AND OLD.target_crypto_object_id IS NULL");
      expect(generated).toContain("NEW.state = 'quarantined'\n        AND NEW.target_access_namespace_ids IS NULL\n        AND NEW.target_audience_set_commitment IS NULL");
      expect(generated).toContain("OLD.completed_at IS NOT DISTINCT FROM NEW.completed_at");
      expect(generated).toContain("OLD.target_access_namespace_ids IS DISTINCT FROM NEW.target_access_namespace_ids");
      expect(generated).toContain("OLD.state = 'quarantined' AND NEW.state = 'pending' AND OLD.target_crypto_object_id IS NULL");
      expect(generated).toContain("checkpoint_pause := OLD.state = 'leased'\n    AND NEW.state = 'pending'");
      expect(generated).toContain("NEW.failure_code IS NULL\n    AND NEW.sealed_checkpoint IS NOT NULL");
      expect(generated).toContain("NEW.completed_at IS NULL\n    AND NEW.attempt_count = OLD.attempt_count - 1");
      expect(generated).toContain("NEW.attempt_count < OLD.attempt_count AND NOT checkpoint_pause");
      expect(run().status).toBe(0); expect(readFileSync(nextPath, "utf8")).toBe(generated);
    } finally {rmSync(directory, {recursive: true, force: true});}
  });
});
