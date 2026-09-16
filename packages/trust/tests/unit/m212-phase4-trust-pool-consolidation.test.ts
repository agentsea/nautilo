/**
 * M212 Phase 4 — static guard for trust runtime helpers migrated off
 * per-request `createDirectDb(1)` pools onto the process-wide full-role
 * `getSharedDirectDb()` handle.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TRUST_RUNTIME_MODULES = [
  "recovery-codes.ts",
  "command-approvals.ts",
  "read-state.ts",
  "challenge.ts",
  "membership.ts",
  "message-delete.ts",
  "memory-cascade.ts",
] as const;

const SRC_DIR = join(import.meta.dir, "../../src");

describe("M212 Phase 4 — trust runtime pool consolidation", () => {
  for (const file of TRUST_RUNTIME_MODULES) {
    it(`${file} uses getSharedDirectDb and never owns a direct pool`, () => {
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      expect(source).toMatch(/getSharedDirectDb/);
      expect(source).not.toMatch(/\bcreateDirectDb\b/);
      expect(source).not.toMatch(/\bcreateDirectAgentDb\b/);
      expect(source).not.toMatch(/\bagentDb\b/);
      expect(source).not.toMatch(/\.end\s*\(/);
    });
  }
});
