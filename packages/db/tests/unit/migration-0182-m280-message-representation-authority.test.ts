import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const tag = "0182_moaning_mystique";
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };

describe("M280 existing Message representation authority migration", () => {
  test("separates Human client verification from immutable author role", () => {
    const entry = journal.entries.find(({ tag: entryTag }) => entryTag === tag);
    expect(entry?.idx).toBe(182);
    expect(migration).toContain(
      'DROP CONSTRAINT "session_message_crypto_revisions_parity_author_coherent"',
    );
    expect(migration).toContain(
      '"session_message_crypto_revisions"."parity_status" = \'client_verified\'',
    );
    expect(migration).not.toMatch(
      /parity_status" = 'client_verified'[\s\S]*?author_role" = 'user'/u,
    );
  });

  test("retains the Agent/server authority boundary and changes no other table", () => {
    expect(migration).toMatch(
      /parity_status" = 'server_verified'[\s\S]*?author_role" <> 'user'[\s\S]*?key_class" = 'ai'/u,
    );
    expect(migration.match(/ALTER TABLE/gu)).toHaveLength(2);
    expect(migration).not.toContain("crypto_grants");
    expect(migration).not.toContain("agent_crypto_runtime");
    expect(migration).not.toContain("session_messages\" ADD");
  });
});
