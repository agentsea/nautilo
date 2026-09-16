import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0177_d525_media_reference_bindings";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(readFileSync(resolve(migrations, "meta/_journal.json"), "utf8")) as {
  entries: readonly { idx: number; tag: string }[];
};
const previousSnapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0174_snapshot.json"), "utf8"),
) as { id: string };
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0177_snapshot.json"), "utf8"),
) as {
  id: string;
  prevId: string;
  tables: Record<string, { columns: Record<string, unknown> }>;
};

describe("D525 reference binding migration", () => {
  test("extends only closed internal receipt JSON", () => {
    expect(journal.entries.find((entry) => entry.idx === 177)).toMatchObject({
      idx: 177,
      tag,
    });
    expect(journal.entries.find((entry) => entry.idx === 178)).toMatchObject({
      idx: 178,
      tag: "0178_d537_server_reasoning_policy",
    });
    expect(migration).toContain("referenceImageCount");
    expect(migration).toContain("referenceImages");
    expect(migration).not.toMatch(/(?:reference_image_urls|data:image|referenceImageUrls)/u);
  });

  test("preserves the generated snapshot chain for the historical migration", () => {
    expect(snapshot.prevId).toBe(previousSnapshot.id);
    expect(snapshot.id).not.toBe(snapshot.prevId);
    const columns = Object.keys(snapshot.tables["public.media_generations"]!.columns);
    for (const column of [
      "initiating_agent_id",
      "initiating_thread_id",
      "provider_execution_seconds",
      "provider_average_execution_seconds",
      "completion_wake_claimed_at",
      "completion_wake_delivered_at",
    ]) {
      expect(columns).toContain(column);
    }
  });
});
