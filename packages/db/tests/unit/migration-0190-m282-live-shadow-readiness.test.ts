import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { M282_LIVE_SHADOW_FOLLOWUP_AUTHORITY_MARKER } from
  "../../scripts/finalize-m282-live-shadow-encryption";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const journal = JSON.parse(readFileSync(
  resolve(migrations, "meta/_journal.json"),
  "utf8",
)) as { entries: readonly { tag: string }[] };
const entry = journal.entries.find((candidate) => candidate.tag.startsWith("0190_"));
if (entry === undefined) throw new Error("M282 follow-up migration is absent");
const migration = readFileSync(resolve(migrations, `${entry.tag}.sql`), "utf8");

describe("M282 generated live Shadow readiness migration", () => {
  test("adds only turn signer and retry-idempotent plan attempt state", () => {
    expect(entry.tag).toBe("0190_nostalgic_dragon_man");
    expect(migration).toContain(
      'CREATE TABLE "conversation_shadow_turn_agent_signers"',
    );
    expect(migration).toContain(
      'CREATE TABLE "conversation_shadow_turn_plan_attempts"',
    );
    expect(migration).toContain(M282_LIVE_SHADOW_FOLLOWUP_AUTHORITY_MARKER);
    expect(migration).toContain(
      'ALTER TABLE "conversation_shadow_turn_plan_attempts" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).not.toContain(
      'ALTER TABLE "conversation_shadow_turn_operations" ADD COLUMN',
    );
    expect(migration).not.toContain("plaintext");
    expect(migration).not.toContain("ciphertext");
  });
});
