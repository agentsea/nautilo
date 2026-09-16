import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const migrationTag = "0160_nasty_post";
const migration = readFileSync(resolve(migrations, `${migrationTag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; when: number; tag: string }[] };
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0160_snapshot.json"), "utf8"),
) as { tables: Record<string, { columns: Record<string, unknown> }> };

describe("M251 protected AgentScope close migration", () => {
  test("is generated, monotonic, current, additive, and data-preserving", () => {
    const entry = journal.entries.find((item) => item.idx === 160);
    const previous = journal.entries.find((item) => item.idx === 159);
    expect(entry).toMatchObject({ idx: 160, tag: migrationTag });
    expect(entry!.when).toBeGreaterThan(previous!.when);
    expect(entry!.when).toBeLessThanOrEqual(Date.now());
    expect(migration).not.toMatch(/^\s*(?:DELETE|UPDATE|INSERT)\b/im);
    expect(migration).not.toMatch(/\b(?:TRUNCATE|DROP TABLE|DROP COLUMN)\b/iu);
  });

  test("adds the open default before lifecycle coherence constraints", () => {
    expect(migration).toContain(
      'ADD COLUMN "lifecycle_state" text DEFAULT \'open\' NOT NULL',
    );
    expect(migration).toContain(
      'ADD COLUMN "revision" integer DEFAULT 0 NOT NULL',
    );
    expect(migration).toContain("agent_scopes_close_lifecycle_coherent");
  });

  test("contains only bounded content-free close operation and item state", () => {
    expect(snapshot.tables["public.agent_scope_close_operations"]).toBeDefined();
    expect(snapshot.tables["public.agent_scope_close_items"]).toBeDefined();
    expect(migration).toContain("captured_item_count\" between 0 and 256");
    expect(migration).toContain("attempt_count\" between 0 and 8");
    for (const forbidden of [
      "plaintext",
      "embedding_bytes",
      "private_key",
      "grant_bytes",
      "signed_request_bytes",
    ]) expect(migration).not.toContain(forbidden);
  });
});
