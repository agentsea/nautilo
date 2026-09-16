import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0204_chemical_hobgoblin";
const migration = readFileSync(
  resolve(import.meta.dir, `../../src/migrations/${tag}.sql`),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../../src/migrations/meta/_journal.json"),
  "utf8",
)) as { entries: readonly { idx: number; tag: string }[] };

describe("0204 M295 Human-peer Shadow migration", () => {
  test("is the generated additive journal entry", () => {
    expect(journal.entries.find((entry) => entry.tag === tag))
      .toMatchObject({ idx: 204, tag });
    expect(migration).toContain(
      'ADD COLUMN "human_peer_shadow_operation_id" text',
    );
    expect(migration).not.toContain(
      'ADD COLUMN "human_peer_shadow_operation_id" text NOT NULL',
    );
    expect(migration).not.toContain("DROP TABLE");
  });

  test("creates the complete product-owned table family", () => {
    for (const table of [
      "conversation_human_peer_shadow_operations",
      "conversation_human_peer_shadow_acknowledgements",
      "conversation_human_peer_shadow_plan_attempts",
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(migration).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );
      expect(migration).toContain(
        `REVOKE ALL PRIVILEGES ON TABLE "${table}"`,
      );
    }
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "conversation_human_peer_shadow_operations"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "conversation_human_peer_shadow_acknowledgements"',
    );
    expect(migration).not.toContain('GRANT ALL');
  });

  test("protects operation and linked lifecycle identity", () => {
    expect(migration).toContain(
      'CREATE TRIGGER "conversation_human_peer_shadow_operations_protected"',
    );
    expect(migration).toContain(
      "NEW.human_peer_shadow_operation_id",
    );
    expect(migration).toContain(
      "OLD.human_peer_shadow_operation_id",
    );
    expect(migration).toContain(
      "Human-peer Shadow state transition is invalid",
    );
    expect(migration).toContain(
      'CONSTRAINT "session_message_crypto_revisions_human_peer_shape"',
    );
  });
});
