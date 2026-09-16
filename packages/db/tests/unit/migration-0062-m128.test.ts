/**
 * M128 — validates migration `0062_m128_groups_server_wide.sql` and
 * journal entry at idx 62.
 *
 * Checks the server-wide Group and Role constraints encoded in the migration.
 *
 * Text-only assertions on the SQL — populated-DB integration coverage
 * is its sibling integration test (runs against a scratch instance and
 * requires operator permission to apply).
 *
 * Why text-only at the unit tier: per coordinator rules, unit tests
 * must be independent of any DB/server. The SQL text inspection still
 * catches every B1-class bug — the original B1 ("AND EXISTS (SELECT 1
 * FROM roles WHERE slug = canonical.role_slug)" guard silently dropped
 * household + teammate memberships on populated pre-M128 DBs) was a
 * pure SQL-shape mistake. This test pins the corrected shape.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const M0062 = resolve(MIGRATIONS_DIR, "0062_m128_groups_server_wide.sql");
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");

const SQL = readFileSync(M0062, "utf-8");

// Helper: case-insensitive locate of a substring; returns the first
// index or -1. Tests use this to assert ordering across statements.
function find(needle: string): number {
  return SQL.toLowerCase().indexOf(needle.toLowerCase());
}

describe("M128 migration 0062 — journal", () => {
  test("journal references 0062 at idx 62", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e62 = journal.entries.find((e) => e.idx === 62);
    expect(e62?.tag).toBe("0062_m128_groups_server_wide");
  });
});

describe("M128 migration 0062 — B1 fix: ladder roles seeded up-front", () => {
  test("step 0 INSERTs the 6 M128 ladder roles before any groups statement", () => {
    const insertRolesIdx = find('INSERT INTO "roles"');
    const insertGroupsIdx = find('INSERT INTO "groups"');
    expect(insertRolesIdx).toBeGreaterThanOrEqual(0);
    expect(insertGroupsIdx).toBeGreaterThan(insertRolesIdx);
  });

  test("step 0 covers all 6 ladder slugs (owner / admin / superuser / member / contributor / guest)", () => {
    // Restrict to the chunk before the first groups INSERT so we don't
    // accidentally match a slug literal that appears later in mapping cases.
    const insertGroupsIdx = find('INSERT INTO "groups"');
    const head = SQL.slice(0, insertGroupsIdx);
    for (const slug of [
      "'owner'",
      "'admin'",
      "'superuser'",
      "'member'",
      "'contributor'",
      "'guest'",
    ]) {
      expect(head).toContain(slug);
    }
  });

  test("step 0 is idempotent (ON CONFLICT (slug) DO NOTHING on roles)", () => {
    const insertGroupsIdx = find('INSERT INTO "groups"');
    const head = SQL.slice(0, insertGroupsIdx);
    expect(head).toMatch(/ON CONFLICT \(slug\) DO NOTHING/i);
  });

  test("retired guard 'EXISTS (SELECT 1 FROM \"roles\" ...)' is gone (B1 regression guard)", () => {
    // Use a regex tolerant of whitespace/case but pinned to the role-existence guard.
    expect(SQL).not.toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+"roles"\s+WHERE\s+slug\s*=\s*canonical\.role_slug/i);
  });
});

describe("M128 migration 0062 — canonical Groups INSERT shape", () => {
  test("seeds the 6 canonical Groups", () => {
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

  test("owner_id COALESCEs admin → first user (handles pre-bootstrap)", () => {
    expect(SQL).toMatch(/COALESCE\s*\(\s*\(SELECT\s+id\s+FROM\s+"users"\s+WHERE\s+server_role\s*=\s*'admin'/i);
  });

  test("guards INSERT against fresh empty-users DB", () => {
    expect(SQL).toMatch(/AND\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+"users"\s*\)/i);
  });
});

describe("M128 migration 0062 — agent_* group membership collapse mapping", () => {
  test("agent_ownership → owners", () => {
    expect(SQL).toMatch(/'agent_ownership'\s+THEN\s+'owners'/i);
  });

  test("agent_household → members", () => {
    expect(SQL).toMatch(/'agent_household'\s+THEN\s+'members'/i);
  });

  test("agent_teammate → members (signed off 2026-05-28 — not contributors)", () => {
    expect(SQL).toMatch(/'agent_teammate'\s+THEN\s+'members'/i);
  });

  test("agent_guest → guests", () => {
    expect(SQL).toMatch(/'agent_guest'\s+THEN\s+'guests'/i);
  });

  test("group_members collapse dedupes via ON CONFLICT (group_id, user_id) DO NOTHING", () => {
    expect(SQL).toMatch(/INSERT INTO "group_members"[\s\S]*?ON CONFLICT \(group_id,\s*user_id\) DO NOTHING/i);
  });
});

describe("M128 migration 0062 — invites repoint shape", () => {
  test("UPDATE invites SET kind='group' touches the kind column", () => {
    expect(SQL).toMatch(/UPDATE "invites" SET[\s\S]*?kind\s*=\s*'group'/i);
  });

  test("invites repoint uses the agent_* → canonical mapping (NOT display_name heuristic)", () => {
    // Repoint mapping cases mirror the membership collapse mapping.
    const updateIdx = find('UPDATE "invites" SET');
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    const updateBody = SQL.slice(updateIdx);
    expect(updateBody).toMatch(/'agent_ownership'\s+THEN\s+'owners'/i);
    expect(updateBody).toMatch(/'agent_household'\s+THEN\s+'members'/i);
    expect(updateBody).toMatch(/'agent_teammate'\s+THEN\s+'members'/i);
    expect(updateBody).toMatch(/'agent_guest'\s+THEN\s+'guests'/i);
    expect(updateBody).not.toMatch(/display_name/i);
  });

  test("B12 invariant — repoint subquery joins on invite's OLD target_group_id, NOT target_agent_id", () => {
    // The role-specific per-Agent group is encoded in `target_group_id`
    // (CHECK `invites_group_kind_chk` requires non-NULL on kind='agent'
    // rows). Joining on `target_agent_id` returns all 4 per-Agent groups
    // for that agent — LIMIT 1 picks arbitrarily and the household /
    // teammate / guest invites get the wrong canonical target.
    const updateIdx = find('UPDATE "invites" SET');
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    const updateBody = SQL.slice(updateIdx);
    expect(updateBody).toMatch(/WHERE\s+old\.id\s*=\s*i\.target_group_id/i);
    expect(updateBody).not.toMatch(/WHERE\s+old\.agent_id\s*=\s*i\.target_agent_id/i);
  });

  test("B11 invariant — invites_kind_chk widened to accept 'group'; invites_agent_kind_chk dropped", () => {
    // Pre-M128 the kind CHECK was {claim, server, agent, room}; step 3's
    // UPDATE to kind='group' would violate it. Migration step 2.5
    // widens the CHECK + drops invites_agent_kind_chk which referenced
    // the about-to-be-dropped `target_agent_id` column.
    expect(SQL).toMatch(/ADD CONSTRAINT "invites_kind_chk"\s+CHECK\s*\(\s*"kind"\s+IN\s*\([^)]*'group'/i);
    expect(SQL).toMatch(/DROP CONSTRAINT IF EXISTS "invites_agent_kind_chk"/i);
  });

  test("defensive fallback repoints any unmapped kind='agent' invite to 'members'", () => {
    expect(SQL).toMatch(/UPDATE "invites" SET[\s\S]*?kind\s*=\s*'group'[\s\S]*?'members'/i);
  });
});

describe("M128 migration 0062 — statement order invariants", () => {
  test("roles INSERT < groups INSERT < group_members INSERT < invites UPDATE < DELETE agent_* < column drops", () => {
    const order: ReadonlyArray<readonly [string, string]> = [
      ['INSERT INTO "roles"', 'INSERT INTO "groups"'],
      ['INSERT INTO "groups"', 'INSERT INTO "group_members"'],
      ['INSERT INTO "group_members"', 'UPDATE "invites" SET'],
      ['UPDATE "invites" SET', 'DELETE FROM "groups" WHERE agent_id IS NOT NULL'],
      ['DELETE FROM "groups" WHERE agent_id IS NOT NULL', 'DROP COLUMN "agent_id"'],
      ['DROP COLUMN "agent_id"', 'DROP COLUMN "target_agent_id"'],
    ];
    for (const [earlier, later] of order) {
      const a = find(earlier);
      const b = find(later);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThan(a);
    }
  });
});

describe("M128 migration 0062 — final schema shape", () => {
  test("drops groups.agent_id column", () => {
    expect(SQL).toMatch(/ALTER TABLE "groups" DROP COLUMN "agent_id"/i);
  });

  test("drops groups FK to agents", () => {
    expect(SQL).toMatch(/DROP CONSTRAINT "groups_agent_id_agents_id_fk"/i);
  });

  test("drops invites.target_agent_id column", () => {
    expect(SQL).toMatch(/ALTER TABLE "invites" DROP COLUMN "target_agent_id"/i);
  });

  test("drops invites FK to agents", () => {
    expect(SQL).toMatch(/DROP CONSTRAINT "invites_target_agent_id_agents_id_fk"/i);
  });

  test("drops legacy partial-unique index uq_groups_agent_id_type", () => {
    expect(SQL).toMatch(/DROP INDEX "uq_groups_agent_id_type"/i);
  });

  test("creates UNIQUE INDEX on groups.type (one row per canonical slug)", () => {
    expect(SQL).toMatch(/CREATE UNIQUE INDEX "uq_groups_type" ON "groups"[\s\S]*?\("type"\)/i);
  });
});
