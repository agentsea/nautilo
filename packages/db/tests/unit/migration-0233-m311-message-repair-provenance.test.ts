import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const tag = "0235_misty_garia";
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };

describe("M311 Message repair provenance migration", () => {
  test("adds publisher-neutral repair identity and coherent winning evidence", () => {
    expect(journal.entries.find((entry) => entry.tag === tag)?.idx).toBe(235);
    expect(migration).toContain('ADD COLUMN "repair_identity_digest"');
    expect(migration).toContain('ADD COLUMN "repair_publisher_kind"');
    expect(migration).toContain('ADD COLUMN "repair_publisher_id"');
    expect(migration).toContain('ADD COLUMN "repair_attestation_digest"');
    expect(migration).toContain(
      '"repair_publisher_kind" in (\'foreground_runtime\', \'human_device\')',
    );
  });

  test("permits server parity for a Human message only with Runtime repair evidence", () => {
    expect(migration).toMatch(
      /parity_status" = 'server_verified'[\s\S]*?key_class" = 'ai'[\s\S]*?author_role" <> 'user'[\s\S]*?repair_publisher_kind" = 'foreground_runtime'/u,
    );
    expect(migration).toContain(
      '"author_role" <> \'user\'\n      or "session_message_crypto_revisions"."repair_identity_digest" is not null',
    );
    expect(migration).toContain(
      'GRANT UPDATE (\n  "repair_publisher_kind",\n  "repair_publisher_id",\n  "repair_attestation_digest"',
    );
  });

  test("changes only the existing Message lifecycle table and its policies", () => {
    const alteredTables = [...migration.matchAll(/ALTER TABLE "([^"]+)"/gu)]
      .map((match) => match[1]);
    expect(new Set(alteredTables)).toEqual(
      new Set(["session_message_crypto_revisions"]),
    );
    expect(migration).not.toContain('session_messages" ADD');
    expect(migration).not.toContain('memory_crypto_revisions" ADD');
  });
});
