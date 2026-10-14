import { expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { roomJournalState } from "../../src/schema/room-journal";

test("a compaction retry exception requires positive invalid-output evidence", () => {
  const config = getTableConfig(roomJournalState);
  const check = config.checks.find((value) =>
    value.name === "room_journal_state_compaction_known_nonusable");
  expect(check).toBeDefined();
  const query = new PgDialect().sqlToQuery(check!.value).sql;
  // PostgreSQL accepts UNKNOWN CHECK results: equality alone allows NULL here.
  expect(query).toContain('"last_compaction_error_code" IS NOT NULL');
  expect(query).toContain('"last_compaction_error_code" = \'invalid_output\'');
  expect(query).toContain('"compaction_accepted_model_binding" IS NOT NULL');
  expect(query).toContain('"compaction_accepted_plan" IS NOT NULL');
  expect(query).toContain('"compaction_lease_token" IS NULL');
  expect(query).toContain('"compaction_lease_expires_at" IS NULL');
  expect(roomJournalState.compactionLastAttemptKnownNonusable.notNull).toBe(true);
});
