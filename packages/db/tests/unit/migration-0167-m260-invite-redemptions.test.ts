import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const migrationTag = "0167_jazzy_jocasta";
const migration = readFileSync(
  resolve(migrations, `${migrationTag}.sql`),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };

describe("M260 per-Human Invite redemption migration", () => {
  test("is generator-registered after the previous immutable migration", () => {
    expect(journal.entries.find((entry) => entry.idx === 167)).toMatchObject({
      idx: 167,
      tag: migrationTag,
    });
    expect(Bun.file(resolve(migrations, "meta/0166_snapshot.json")).size).toBeGreaterThan(0);
  });

  test("creates only the minimal per-Human coordination record", () => {
    expect(migration).toContain('CREATE TABLE "invite_redemptions"');
    expect(migration).toContain('PRIMARY KEY("invite_id","user_id")');
    expect(migration).toContain('"bound_at" timestamp DEFAULT now() NOT NULL');
    expect(migration).toContain('"completed_at" timestamp');
    expect(migration).not.toMatch(/status|lease|token_hash|external_id/i);
  });

  test("backfills live and completed singleton evidence idempotently", () => {
    expect(migration).toContain('INSERT INTO "invite_redemptions"');
    expect(migration).toContain('"half_redeemed_user_id"');
    expect(migration).toContain('WHEN "half_redeemed_at" IS NULL AND "used_count" > 0');
    expect(migration).toContain('ON CONFLICT ("invite_id", "user_id") DO NOTHING');
  });

  test("retains the legacy Invite columns for application rollback", () => {
    expect(migration).not.toMatch(/DROP\s+COLUMN/i);
    expect(migration).not.toMatch(/ALTER\s+COLUMN/i);
  });
});
