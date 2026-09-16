/**
 * D418 Wave 2 / Stack 193 — validates migration `0100_d418_system_managed_groups.sql`
 * and its journal entry at idx 100.
 *
 * Text-only assertions on the SQL (mirrors `migration-0099-d418-relay-token-installation-id.test.ts`
 * and `migration-0062-m128.test.ts`). Populated-DB + CHECK-constraint live coverage
 * is the sibling integration test `schema-invariants.test.ts` (requires a live
 * Postgres with migration 0100 applied).
 *
 * What this pins:
 *   - the system-managed discriminator column lands (NOT NULL DEFAULT false);
 *   - `owner_id` becomes nullable so system Groups can carry NULL;
 *   - the six canonical ladder Groups AND any `workstation_users` Group are
 *     stamped `is_system=true, owner_id=NULL`;
 *   - the `groups_system_owner_check` CHECK enforces exactly one valid state
 *     per row (system ⇔ NULL owner; user-managed ⇔ non-NULL owner);
 *   - the reserved `workstation-user` Role is stamped `is_system=true`;
 *   - statement order is safe around the NOT NULL / FK / CHECK constraints
 *     (ADD COLUMN → DROP NOT NULL → backfill UPDATE → ADD CHECK → role UPDATE).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0100_d418_system_managed_groups";
const M0100 = resolve(MIGRATIONS_DIR, `${TAG}.sql`);
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");
const SQL = readFileSync(M0100, "utf-8");

function find(needle: string): number {
  return SQL.toLowerCase().indexOf(needle.toLowerCase());
}

describe("D418 migration 0100 — journal", () => {
  test("journal references idx 100 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e100 = journal.entries.find((e) => e.idx === 100);
    expect(e100?.tag).toBe(TAG);
  });

  test("historical 0099 remains in the journal (additive, no renumber)", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e99 = journal.entries.find((e) => e.idx === 99);
    expect(e99?.tag).toBe("0099_relay_token_installation_id");
  });
});

describe("D418 migration 0100 — groups.is_system discriminator", () => {
  test("adds is_system boolean NOT NULL DEFAULT false", () => {
    expect(SQL).toContain(
      'ALTER TABLE "groups" ADD COLUMN "is_system" boolean NOT NULL DEFAULT false',
    );
  });

  test("drops NOT NULL on owner_id so system Groups can carry NULL", () => {
    expect(SQL).toContain(
      'ALTER TABLE "groups" ALTER COLUMN "owner_id" DROP NOT NULL',
    );
  });

  test("does not drop or alter unrelated groups columns/indexes", () => {
    expect(SQL).not.toMatch(/DROP\s+TABLE/i);
    expect(SQL).not.toMatch(/DROP\s+COLUMN/i);
    expect(SQL).not.toMatch(/DROP\s+INDEX/i);
  });
});

describe("D418 migration 0100 — canonical + workstation_users backfill", () => {
  test("stamps the six canonical ladder Groups is_system=true, owner_id=NULL", () => {
    for (const groupType of [
      "'owners'",
      "'admins'",
      "'superusers'",
      "'members'",
      "'contributors'",
      "'guests'",
    ]) {
      expect(SQL).toContain(groupType);
    }
  });

  test("includes the reserved workstation_users preset in the same backfill", () => {
    expect(SQL).toContain("'workstation_users'");
  });

  test("backfill UPDATE sets is_system=true AND owner_id=NULL together", () => {
    expect(SQL).toMatch(/UPDATE\s+"groups"\s+SET\s+"is_system"\s*=\s*true,\s*"owner_id"\s*=\s*NULL/i);
  });

  test("stamps the reserved workstation-user Role is_system=true", () => {
    expect(SQL).toMatch(/UPDATE\s+"roles"\s+SET\s+"is_system"\s*=\s*true\s+WHERE\s+"slug"\s*=\s*'workstation-user'/i);
  });
});

describe("D418 migration 0100 — groups_system_owner_check invariant", () => {
  test("adds the groups_system_owner_check CHECK constraint", () => {
    expect(SQL).toMatch(/ADD\s+CONSTRAINT\s+"groups_system_owner_check"\s+CHECK/i);
  });

  test("CHECK encodes: system ⇔ NULL owner; user-managed ⇔ non-NULL owner", () => {
    expect(SQL).toMatch(/"is_system"\s*=\s*true\s+AND\s+"owner_id"\s+IS\s+NULL/i);
    expect(SQL).toMatch(/"is_system"\s*=\s*false\s+AND\s+"owner_id"\s+IS\s+NOT\s+NULL/i);
  });

  test("CHECK add is guarded by a defensive DROP IF EXISTS (re-run safe)", () => {
    expect(SQL).toMatch(
      /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+"groups_system_owner_check"/i,
    );
  });
});

describe("D418 migration 0100 — statement order around NOT NULL / FK / CHECK", () => {
  test("ADD COLUMN is_system < DROP NOT NULL owner_id < backfill UPDATE < ADD CHECK", () => {
    const order: ReadonlyArray<readonly [string, string]> = [
      [
        'ALTER TABLE "groups" ADD COLUMN "is_system"',
        'ALTER TABLE "groups" ALTER COLUMN "owner_id" DROP NOT NULL',
      ],
      [
        'ALTER TABLE "groups" ALTER COLUMN "owner_id" DROP NOT NULL',
        'UPDATE "groups"',
      ],
      [
        'UPDATE "groups"',
        'ADD CONSTRAINT "groups_system_owner_check"',
      ],
    ];
    for (const [earlier, later] of order) {
      const a = find(earlier);
      const b = find(later);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThan(a);
    }
  });

  test("role is_system UPDATE may run after the groups CHECK (independent)", () => {
    const checkIdx = find('ADD CONSTRAINT "groups_system_owner_check"');
    const roleUpdateIdx = find('UPDATE "roles"');
    expect(roleUpdateIdx).toBeGreaterThan(0);
    // Both statements are independent; the role UPDATE must come after the
    // groups backfill (it is the last statement in the file).
    expect(roleUpdateIdx).toBeGreaterThan(checkIdx);
  });
});
