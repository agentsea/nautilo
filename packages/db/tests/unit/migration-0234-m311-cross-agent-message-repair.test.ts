import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const tag = "0236_groovy_dark_phoenix";
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };

describe("M311 cross-Agent Message repair migration", () => {
  test("lets every current Room Agent observe the shared revision ledger", () => {
    expect(journal.entries.find((entry) => entry.tag === tag)?.idx).toBe(236);
    expect(migration).toContain(
      'ALTER POLICY "session_message_crypto_revisions_agent_select"',
    );
    expect(migration).toContain(
      'app_agent_in_room("session_message_crypto_revisions"."room_id")',
    );
  });

  test("keeps ordinary writes on the Session Agent while admitting explicit repairs", () => {
    expect(migration).toMatch(
      /"author_role" <> 'user'[\s\S]*?"sessions"\."agent_id" = app_current_agent_id\(\)[\s\S]*?or "session_message_crypto_revisions"\."repair_identity_digest" is not null/u,
    );
    expect(migration).toContain(
      'ALTER POLICY "session_message_crypto_revisions_agent_insert"',
    );
    expect(migration).toContain(
      'ALTER POLICY "session_message_crypto_revisions_agent_update"',
    );
  });

  test("changes policies only and does not mutate table shape", () => {
    expect(migration).not.toMatch(/ADD COLUMN|DROP COLUMN|ADD CONSTRAINT/u);
    expect(migration.match(/ALTER POLICY/gu)).toHaveLength(3);
  });
});
