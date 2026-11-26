import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../src/migrations/0389_memory_review_model_recovery_privileges.sql",
  ),
  "utf8",
);

describe("Memory review model-recovery privilege boundary", () => {
  test("removes direct runtime access while preserving the product role", () => {
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE "memory_review_model_recoveries"',
    );
    expect(migration).toContain(
      'FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).not.toMatch(/FROM[^;]*"nautilo"(?:\s|,|;)/u);
  });
});
