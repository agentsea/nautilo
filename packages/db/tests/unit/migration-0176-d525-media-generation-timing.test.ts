import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0176_d525_media_generation_timing";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(readFileSync(resolve(migrations, "meta/_journal.json"), "utf8")) as {
  entries: readonly { idx: number; tag: string; when: number }[];
};

describe("D525 media generation timing migration", () => {
  test("is additive and persists only bounded public timing evidence", () => {
    const entryIndex = journal.entries.findIndex((entry) => entry.idx === 176 && entry.tag === tag);

    expect(entryIndex).toBeGreaterThanOrEqual(0);
    expect(journal.entries[entryIndex]).toMatchObject({ idx: 176, tag });
    expect(journal.entries[entryIndex + 1]).toMatchObject({
      idx: 177,
      tag: "0177_d525_media_reference_bindings",
    });
    expect(migration).toContain('ADD COLUMN "provider_execution_seconds" integer');
    expect(migration).toContain('ADD COLUMN "provider_average_execution_seconds" integer');
    expect(migration).toContain('"media_generations_provider_timing_nonnegative"');
    expect(migration).not.toMatch(/(?:provider_queue_id|download_url|signed_url|prompt|lyrics|api_key|authorization)/u);
  });
});
