import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const migrationTag = "0250_damp_wrecking_crew";
const migration = readFileSync(
  resolve(migrations, `${migrationTag}.sql`),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly { idx: number; when: number; tag: string }[];
};
const snapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0250_snapshot.json"), "utf8"),
) as {
  tables: Record<string, {
    columns: Record<string, { notNull: boolean }>;
    checkConstraints: Record<string, { value: string }>;
  }>;
};
const replayMigrationTag = "0251_chief_starbolt";
const replayMigration = readFileSync(
  resolve(migrations, `${replayMigrationTag}.sql`),
  "utf8",
);
const replaySnapshot = JSON.parse(
  readFileSync(resolve(migrations, "meta/0251_snapshot.json"), "utf8"),
) as typeof snapshot;
const coherenceMigrationTag = "0252_medical_calypso";
const coherenceMigration = readFileSync(
  resolve(migrations, `${coherenceMigrationTag}.sql`),
  "utf8",
);

describe("M320 foreground Memory effect receipt migration", () => {
  test("is generated, monotonic, and preserves existing operation rows", () => {
    const entry = journal.entries.find((item) => item.idx === 250);
    const previous = journal.entries.find((item) => item.idx === 249);

    expect(entry).toMatchObject({ idx: 250, tag: migrationTag });
    expect(entry!.when).toBeGreaterThan(previous!.when);
    expect(entry!.when).toBeLessThanOrEqual(Date.now());
    expect(migration).not.toMatch(/^\s*(?:DELETE|UPDATE|INSERT)\b/im);
    expect(migration).not.toMatch(/\b(?:TRUNCATE|DROP TABLE)\b/i);
  });

  test("retains a content-free pending effect and gates acknowledgement on completion", () => {
    const table = snapshot.tables["public.memory_crypto_operations"]!;
    expect(table.columns["semantic_change_kind"]).toMatchObject({ notNull: false });
    expect(table.columns["semantic_change_acknowledged_at"]).toMatchObject({
      notNull: false,
    });
    const coherent = table.checkConstraints[
      "memory_crypto_operations_semantic_change_ack_coherent"
    ]!.value;
    expect(coherent).toContain("semantic_change_kind");
    expect(coherent).toContain("semantic_change_acknowledged_at");
    expect(coherent).toContain("completion");
    expect(coherent).toContain("'complete'");
  });

  test("retains a content-free stable foreground outcome and pending effect index", () => {
    expect(journal.entries.find((item) => item.idx === 251)).toMatchObject({
      idx: 251,
      tag: replayMigrationTag,
    });
    expect(replayMigration).not.toMatch(/^\s*(?:DELETE|UPDATE|INSERT)\b/im);
    const table = replaySnapshot.tables["public.memory_crypto_operations"]!;
    for (const name of [
      "foreground_stable_request_digest",
      "foreground_mutation_kind",
      "foreground_required_namespace_ids",
      "foreground_save_similarity",
    ]) expect(table.columns[name]).toMatchObject({ notNull: false });
    expect(table.checkConstraints[
      "memory_crypto_operations_foreground_replay_coherent"
    ]!.value).toContain("cardinality");
    expect(replayMigration).toContain(
      "idx_memory_crypto_operations_unacknowledged_semantic_effect",
    );
  });

  test("rejects SQL NULL and null elements in partially populated replay receipts", () => {
    expect(journal.entries.find((item) => item.idx === 252)).toMatchObject({
      idx: 252,
      tag: coherenceMigrationTag,
    });
    expect(coherenceMigration).toContain(
      '"foreground_stable_request_digest" is not null',
    );
    expect(coherenceMigration).toContain(
      '"foreground_mutation_kind" is not null',
    );
    expect(coherenceMigration).toContain(
      '"foreground_required_namespace_ids" is not null',
    );
    expect(coherenceMigration).toContain(
      'array_position("memory_crypto_operations"."foreground_required_namespace_ids", null) is null',
    );
  });

  test("keeps ordinary fallback distinct from crypto completion and requires its reason", () => {
    const latest = JSON.parse(readFileSync(resolve(migrations,
      "meta/0255_snapshot.json"), "utf8")) as typeof snapshot;
    const table = latest.tables["public.memory_crypto_operations"]!;
    const coherent = table.checkConstraints[
      "memory_crypto_operations_completion_coherent"
    ]!.value;
    expect(coherent).toContain("'ordinary_fallback'");
    expect(coherent).toContain('"crypto_completed_at" is null');
    expect(coherent).toContain('"ordinary_fallback_completed_at" is not null');
    // SQL CHECK accepts UNKNOWN: the IN expression alone does not reject NULL.
    expect(coherent).toContain('"ordinary_fallback_reason" is not null');
    expect(coherent).toContain("'encryption_pending', 'target_encryption_not_ready'");
  });

  test("durable Human outcomes are content-free and terminal-only without rewriting prior migrations", () => {
    const sql = readFileSync(resolve(migrations, "0254_salty_tenebrous.sql"), "utf8");
    expect(sql).toContain('ADD COLUMN "human_product_outcome" jsonb');
    expect(sql).toContain('"completion" = \'complete\'');
    expect(sql).toContain('"disposition" = \'complete\'');
    expect(sql).not.toMatch(/^\s*(?:DELETE|UPDATE|INSERT|TRUNCATE)\b/im);
    for (const [idx, tag] of [[253, "0253_open_starfox"], [254, "0254_salty_tenebrous"],
      [255, "0255_confused_quentin_quire"]] as const) {
      const entry = journal.entries.find((item) => item.idx === idx);
      const previous = journal.entries.find((item) => item.idx === idx - 1);
      expect(entry).toMatchObject({ idx, tag });
      expect(entry!.when).toBeGreaterThan(previous!.when);
    }
  });
});
