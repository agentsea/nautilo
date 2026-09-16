import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const tag = "0128_d458_pairing_and_rejected_transport_cleanup";
const sql = readFileSync(resolve(migrations, `${tag}.sql`), "utf-8");

describe("D458 migration 0128 — pairing without parallel execution", () => {
  test("journal and snapshot own only the retained pairing schema", () => {
    const journal = JSON.parse(
      readFileSync(resolve(migrations, "meta/_journal.json"), "utf-8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const snapshot = JSON.parse(
      readFileSync(resolve(migrations, "meta/0128_snapshot.json"), "utf-8"),
    ) as { tables: Record<string, unknown> };

    expect(journal.entries.find((entry) => entry.idx === 128)?.tag).toBe(tag);
    expect(snapshot.tables["public.remote_controller_installations"]).toBeDefined();
    expect(snapshot.tables["public.remote_pairing_challenges"]).toBeDefined();
    expect(snapshot.tables["public.remote_controller_bindings"]).toBeDefined();
    for (const rejected of [
      "remote_controller_request_nonces",
      "remote_host_selections",
      "remote_run_bindings",
      "remote_run_commands",
      "remote_run_jobs",
    ]) {
      expect(snapshot.tables[`public.${rejected}`]).toBeUndefined();
    }
  });

  test("rebases the complete 0127 schema before adding only D458 pairing tables", () => {
    const baseSnapshot = JSON.parse(
      readFileSync(resolve(migrations, "meta/0127_snapshot.json"), "utf-8"),
    ) as { id: string; tables: Record<string, unknown> };
    const snapshot = JSON.parse(
      readFileSync(resolve(migrations, "meta/0128_snapshot.json"), "utf-8"),
    ) as {
      prevId: string;
      tables: Record<string, unknown>;
    };
    const d458Tables = [
      "public.remote_controller_installations",
      "public.remote_pairing_challenges",
      "public.remote_controller_bindings",
    ];

    expect(snapshot.prevId).toBe(baseSnapshot.id);
    expect(Object.keys(baseSnapshot.tables).filter((table) => !(table in snapshot.tables))).toEqual([]);
    expect(Object.keys(snapshot.tables).filter((table) => !(table in baseSnapshot.tables)).sort()).toEqual(
      d458Tables.sort(),
    );
  });

  test("physically drops every abandoned execution table and acceptance mutation", () => {
    for (const rejected of [
      "remote_controller_request_nonces",
      "remote_host_selections",
      "remote_run_bindings",
      "remote_run_commands",
      "remote_run_jobs",
    ]) {
      expect(sql).toContain(`DROP TABLE IF EXISTS "${rejected}"`);
      expect(sql).not.toContain(`CREATE TABLE "${rejected}"`);
      expect(sql).not.toContain(`CREATE TABLE IF NOT EXISTS "${rejected}"`);
    }
    expect(sql).toContain(
      'ALTER TABLE "work_acceptances" DROP COLUMN IF EXISTS "virtual_acceptance_id"',
    );
    expect(sql).not.toContain("recovery_required");
  });

  test("preserves an exercised pairing database while creating pairing on fresh installs", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "remote_controller_installations"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "remote_pairing_challenges"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "remote_controller_bindings"');
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "server_binding_generation" integer DEFAULT 1 NOT NULL',
    );
  });
});
