import { describe, expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  roomEventRollups,
  roomEvents,
  roomJournalBatches,
} from "../../src/schema/room-journal";

const PROVENANCE_COLUMNS = [
  "ordinary_fallback_reason",
  "ordinary_fallback_rebuild_generation",
  "ordinary_output_fingerprint",
] as const;

function checkSql(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
): string {
  const check = getTableConfig(table).checks.find((item) => item.name === name);
  expect(check).toBeDefined();
  return new PgDialect().sqlToQuery(check!.value).sql.replaceAll('"', "");
}

describe("M317 ordinary Stenographer fallback provenance schema", () => {
  test("keeps one coherent tuple on completed V2 batches and ordinary rollups", () => {
    for (const table of [roomJournalBatches, roomEventRollups]) {
      const names = getTableConfig(table).columns.map((column) => column.name);
      for (const name of PROVENANCE_COLUMNS) expect(names).toContain(name);
    }
    const batch = checkSql(
      roomJournalBatches,
      "room_journal_batches_ordinary_fallback_provenance",
    );
    expect(batch).toContain("status = 'completed'");
    expect(batch).toContain("observation_publication_version = 2");
    expect(batch).toContain("ordinary_fallback_rebuild_generation >= 0");
    expect(batch).toContain("ordinary_output_fingerprint) = 32");

    const rollup = checkSql(
      roomEventRollups,
      "room_event_rollups_ordinary_fallback_provenance",
    );
    expect(rollup).not.toContain("content IS NOT NULL");
    expect(rollup).not.toContain("crypto_object_id IS NULL");
    expect(rollup).toContain("ordinary_output_fingerprint) = 32");
    const eventColumns = getTableConfig(roomEvents).columns.map(
      (column) => column.name,
    );
    for (const name of PROVENANCE_COLUMNS) expect(eventColumns).not.toContain(name);
  });
});
