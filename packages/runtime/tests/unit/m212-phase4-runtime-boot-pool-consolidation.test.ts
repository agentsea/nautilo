/**
 * M212 Phase 4 — static guard for runtime/boot helpers migrated off
 * per-request `createDirectDb(1)` pools onto the process-wide full-role
 * `getSharedDirectDb()` handle.
 *
 * Server-free: reads source only; no Postgres, no app boot.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNTIME_SRC = join(import.meta.dir, "../../src");

const PHASE4_RUNTIME_BOOT_FILES = [
  "context/build-transcript-context-deps.ts",
  "tasks/resume-task-approval.ts",
] as const;

describe("M212 Phase 4 runtime/boot pool consolidation (static guard)", () => {
  for (const rel of PHASE4_RUNTIME_BOOT_FILES) {
    it(`${rel} uses getSharedDirectDb and never owns a direct pool`, () => {
      const source = readFileSync(join(RUNTIME_SRC, rel), "utf8");
      expect(source).toMatch(/getSharedDirectDb/);
      expect(source).not.toMatch(/\bcreateDirectDb\b/);
      expect(source).not.toMatch(/\bcreateDirectAgentDb\b/);
      expect(source).not.toMatch(/\bagentDb\b/);
      expect(source).not.toMatch(/\.end\s*\(/);
    });
  }
});
