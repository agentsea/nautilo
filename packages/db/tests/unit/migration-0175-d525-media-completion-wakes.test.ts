import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationUrl = new URL("../../src/migrations/0175_d525_media_completion_wakes.sql", import.meta.url);
const journalUrl = new URL("../../src/migrations/meta/_journal.json", import.meta.url);

describe("D525 media completion wake migration", () => {
  test("binds the exact initiating Genie/thread and a retryable delivery outbox", async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), "utf8");
    expect(sql).toContain('ADD COLUMN "initiating_agent_id" uuid');
    expect(sql).toContain('ADD COLUMN "initiating_thread_id" text');
    expect(sql).toContain('REFERENCES "public"."agents"("id") ON DELETE restrict');
    expect(sql).toContain('ADD COLUMN "completion_wake_claimed_at"');
    expect(sql).toContain('ADD COLUMN "completion_wake_delivered_at"');
    expect(sql).toContain('idx_media_generations_completion_wake_due');
    expect(sql).toContain("NEW.initiating_agent_id, NEW.initiating_thread_id");
    expect(sql).toContain("completion wake delivery is immutable");
    expect(sql).not.toMatch(/ADD COLUMN "(?:prompt|lyrics|download_url|signed_url|api_key)"/iu);
  });

  test("remains the monotonic predecessor of later D525 work", async () => {
    const parsed = JSON.parse(await readFile(fileURLToPath(journalUrl), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !("entries" in parsed) || !Array.isArray(parsed.entries)) {
      throw new TypeError("migration journal has an invalid shape");
    }
    const journal = parsed as {
      entries: Array<{
        idx: number;
        tag: string;
        version: string;
        when: number;
        breakpoints: boolean;
      }>;
    };
    const index = journal.entries.findIndex((entry) => entry.tag === "0175_d525_media_completion_wakes");
    expect(journal.entries[index]).toEqual({
      idx: 175,
      tag: "0175_d525_media_completion_wakes",
      version: "7",
      when: 1786740000000,
      breakpoints: true,
    });
    expect(journal.entries[index + 1]).toMatchObject({
      idx: 176,
      tag: "0176_d525_media_generation_timing",
    });
  });
});
