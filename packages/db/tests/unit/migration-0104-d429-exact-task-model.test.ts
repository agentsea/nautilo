/**
 * D429 Phase 3 — validates migration 0104 adds the nullable
 * `requested_model_id` column to `tasks` for the exact model pin.
 *
 * Additive-only: no destructive DDL, no FK (the resolved catalog is a runtime
 * projection, not a static table), `task_runs.model_id` is untouched, and old
 * rows remain valid (NULL). Text-only assertions on the SQL — no DB apply.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../src/migrations");
const TAG = "0104_d429_exact_task_model";
const M0104 = resolve(MIGRATIONS_DIR, `${TAG}.sql`);
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, "meta/_journal.json");
const SNAPSHOT_PATH = resolve(MIGRATIONS_DIR, "meta/0104_snapshot.json");
const SQL = readFileSync(M0104, "utf-8");

describe("D429 migration 0104 — journal", () => {
  test("journal references idx 104 with the right tag", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((entry) => entry.idx === 104)?.tag).toBe(TAG);
  });

  test("historical 0103 remains immediately before D429", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((entry) => entry.idx === 103)?.tag).toBe(
      "0103_d420_user_cancelled_acceptances",
    );
  });

  test("journal indices remain strictly increasing after D429", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
      entries: Array<{ idx: number }>;
    };
    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index]!.idx).toBe(
        journal.entries[index - 1]!.idx + 1,
      );
    }
    expect(journal.entries.at(-1)?.idx).toBeGreaterThanOrEqual(104);
  });
});

describe("D429 migration 0104 — tasks.requested_model_id", () => {
  test("adds a nullable requested_model_id text column", () => {
    expect(SQL).toContain(
      'ALTER TABLE "tasks" ADD COLUMN "requested_model_id" text;',
    );
    expect(SQL).not.toMatch(/requested_model_id.*NOT NULL/i);
  });

  test("does not add a foreign key or touch task_runs", () => {
    expect(SQL).not.toMatch(/requested_model_id.*FOREIGN KEY/i);
    expect(SQL).not.toMatch(/FOREIGN KEY[\s\S]*?requested_model_id/i);
    expect(SQL).not.toMatch(/task_runs/i);
  });

  test("contains no destructive or rename operation", () => {
    expect(SQL).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE|CONSTRAINT)/i);
    expect(SQL).not.toMatch(/ALTER\s+TABLE.*DROP/i);
    expect(SQL).not.toMatch(/RENAME/i);
  });

  test("snapshot records the nullable tasks column", () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8")) as {
      tables: Record<
        string,
        {
          columns?: Record<
            string,
            {
              name: string;
              type: string;
              primaryKey: boolean;
              notNull: boolean;
            }
          >;
        }
      >;
    };
    const column =
      snapshot.tables["public.tasks"]?.columns?.["requested_model_id"];
    expect(column).toEqual({
      name: "requested_model_id",
      type: "text",
      primaryKey: false,
      notNull: false,
    });
  });
});
