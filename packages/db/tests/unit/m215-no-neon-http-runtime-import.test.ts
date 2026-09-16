/**
 * ISSUE-M215 — runtime DB construction must not import the retired Neon HTTP
 * driver or the removed local-proxy wrapper. Static guard only; no Postgres.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const CONFIG_DIR = join(import.meta.dir, "../../src/config");

const RUNTIME_DB_SOURCES = readdirSync(CONFIG_DIR)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join(CONFIG_DIR, name));

describe("M215 — no Neon HTTP runtime imports in db config", () => {
  for (const filePath of RUNTIME_DB_SOURCES) {
    it(`${filePath.split("/").pop()} does not import @neondatabase/serverless or neon-local-proxy`, () => {
      const source = readFileSync(filePath, "utf8");
      expect(source).not.toMatch(/@neondatabase\/serverless/);
      expect(source).not.toMatch(/neon-local-proxy/);
      expect(source).not.toMatch(/\bconfigureNeonLocalProxy\b/);
    });
  }
});
