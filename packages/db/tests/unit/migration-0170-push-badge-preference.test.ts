import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0170_chunky_wong";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };
const previousSnapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0169_snapshot.json"), "utf8"),
) as { id: string };
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0170_snapshot.json"), "utf8"),
) as { prevId: string; id: string };

describe("iOS push badge preference migration", () => {
  test("remains chained after immutable history and before D525 media generations", () => {
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(journal.entries[index]).toMatchObject({ idx: 170, tag });
    expect(journal.entries[index + 1]).toMatchObject({
      idx: 171,
      tag: "0171_d525_media_generations",
    });
    expect(snapshot.prevId).toBe(previousSnapshot.id);
    expect(snapshot.id).not.toBe(snapshot.prevId);
  });

  test("adds only a conservative opt-in badge flag", () => {
    expect(migration.trim()).toBe(
      'ALTER TABLE "push_installation_bindings" ADD COLUMN "badge_enabled" boolean DEFAULT false NOT NULL;',
    );
  });
});
