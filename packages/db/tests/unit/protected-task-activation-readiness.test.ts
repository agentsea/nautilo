import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  buildProtectedTaskActivationProductReadinessQuery,
  readProtectedTaskActivationProductReadiness,
  readProtectedTaskActivationProductReadinessInTransaction,
} from "../../src/queries/protected-task-activation-readiness";

const NOW = new Date("2042-05-06T07:08:09.010Z");

function aggregate(overrides: Record<string, string> = {}) {
  return {
    definition_total: "19",
    definition_exact_mapped: "11",
    definition_deferred_nested: "2",
    definition_ordinary_supported: "3",
    definition_artifact_candidates: "1",
    definition_invalid_mapping: "2",
    definition_pending_revisions: "1",
    definition_complete_unmapped_revisions: "1",
    definition_quarantined_revisions: "2",
    definition_stale_mapping_revisions: "3",
    result_terminal: "17",
    result_content_bearing: "14",
    result_exact_mapped: "9",
    result_no_content: "3",
    result_deferred_nested: "2",
    result_ordinary_supported: "3",
    result_artifact_candidates: "1",
    result_invalid_mapping: "1",
    result_pending_revisions: "2",
    result_complete_unmapped_revisions: "1",
    result_quarantined_revisions: "1",
    result_stale_mapping_revisions: "2",
    active_backfill_claims: "1",
    incomplete_output_bindings: "4",
    ...overrides,
  };
}

function render() {
  const query = new PgDialect().sqlToQuery(
    buildProtectedTaskActivationProductReadinessQuery(NOW),
  );
  return { ...query, sql: query.sql.toLowerCase() };
}

describe("protected Task activation product readiness", () => {
  test("reads one fresh repeatable product snapshot and returns structured blockers", async () => {
    let options: unknown;
    const database = {
      transaction: async (
        use: (transaction: { execute: () => Promise<unknown[]> }) => Promise<unknown>,
        receivedOptions: unknown,
      ) => {
        options = receivedOptions;
        return use({ execute: async () => [aggregate()] });
      },
    } as unknown as Parameters<
      typeof readProtectedTaskActivationProductReadiness
    >[0];

    const result = await readProtectedTaskActivationProductReadiness(database, {
      now: NOW,
    });

    expect(options).toEqual({ isolationLevel: "repeatable read" });
    expect(result).toEqual({
      definitions: {
        total: 19n,
        exactMapped: 11n,
        deferredNested: 2n,
        blockers: {
          ordinarySupported: 3n,
          artifactDependentCandidates: 1n,
          invalidCurrentMapping: 2n,
          pendingRevisions: 1n,
          completeUnmappedRevisions: 1n,
          quarantinedRevisions: 2n,
          staleMappingRevisions: 3n,
        },
      },
      results: {
        terminal: 17n,
        contentBearing: 14n,
        exactMapped: 9n,
        noContent: 3n,
        deferredNested: 2n,
        blockers: {
          ordinarySupported: 3n,
          artifactDependentCandidates: 1n,
          invalidCurrentMapping: 1n,
          pendingRevisions: 2n,
          completeUnmappedRevisions: 1n,
          quarantinedRevisions: 1n,
          staleMappingRevisions: 2n,
        },
      },
      operations: {
        blockers: {
          activeBackfillClaims: 1n,
          incompleteOutputBindings: 4n,
        },
      },
    });
    expect("ready" in result).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.definitions.blockers)).toBe(true);
  });

  test("uses exact current ledger coordinates and permits legitimate access rewraps", () => {
    const query = render();
    expect(query.sql).toContain("revision.content_namespace_id = task.content_namespace_id");
    expect(query.sql).toContain("revision.content_revision = task.content_revision");
    expect(query.sql).toContain("revision.crypto_object_id = task.crypto_object_id");
    expect(query.sql).toContain("revision.required_namespace_fingerprint =");
    expect(query.sql).toContain("revision.representation = task.content_representation");
    expect(query.sql).toContain("revision.crypto_access_revision <= task.crypto_access_revision");
    expect(query.sql).toContain("revision.crypto_access_revision <= run.result_crypto_access_revision");
    expect(query.sql).not.toContain("revision.crypto_access_revision = task.crypto_access_revision");
    expect(query.sql).not.toContain("revision.crypto_access_revision = run.result_crypto_access_revision");
    expect(query.sql).toContain("revision.completion = 'complete'");
    expect(query.sql).toContain("revision.failure_code is null");
  });

  test("keeps deferred and no-content accounting server-derived and conservative", () => {
    const query = render();
    expect(query.sql).toContain("task.parent_task_id is not null or task.depth > 0 as nested");
    expect(query.sql).not.toContain("task.preset");
    expect(query.sql).toContain("task.metadata ?| array[");
    expect(query.sql).toContain("not nested and artifact_candidate");
    expect(query.sql).toContain("result_representation = 'ordinary'");
    expect(query.sql).toContain("not ordinary_content_present");
    expect(query.sql).not.toContain("task_content_backfill_failures");
  });

  test("reads only product-role metadata and never joins crypto staging receipts", () => {
    const query = render();
    expect(query.sql).toContain("task_content_backfill_scans");
    expect(query.sql).toContain("protected_task_run_output_bindings");
    expect(query.sql).not.toContain("crypto_staging");
    expect(query.sql).not.toContain("staging_receipts");
    expect(query.sql).not.toContain("task.prompt");
    expect(query.sql).not.toContain("task.expected_output");
    expect(query.sql).not.toContain("historical_repair");
    expect(query.params).toEqual([NOW.toISOString()]);
    expect(query.sql).toContain("scan.lease_expires_at > $1::timestamptz");
  });

  test("supports a borrowed canonical transaction without opening another one", async () => {
    let calls = 0;
    const result = await readProtectedTaskActivationProductReadinessInTransaction({
      execute: async () => {
        calls += 1;
        return [aggregate({ active_backfill_claims: "0" })];
      },
    } as never, { now: NOW });
    expect(calls).toBe(1);
    expect(result.operations.blockers.activeBackfillClaims).toBe(0n);
  });

  test("rejects invalid time and malformed aggregates", () => {
    expect(() => buildProtectedTaskActivationProductReadinessQuery(
      new Date(Number.NaN),
    )).toThrow("time is invalid");
    expect(readProtectedTaskActivationProductReadinessInTransaction({
      execute: async () => [aggregate({ result_terminal: "-1" })],
    } as never, { now: NOW })).rejects.toThrow("result_terminal is invalid");
    expect(readProtectedTaskActivationProductReadinessInTransaction({
      execute: async () => [],
    } as never, { now: NOW })).rejects.toThrow("readiness is unavailable");
  });
});
