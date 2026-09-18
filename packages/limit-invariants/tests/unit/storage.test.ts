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

describe("local limit audit storage", () => {
  test("uses one ignored suffix for every private evidence and report file", () => {
    expect(Object.values(LIMIT_AUDIT_FILENAMES).every((name) => name.includes(".limit-audit."))).toBe(true);
    const paths = limitAuditPaths("/workspace/packages/limit-invariants");
    expect(paths.inventory).toBe("/workspace/packages/limit-invariants/baseline/limit-inventory.limit-audit.jsonl");
    expect(paths.matrix).toBe("/workspace/packages/limit-invariants/generated/limit-matrix.limit-audit.md");
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
      expect((failure as Error).message).toContain("Missing local inventory audit evidence");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
