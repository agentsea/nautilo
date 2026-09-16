/**
 * M066 — validates migrations `0028_m066_invites.sql` and
 * `0029_m066_invites_constraints.sql` plus journal entries.
 *
 * Originally allocated to 0026/0027, the M066 migrations were renamed
 * to 0028/0029 when main's D104 logto-account-security migrations
 * (0026, 0027) merged in ahead of this branch.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const M028 = resolve(MIGRATIONS_DIR, "0028_m066_invites.sql");
const M029 = resolve(MIGRATIONS_DIR, "0029_m066_invites_constraints.sql");
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");

describe("M066 invites migrations", () => {
  test("0028 creates invites table with FK columns", () => {
    const sql = readFileSync(M028, "utf-8");
    expect(sql).toContain('CREATE TABLE "invites"');
    expect(sql).toMatch(/"token_hash"\s+text\s+NOT NULL/i);
    expect(sql).toMatch(/"kind"\s+text\s+NOT NULL/i);
    expect(sql).toMatch(/uq_invites_token_hash/i);
    expect(sql).toMatch(/idx_invites_created_by/i);
  });

  test("0029 adds CHECK constraints and partial unique index", () => {
    const sql = readFileSync(M029, "utf-8");
    expect(sql).toContain("invites_kind_chk");
    expect(sql).toContain("invites_claim_creator_chk");
    expect(sql).toContain("uq_invites_claim_unredeemed");
  });

  test("journal references M066 migrations at idx 28 and 29", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const e28 = journal.entries.find((e) => e.idx === 28);
    const e29 = journal.entries.find((e) => e.idx === 29);
    expect(e28?.tag).toBe("0028_m066_invites");
    expect(e29?.tag).toBe("0029_m066_invites_constraints");
  });
});
