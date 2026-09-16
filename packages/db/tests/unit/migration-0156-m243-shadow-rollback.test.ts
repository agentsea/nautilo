import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const migrationTag = "0156_gigantic_raza";
const migration = readFileSync(
  resolve(migrations, `${migrationTag}.sql`),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly { idx: number; when: number; tag: string }[];
};
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0156_snapshot.json"), "utf8"),
) as {
  tables: Record<string, {
    checkConstraints: Record<string, { value: string }>;
  }>;
};

describe("M243 Memory shadow rollback migration", () => {
  test("removes only the destructive constraint without touching data", () => {
    const entry = journal.entries.find((item) => item.idx === 156);
    const previous = journal.entries.find((item) => item.idx === 155);

    expect(entry).toMatchObject({ idx: 156, tag: migrationTag });
    expect(entry!.when).toBeGreaterThan(previous!.when);
    expect(entry!.when).toBeLessThanOrEqual(Date.now());
    expect(migration).not.toMatch(/^\s*(?:DELETE|UPDATE|INSERT)\b/im);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
  });

  test("permits mapped Memories to retain plaintext shadow columns", () => {
    const constraints = snapshot.tables["public.memories"]!.checkConstraints;

    expect(constraints).not.toHaveProperty(
      "memories_protected_mapping_clears_confidential_columns",
    );
    expect(migration).toContain(
      'DROP CONSTRAINT "memories_protected_mapping_clears_confidential_columns"',
    );
    expect(migration).not.toContain("__nautilo_encrypted_memory_v1__");
  });
});
