import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  agentPhotoSelectionRevisions,
  AGENT_PHOTO_SELECTION_ORIGIN,
  ownedPhotoEntries,
  OWNED_PHOTO_ORIGIN,
} from "../../src/schema";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const journal = JSON.parse(readFileSync(resolve(migrations, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string }>;
};
const tag = journal.entries.find((entry) => entry.idx === 141)?.tag;
if (!tag) throw new Error("D487 cli_setup origin migration 0141 is missing from the journal");
const sql = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const snapshot = readFileSync(resolve(migrations, "meta/0141_snapshot.json"), "utf8");

describe("D487 truthful CLI setup origin migration", () => {
  test("publishes cli_setup in the typed schema", () => {
    expect(OWNED_PHOTO_ORIGIN.CLI_SETUP).toBe("cli_setup");
    expect(AGENT_PHOTO_SELECTION_ORIGIN.CLI_SETUP).toBe("cli_setup");
    expect(getTableConfig(ownedPhotoEntries).checks.map((check) => check.name)).toContain(
      "owned_photo_entries_maintenance_origin_check",
    );
    expect(getTableConfig(agentPhotoSelectionRevisions).checks.map((check) => check.name)).toContain(
      "agent_photo_selection_revisions_origin_check",
    );
  });

  test("updates both origin constraints and the interactive-source rule", () => {
    expect(sql).toContain("agent_photo_selection_revisions_origin_check");
    expect(sql).toContain("owned_photo_entries_origin_check");
    expect(sql).toContain("owned_photo_entries_maintenance_origin_check");
    expect(sql.match(/'cli_setup'/g)?.length).toBe(3);
    expect(snapshot).toContain("'cli_setup'");
  });
});
