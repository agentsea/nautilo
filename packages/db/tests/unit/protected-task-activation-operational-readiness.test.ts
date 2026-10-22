import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  buildProtectedTaskActivationOperationalPersistenceQuery,
  readProtectedTaskActivationOperationalPersistenceInTransaction,
} from "../../src/queries/protected-task-activation-operational-readiness";

function aggregate(overrides: Record<string, string> = {}) {
  return {
    protected_task_backed_jobs: "12",
    protected_job_content_violations: "0",
    parked_jobs_requiring_integrity_proof: "3",
    ...overrides,
  };
}

function render() {
  const query = new PgDialect().sqlToQuery(
    buildProtectedTaskActivationOperationalPersistenceQuery(),
  );
  return { ...query, sql: query.sql.toLowerCase() };
}

describe("protected Task activation operational persistence", () => {
  test("returns content-free counts from a borrowed transaction", async () => {
    let calls = 0;
    const result = await readProtectedTaskActivationOperationalPersistenceInTransaction({
      execute: async () => {
        calls += 1;
        return [aggregate()];
      },
    } as never);

    expect(calls).toBe(1);
    expect(result).toEqual({
      protectedTaskBackedJobs: 12n,
      protectedJobContentViolations: 0n,
      parkedJobsRequiringIntegrityProof: 3n,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("derives the denominator from protected Task lanes and exact ledgers", () => {
    const query = render();
    expect(query.sql).toContain("job.lane_key = 'task:' || task.id::text");
    expect(query.sql).toContain("task.content_representation in ('dual', 'protected')");
    expect(query.sql).toContain("definition.crypto_object_id = job.input ->> 'inputobjectid'");
    expect(query.sql).toContain("binding.result_object_id = job.input ->> 'resultobjectid'");
    expect(query.sql).toContain("select count(distinct id) from classified");
    expect(query.sql).toContain("select count(distinct id) from wake_classified");
    expect(query.sql).not.toContain("job.status in");
  });

  test("rejects plaintext siblings, malformed references and unbounded metadata", () => {
    const query = render();
    expect(query.sql).toContain("result is null");
    expect(query.sql).toContain("message is null");
    expect(query.sql).toContain("input ->> 'kind' = 'protected_task_run_v1'");
    expect(query.sql).toContain("octet_length(input ->> 'authorizationrequestid') <= 128");
    expect(query.sql).toContain("case\n               when job.input ->> 'policyrevision'");
    expect(query.sql).toContain("then (job.input ->> 'policyrevision')::numeric\n               else null");
    expect(query.sql).toContain("case\n               when job.input ->> 'executionsegment'");
    expect(query.sql).toContain("then (job.input ->> 'executionsegment')::numeric\n               else null");
    expect(query.sql).toContain("input ?& array[");
    expect(query.sql).toContain("from jsonb_object_keys(case");
    expect(query.sql).toContain("when jsonb_typeof(input) = 'object' then input");
    expect(query.sql).toContain("when jsonb_typeof(metadata) = 'object' then metadata");
    expect(query.sql).not.toContain("jsonb_object_length");
    expect(query.sql).not.toContain("input - array[");
    expect(query.sql).not.toContain("metadata - array[");
    expect(query.sql).toContain("= binding_result_operation_id");
    expect(query.sql).toContain("-> 'requestrevision')\n                = 'number'");
    expect(query.sql).toContain("-> 'parenttaskterminalized')\n                = 'boolean'");
    expect(query.sql).toContain("octet_length(metadata ->");
    expect(query.sql).toContain("coalesce((");
  });

  test("reports parked Jobs for the separate transcript/checkpoint proof port", () => {
    const query = render();
    expect(query.sql).toContain("as parked");
    expect(query.sql).toContain("task_run_job_id = id");
    expect(query.sql).toContain("task_run_status = 'awaiting'");
    expect(query.sql).toContain("job_status = 'completed'");
    expect(query.sql).toContain("select count(distinct id) from classified where parked");
    expect(query.sql).toContain("+ (select count(distinct id) from wake_classified)");
    expect(query.sql).toContain("latest_wake_continuations as");
    expect(query.sql).toContain("order by receipt.wake_job_id, receipt.segment desc");
    expect(query.sql).toContain("checkpoint_thread_id = 'protected-task-wake:' || id::text");
    expect(query.sql).toContain("run_status in ('completed', 'cancelled', 'errored')");
    expect(query.sql).toContain("job_status = 'queued'");
    expect(query.sql).toContain("job_status = 'running'");
    expect(query.sql).not.toContain("protected_task_execution_segment_receipts");
    expect(query.sql).not.toContain("langchain.checkpoints");
  });

  test("rejects missing and malformed aggregate results", async () => {
    await Promise.resolve(expect(readProtectedTaskActivationOperationalPersistenceInTransaction({
      execute: async () => [],
    } as never)).rejects.toThrow("readiness is unavailable"));
    await Promise.resolve(expect(readProtectedTaskActivationOperationalPersistenceInTransaction({
      execute: async () => [aggregate({ protected_job_content_violations: "-1" })],
    } as never)).rejects.toThrow("protected_job_content_violations is invalid"));
  });
});
