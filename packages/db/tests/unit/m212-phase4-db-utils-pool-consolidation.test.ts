/**
 * M212 Phase 4 — static guard for db utility helpers migrated off
 * per-request `createDirectDb(1)` pools onto the process-wide full-role
 * `getSharedDirectDb()` handle.
 *
 * Server-free: reads source only; no Postgres, no app boot.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DB_UTILS = [
  "utils/rename-agent-profile-identity.ts",
  "utils/update-owner-name.ts",
  "utils/dedupe-membership-system-messages.ts",
] as const;

const SRC_DIR = join(import.meta.dir, "../../src");

describe("M212 Phase 4 db utils pool consolidation (static guard)", () => {
  for (const rel of DB_UTILS) {
    it(`${rel} uses getSharedDirectDb and never owns a direct pool`, () => {
      const source = readFileSync(join(SRC_DIR, rel), "utf8");
      expect(source).toMatch(/getSharedDirectDb/);
      expect(source).not.toMatch(/\bcreateDirectDb\b/);
      expect(source).not.toMatch(/\bcreateDirectAgentDb\b/);
      expect(source).not.toMatch(/\bagentDb\b/);
      expect(source).not.toMatch(/\.end\s*\(/);
    });
  }
});
