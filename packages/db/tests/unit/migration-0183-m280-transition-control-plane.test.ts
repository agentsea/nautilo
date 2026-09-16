import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dir, "../../src/migrations");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };
const entry = journal.entries.find((candidate) => {
  const sql = readFileSync(resolve(migrations, `${candidate.tag}.sql`), "utf8");
  return sql.includes("-- M274_ENCRYPTION_TRANSITION_AUTHORITY");
});
const tag = entry?.tag;
if (!entry || !tag) {
  throw new Error("M280 transition-control migration is missing from the journal");
}
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const snapshot = readFileSync(
  resolve(migrations, `meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`),
  "utf8",
);

describe("M280 generated transition-control migration", () => {
  test("is the canonical journaled Drizzle generation", () => {
    expect(entry).toMatchObject({ idx: 183, tag: "0183_striped_sir_ram" });
    expect(snapshot).toContain('"public.encryption_transition_policy"');
    expect(snapshot).toContain(
      '"public.encryption_transition_observation_buckets"',
    );
  });

  test("contains only this PR's transition substrate", () => {
    for (const table of [
      "encryption_transition_policy",
      "encryption_transition_observation_buckets",
      "encryption_transition_outcome_totals",
      "encryption_transition_observation_admissions",
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
    expect(migration).not.toContain("accessible_corpus");
    expect(migration).not.toContain("stale_access_authorization");
    expect(migration).not.toContain("shared_domain");
    expect(migration).not.toContain("shadow_attach");
    expect(migration).not.toContain("shadow_repair");
    expect(migration).not.toContain("media_generations");
  });

  test("backfills mapping state before checks and installs synchronous invalidation", () => {
    for (const table of ["memories", "artifacts"] as const) {
      const update = migration.indexOf(`UPDATE "${table}"`);
      const constraint = migration.indexOf(
        table === "memories"
          ? "memories_crypto_mapping_revision_coherent"
          : "artifacts_crypto_mapping_coherent",
        update,
      );
      expect(update).toBeGreaterThan(-1);
      expect(update).toBeLessThan(constraint);
    }
    expect(migration).toContain(
      'TRIGGER "trg_m274_stale_memory_crypto_mapping"',
    );
    expect(migration).toContain(
      'TRIGGER "trg_m274_stale_artifact_crypto_mapping_edge"',
    );
    expect(migration).not.toContain('NEW."tier" IS DISTINCT');
    expect(migration).not.toContain('NEW."importance" IS DISTINCT');
    expect(migration).not.toContain(
      'NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"',
    );
  });

  test("keeps policy and observations product-only under forced RLS", () => {
    for (const table of [
      "encryption_transition_policy",
      "encryption_transition_observation_buckets",
      "encryption_transition_outcome_totals",
      "encryption_transition_observation_admissions",
    ]) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );
    }
    expect(migration).toContain(
      'FROM PUBLIC, "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION "nautilo_m274_stale_memory_crypto_mapping"()',
    );
  });

  test("binds aggregate buckets to the exact Shadow policy epoch", () => {
    expect(migration).toContain('"policy_revision" integer NOT NULL');
    expect(migration).toContain(
      'PRIMARY KEY("policy_revision","bucket_started_at"',
    );
    expect(snapshot).toContain('"policy_revision"');
  });
});
