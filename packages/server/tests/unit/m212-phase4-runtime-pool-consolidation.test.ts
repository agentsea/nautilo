/**
 * M212 Phase 4 — static guard for the explicit server runtime group.
 * Server-free: reads source only; no Postgres, no app boot.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER_SRC = join(import.meta.dir, "../../src");

const PHASE4_RUNTIME_FILES = [
  "routes/rooms.ts",
  // D539 moved the shared Admin/self-service destructive transaction out of
  // the route and into its canonical account-deletion service.
  "lib/user-account-deletion.ts",
  "lib/agent-room-authz.ts",
  "lib/relay-token-store.ts",
  "messaging/dispatch.ts",
  "messaging/await-resume.ts",
  "lib/redeem-invite.ts",
  "routes/setup.ts",
] as const;

const SHARED_DB_HANDLE = /\b(?:db|directDb|probeDb|gateDb|claimDb)\.end\s*\(/;

describe("M212 Phase 4 runtime pool consolidation (static guard)", () => {
  for (const rel of PHASE4_RUNTIME_FILES) {
    it(`${rel} uses getSharedDirectDb and owns no direct pools`, () => {
      const body = readFileSync(join(SERVER_SRC, rel), "utf8");
      expect(body).not.toMatch(/\bcreateDirectDb\b/);
      expect(body).toMatch(/getSharedDirectDb\s*\(\s*\)/);
      expect(body).not.toMatch(SHARED_DB_HANDLE);
    });
  }
});
