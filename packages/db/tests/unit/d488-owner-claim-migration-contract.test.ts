/** Guards the additive identified-half-bind migration used by D488 owner setup. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0146_d488_owner_claim_half_bind";
const SQL = readFileSync(resolve(MIGRATIONS, `${TAG}.sql`), "utf8");
const JOURNAL = JSON.parse(
  readFileSync(resolve(MIGRATIONS, "meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };

describe("D488 owner-claim migration contract", () => {
  test("has one stable journal identity", () => {
    expect(JOURNAL.entries.find((entry) => entry.idx === 146)).toMatchObject({ tag: TAG });
    expect(JOURNAL.entries.filter((entry) => entry.idx === 146 || entry.tag === TAG)).toHaveLength(1);
  });

  test("is additive and introduces only the identified half-bind foreign key", () => {
    expect(SQL).toContain('ADD COLUMN "half_redeemed_user_id" uuid');
    expect(SQL).toContain('FOREIGN KEY ("half_redeemed_user_id")');
    expect(SQL).toContain('REFERENCES "public"."users"("id") ON DELETE cascade');
    expect(SQL).not.toMatch(/\bDROP\b/i);
    expect(SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(SQL).not.toMatch(/\bUPDATE\s+"?[a-z_]+"?\s+SET\b/i);
  });
});
