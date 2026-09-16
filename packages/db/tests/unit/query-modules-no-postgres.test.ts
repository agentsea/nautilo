/**
 * M210 Phase 3 — static guard against hidden postgres-js pool construction
 * in the four consolidated query modules.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const QUERY_MODULES = ["jobs.ts", "llm-usage.ts", "skills.ts", "commands.ts"];

describe("query modules avoid direct postgres(...) construction (M210 Phase 3)", () => {
  for (const file of QUERY_MODULES) {
    it(`${file} does not import postgres or call postgres(...)`, () => {
      const source = readFileSync(
        join(import.meta.dir, "../../src/queries", file),
        "utf8",
      );
      expect(source).not.toMatch(/from\s+["']postgres["']/);
      expect(source).not.toMatch(/\bpostgres\s*\(/);
      expect(source).not.toMatch(/from\s+["']drizzle-orm\/postgres-js["']/);
      expect(source).toMatch(/getSharedDirectDb/);
    });
  }
});
