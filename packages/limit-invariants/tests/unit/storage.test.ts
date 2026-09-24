import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLimitAuditDirectories,
  LIMIT_AUDIT_FILENAMES,
  limitAuditPaths,
  readRequiredLimitAudit,
} from "../../src/node/storage";

describe("tracked limit audit storage", () => {
  test("uses stable visible names for canonical evidence and reports", () => {
    expect(Object.values(LIMIT_AUDIT_FILENAMES).every((name) => !name.includes(".limit-audit."))).toBe(true);
    const paths = limitAuditPaths("/workspace/packages/limit-invariants");
    expect(paths.inventory).toBe("/workspace/packages/limit-invariants/baseline/limit-inventory.jsonl");
    expect(paths.matrix).toBe("/workspace/packages/limit-invariants/generated/limit-matrix.md");
  });

  test("creates only the familiar local directories and fails closed when evidence is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "limit-audit-storage-"));
    try {
      const paths = limitAuditPaths(root);
      await ensureLimitAuditDirectories(paths);
      let failure: unknown;
      try {
        await readRequiredLimitAudit(paths.inventory, "inventory");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("Missing tracked inventory audit evidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
