import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const META = resolve(MIGRATIONS_DIR, "meta");
const TAG = "0117_m219_context_budget_historical_backfill";
const SQL = readFileSync(resolve(MIGRATIONS_DIR, `${TAG}.sql`), "utf8");
const STATUS_CHECK_TAG = "0118_m219_historical_backfill_status_check";
const STATUS_CHECK_SQL = readFileSync(
  resolve(MIGRATIONS_DIR, `${STATUS_CHECK_TAG}.sql`),
  "utf8",
);
const FINAL_TAG = "0119_m219_stenographer_model_prior_context";
const D480_TAG = "0120_d480_relay_device_grouping";
const D476_PROJECTION_KEY_TAG = "0121_d476_projection_creation_key";
const D476_ROOM_NAME_INITIAL_TAG = "0122_d476_room_name_lookup_initial";
const D476_ROOM_NAME_INDEXES_TAG = "0123_d476_room_name_lookup_indexes";
const M230_TAG = "0124_solid_chameleon";
const M231_TAG = "0125_purple_cerise";
const M232_TAG = "0126_conscious_ricochet";
const M233_TAG = "0127_notification_intelligence_facts";

describe("M219 migration 0117", () => {
  test("is ordered after main and remains before the later D480 and D476 tail", () => {
    const journal = JSON.parse(
      readFileSync(resolve(META, "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    expect(
      journal.entries
        .filter(({ idx }) => idx >= 113 && idx <= 127)
        .map(({ idx, tag }) => ({ idx, tag })),
    )
      .toEqual([
        { idx: 113, tag: "0113_d462_model_control_selection" },
        { idx: 114, tag: "0114_m219_room_journal" },
        { idx: 115, tag: "0115_m219_room_transcript_indexes" },
        { idx: 116, tag: "0116_lyrical_black_widow" },
        { idx: 117, tag: TAG },
        { idx: 118, tag: STATUS_CHECK_TAG },
        { idx: 119, tag: FINAL_TAG },
        { idx: 120, tag: D480_TAG },
        { idx: 121, tag: D476_PROJECTION_KEY_TAG },
        { idx: 122, tag: D476_ROOM_NAME_INITIAL_TAG },
        { idx: 123, tag: D476_ROOM_NAME_INDEXES_TAG },
        { idx: 124, tag: M230_TAG },
        { idx: 125, tag: M231_TAG },
        { idx: 126, tag: M232_TAG },
        { idx: 127, tag: M233_TAG },
      ]);
    const tailTimes = journal.entries
      .filter(({ idx }) => idx >= 113 && idx <= 127)
      .map((entry) => entry.when);
    expect(tailTimes).toEqual([...tailTimes].sort((a, b) => a - b));
    expect(new Set(tailTimes).size).toBe(tailTimes.length);

    expect(existsSync(resolve(META, "0119_snapshot.json"))).toBe(true);
    const finalSnapshot = JSON.parse(
      readFileSync(resolve(META, "0119_snapshot.json"), "utf8"),
    ) as { prevId: string; tables: Record<string, unknown> };
    const mainSnapshot = JSON.parse(
      readFileSync(resolve(META, "0113_snapshot.json"), "utf8"),
    ) as { id: string };
    expect(finalSnapshot.prevId).toBe(mainSnapshot.id);
    expect(finalSnapshot.tables["public.room_journal_state"]).toBeDefined();
    expect(finalSnapshot.tables["public.room_agent_model_control_selections"])
      .toBeDefined();
    expect(existsSync(resolve(META, "0120_snapshot.json"))).toBe(true);
  });

  test("adds both bounded-context settings with defaults and checks", () => {
    expect(SQL).toContain('"minimum_full_turns" integer DEFAULT 1 NOT NULL');
    expect(SQL).toContain('"max_room_context_percent" integer DEFAULT 50 NOT NULL');
    expect(SQL).toContain('"minimum_full_turns" BETWEEN 0 AND 10');
    expect(SQL).toContain('"max_room_context_percent" BETWEEN 30 AND 80');
  });

  test("marks pre-existing journal rows pending without hand-written data SQL", () => {
    expect(SQL).toContain(
      '"historical_backfill_status" text DEFAULT \'pending\' NOT NULL',
    );
    expect(SQL).toContain('"historical_backfill_cursor_message_id" integer');
    expect(SQL).toContain('"historical_backfill_target_message_id" integer');
    expect(SQL).toContain('"historical_backfill_completed_at" timestamp with time zone');
    expect(SQL).not.toMatch(/\bUPDATE\b/i);
    expect(SQL).not.toMatch(/\bINSERT\b/i);
  });

  test("generated follow-up constrains the durable backfill status enum", () => {
    const journal = JSON.parse(
      readFileSync(resolve(META, "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.idx === 118)?.tag).toBe(
      STATUS_CHECK_TAG,
    );
    expect(STATUS_CHECK_SQL).toContain(
      `"historical_backfill_status" IN ('pending', 'completed', 'not_needed')`,
    );
  });
});
