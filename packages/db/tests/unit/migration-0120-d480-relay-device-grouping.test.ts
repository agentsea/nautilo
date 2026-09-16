/** D480 — migration 0120 is additive and keeps legacy rows explicitly NULL. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const tag = "0120_d480_relay_device_grouping";
const sql = readFileSync(resolve(migrations, `${tag}.sql`), "utf-8");

describe("D480 migration 0120 — relay device grouping", () => {
  test("journal and snapshot track the named additive migration", () => {
    const journal = JSON.parse(readFileSync(resolve(migrations, "meta/_journal.json"), "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((entry) => entry.idx === 120)?.tag).toBe(tag);
    const snapshot = JSON.parse(readFileSync(resolve(migrations, "meta/0120_snapshot.json"), "utf-8")) as {
      tables: Record<string, { checkConstraints: Record<string, { value: string }> }>;
    };
    expect(snapshot.tables["public.relay_tokens"]?.checkConstraints[
      "relay_tokens_device_group_management_pair_check"
    ]?.value).toContain("device_group_id");
  });

  test("adds nullable group and opaque management columns with a paired-null invariant", () => {
    expect(sql).toContain('ADD COLUMN "device_group_id" uuid;');
    expect(sql).toContain('ADD COLUMN "device_management_id" text;');
    expect(sql).toContain('ADD CONSTRAINT "relay_tokens_device_group_management_pair_check" CHECK');
    expect(sql).toContain('"device_group_id" IS NULL AND "device_management_id" IS NULL');
    expect(sql).not.toMatch(/device_group_id" uuid NOT NULL/i);
  });

  test("indexes active caller-owned group and management lookups without destructive DDL", () => {
    expect(sql).toContain('"idx_relay_tokens_user_device_group_active"');
    expect(sql).toContain('"idx_relay_tokens_user_device_management_active"');
    expect(sql).toContain('"revoked_at" IS NULL');
    expect(sql).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)/i);
  });
});
