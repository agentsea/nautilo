import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const migrationTag = "0155_clear_stephen_strange";
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
  readFileSync(resolve(migrations, "meta/0155_snapshot.json"), "utf8"),
) as {
  tables: Record<string, {
    checkConstraints: Record<string, { value: string }>;
  }>;
};

describe("M243 protected Memory metadata-operation migration", () => {
  test("is generated, monotonic, current, and data-preserving", () => {
    const entry = journal.entries.find((item) => item.idx === 155);
    const previous = journal.entries.find((item) => item.idx === 154);

    expect(entry).toMatchObject({ idx: 155, tag: migrationTag });
    expect(entry!.when).toBeGreaterThan(previous!.when);
    expect(entry!.when).toBeLessThanOrEqual(Date.now());
    expect(migration).not.toMatch(/^\s*(?:DELETE|UPDATE|INSERT)\b/im);
    expect(migration).not.toMatch(/\b(?:TRUNCATE|DROP TABLE)\b/i);
  });

  test("permits replay-safe metadata mutations without advancing crypto revisions", () => {
    const shape = snapshot.tables["public.memory_crypto_operations"]!
      .checkConstraints["memory_crypto_operations_shape"]!.value;

    expect(shape).toContain("operation_type\" = 'metadata'");
    expect(shape).toContain("result_content_revision\" is null");
    expect(shape).toContain("result_access_revision\" is null");
    expect(migration).toContain(
      'ADD CONSTRAINT "memory_crypto_operations_shape"',
    );
  });
});
