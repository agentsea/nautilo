import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const tag = "0315_high_jean_grey";
const sql = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const predecessorTag = "0316_rich_callisto";
const predecessorSql = readFileSync(
  resolve(migrations, `${predecessorTag}.sql`),
  "utf8",
);

describe("Task funding storage migration", () => {
  test("adds the legacy-safe definition discriminator and nullable run binding", () => {
    expect(sql).toContain(
      'ALTER TABLE "tasks" ADD COLUMN "funding_mode" text DEFAULT \'legacy_server\' NOT NULL;',
    );
    expect(sql).toContain(
      'ALTER TABLE "task_runs" ADD COLUMN "funding_binding" jsonb;',
    );
    expect(sql).not.toMatch(/api[_ -]?key|ciphertext|secret/i);
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE|CONSTRAINT)|RENAME/i);
  });

  test("records the generated migration and both columns in its snapshot", () => {
    const journal = JSON.parse(
      readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.idx === 315)?.tag).toBe(tag);

    const snapshot = JSON.parse(
      readFileSync(resolve(migrations, "meta/0315_snapshot.json"), "utf8"),
    ) as {
      tables: Record<string, {
        columns?: Record<string, {
          name: string;
          type: string;
          primaryKey: boolean;
          notNull: boolean;
          default?: string;
        }>;
      }>;
    };
    expect(snapshot.tables["public.tasks"]?.columns?.["funding_mode"])
      .toMatchObject({
        name: "funding_mode",
        type: "text",
        primaryKey: false,
        notNull: true,
        default: "'legacy_server'",
      });
    expect(snapshot.tables["public.task_runs"]?.columns?.["funding_binding"])
      .toEqual({
        name: "funding_binding",
        type: "jsonb",
        primaryKey: false,
        notNull: false,
      });
  });

  test("adds a nullable canonical predecessor link in a later generated migration", () => {
    expect(predecessorSql).toContain(
      'ALTER TABLE "task_runs" ADD COLUMN "funding_predecessor_run_id" uuid;',
    );
    expect(predecessorSql).toContain(
      'FOREIGN KEY ("funding_predecessor_run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null',
    );
    expect(predecessorSql).not.toMatch(/api[_ -]?key|ciphertext|secret/i);
    expect(predecessorSql).not.toMatch(/DROP\s+(COLUMN|TABLE)|RENAME/i);

    const journal = JSON.parse(
      readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.idx === 316)?.tag)
      .toBe(predecessorTag);
    const snapshot = JSON.parse(
      readFileSync(resolve(migrations, "meta/0316_snapshot.json"), "utf8"),
    ) as {
      tables: Record<string, {
        columns: Record<string, unknown>;
        foreignKeys: Record<string, unknown>;
      }>;
    };
    expect(snapshot.tables["public.task_runs"]?.columns["funding_predecessor_run_id"])
      .toEqual({
        name: "funding_predecessor_run_id",
        type: "uuid",
        primaryKey: false,
        notNull: false,
      });
    expect(snapshot.tables["public.task_runs"]?.foreignKeys[
      "task_runs_funding_predecessor_run_id_task_runs_id_fk"
    ]).toMatchObject({
      tableFrom: "task_runs",
      tableTo: "task_runs",
      columnsFrom: ["funding_predecessor_run_id"],
      columnsTo: ["id"],
      onDelete: "set null",
    });
  });
});
