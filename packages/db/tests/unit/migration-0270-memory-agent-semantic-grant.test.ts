import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(
    import.meta.dir,
    "../../src/migrations/0270_repair_memory_agent_semantic_grant.sql",
  ),
  "utf8",
);

describe("0270 Memory Agent semantic receipt authority", () => {
  test("grants only the new mutable receipt column", () => {
    expect(migration).toMatch(
      /GRANT UPDATE \("semantic_change_kind"\)\s+ON TABLE "memory_crypto_operations"\s+TO "nautilo_agent"/,
    );
    expect(migration).not.toMatch(/GRANT UPDATE ON TABLE/u);
    expect(migration).not.toMatch(/GRANT (?:ALL|DELETE|TRUNCATE)/u);
  });
});
