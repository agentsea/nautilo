import { describe, expect, test } from "bun:test";
import {
  protectedTaskContinuationReceipts,
  protectedTaskExecutionSegmentReceipts,
  taskRunMessageAssociations,
} from "@nautilo/db/schema";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import { externalRoomSourceAlarmLocator } from "../../baseline/reviewed-external-room-source-alarms";
import {
  PROTECTED_TASK_CONTINUATION_METADATA_FIELDS,
  PROTECTED_TASK_EXECUTION_SEGMENT_METADATA_FIELDS,
  REVIEWED_TASK_EXECUTION_EVIDENCE_COVERAGE_ENTRIES,
  TASK_RUN_MESSAGE_ASSOCIATION_METADATA_FIELDS,
} from "../../baseline/reviewed-task-execution-evidence-coverage";
import {
  REVIEWED_TASK_FOUNDATION_SOURCE_ALARMS,
  SUPERSEDED_TASK_FOUNDATION_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-task-foundation-source-alarms";
import { auditCoverageRegistry } from "../../src/registry";
import {
  inspectSourceAlarmReviews,
} from "../../src/node/source-alarm-review";
import { scanSourceAlarms } from "../../src/node/source-inventory";

const repositoryRoot = join(import.meta.dir, "../../../..");
const FINALIZER_ALARM =
  "packages/db/scripts/finalize-task-execution-evidence.ts#filesystem_write:ff2763bae2791e66:1";
const JOB_MANAGER_LOG_PREFIX =
  "packages/runtime/src/job-manager.ts#log_emitter";
const OWNED_ALARM_EXPECTATIONS = [
  {
    locator: FINALIZER_ALARM,
    closure: "reviewed_exclusion",
    snippet: "writeFileSync(path, result)",
  },
  ...[1, 2].map((occurrence) => ({
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:${occurrence}`,
    closure: "reviewed_exclusion" as const,
    snippet: "parked protected Task persistence recovery deferred",
  })),
  ...[3, 4].map((occurrence) => ({
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:${occurrence}`,
    closure: "reviewed_exclusion" as const,
    snippet: "protected Task pre-execution recovery deferred",
  })),
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:5`,
    closure: "declaration",
    snippet: "foreground_candidate_failure_status_persist_failed job=${job.id}",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:6`,
    closure: "reviewed_exclusion",
    snippet: "protected_task_execution_settlement_failed job=${job.id}",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:7`,
    closure: "declaration",
    snippet: "fork_candidate_failure_status_persist_failed job=${job.id}",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:8`,
    closure: "declaration",
    snippet: "durable cancellation pending; execution withheld",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:9`,
    closure: "declaration",
    snippet: "foreground_pre_persistence_failed reason=${reason}",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:10`,
    closure: "reviewed_exclusion",
    snippet: "foreground_pre_persistence_lock_release_failed",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:0ae25e725db4e950:19`,
    closure: "declaration",
    snippet: "stopTask failed for task=${taskId} run=${taskRunId}",
  },
  {
    locator: "packages/runtime/src/job.ts#log_emitter:d7b5f728bf9d919d:1",
    closure: "declaration",
    snippet: "const logFailure = (): void => log(this.contentPrivateDiagnostics || this.hasFullSinkDisposition()",
  },
  {
    locator:
      "packages/runtime/src/tasks/lifecycle.ts#log_emitter:0ae25e725db4e950:2",
    closure: "reviewed_exclusion",
    snippet: "protected Task process settlement failed task=${taskId} run=${run.id}",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:1",
    closure: "reviewed_exclusion",
    snippet: "protected cancellation recovery deferred code=PROTECTED_STOP_RECOVERY_RETRY",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:2",
    closure: "reviewed_exclusion",
    snippet: "protected cancellation output deferred code=PROTECTED_STOP_OUTPUT_RETRY",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:3",
    closure: "reviewed_exclusion",
    snippet: "protected terminal delivery deferred code=PROTECTED_TERMINAL_DELIVERY_RETRY",
  },
  {
    locator: "packages/db/scripts/finalize-task-crypto-lifecycle.ts#filesystem_write:5e7543910a09a852:1",
    closure: "reviewed_exclusion",
    snippet: "writeFileSync(path, finalized, \"utf8\")",
  },
  {
    locator: "packages/db/scripts/finalize-task-cancellation-staging.ts#filesystem_write:094c47a94a93b928:1",
    closure: "reviewed_exclusion",
    snippet: "writeFileSync(path, finalized, \"utf8\")",
  },
  {
    locator: "packages/runtime/src/tasks/report-back.ts#log_emitter:7ef703451e44cded:3",
    closure: "reviewed_exclusion",
    snippet: "ignored stale dispatch error task=${taskId}",
  },
  ...[1, 2, 3].map((occurrence) => ({
    locator: `packages/runtime/src/tasks/resolve-task-memory-envelope.ts#log_emitter:9f39e0a243a29276:${occurrence}`,
    closure: "declaration" as const,
    snippet: "envelope unavailable for task=${task.id}",
  })),
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:3",
    closure: "reviewed_exclusion",
    snippet: "ordinary occurrence observation deferred code=TASK_POLICY_UNAVAILABLE",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:6",
    closure: "reviewed_exclusion",
    snippet: "protected occurrence recovery deferred code=PROTECTED_RECOVERY_QUERY_RETRY",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:7",
    closure: "reviewed_exclusion",
    snippet: "protected occurrence deferred code=PROTECTED_PREPARE_RETRY",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:8",
    closure: "reviewed_exclusion",
    snippet: "protected occurrence claim deferred code=PROTECTED_CLAIM_RETRY",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:9",
    closure: "reviewed_exclusion",
    snippet: "protected occurrence deferred code=PROTECTED_PORT_RETRY",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:10",
    closure: "reviewed_exclusion",
    snippet: "time-limit reached → paused task=${task.id}",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:11",
    closure: "reviewed_exclusion",
    snippet: "protected time-limit settlement pending code=PROTECTED_TIME_LIMIT_SETTLEMENT_PENDING",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:8",
    closure: "declaration",
    snippet: "dispatch failure delivery failed task=${task.id}",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:9",
    closure: "declaration",
    snippet: "time-limit scan failed: ${err instanceof Error ? err.message : String(err)}",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:10",
    closure: "declaration",
    snippet: "time-limit pause failed for task=${task.id}",
  },
  {
    locator: "packages/runtime/src/tasks/lifecycle.ts#log_emitter:7ef703451e44cded:3",
    closure: "reviewed_exclusion",
    snippet: "checkpoint-resumed task=${task.id}",
  },
  {
    locator: "packages/runtime/src/tasks/lifecycle.ts#log_emitter:7ef703451e44cded:4",
    closure: "reviewed_exclusion",
    snippet: "stopped task=${taskId}",
  },
  {
    locator: "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:244f290d003a8f2a:1",
    closure: "reviewed_exclusion",
    snippet: "protected wake deferred code=PROTECTED_WAKE_RETRY",
  },
  {
    locator: "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:4",
    closure: "reviewed_exclusion",
    snippet: "protected result settlement deferred code=PROTECTED_RESULT_SETTLEMENT_RETRY",
  },
  {
    locator: "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:5",
    closure: "reviewed_exclusion",
    snippet: "protected abandoned execution deferred code=PROTECTED_RUNNING_RECOVERY_RETRY",
  },
  {
    locator: "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:6",
    closure: "reviewed_exclusion",
    snippet: "protected pre-execution recovery deferred code=PROTECTED_START_RECOVERY_RETRY",
  },
  {
    locator: "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:7",
    closure: "reviewed_exclusion",
    snippet: "protected checkpoint pause deferred code=PROTECTED_PAUSE_RECOVERY_RETRY",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:5de77a580b7641d5:1`,
    closure: "reviewed_exclusion",
    snippet: "protected_wake_settlement_unavailable job=${job.id}",
  },
  {
    locator: "packages/server/src/app.ts#log_emitter:b4d80a858be836ca:1",
    closure: "reviewed_exclusion",
    snippet: "protected local readiness retry deferred",
  },
] as const;
const CURRENT_OWNED_ALARM_EXPECTATIONS = OWNED_ALARM_EXPECTATIONS.map((entry) => ({
  ...entry, locator: externalRoomSourceAlarmLocator(entry.locator),
}));
const OWNED_ALARMS = CURRENT_OWNED_ALARM_EXPECTATIONS.map(({ locator }) => locator);

const groups = [
  {
    table: taskRunMessageAssociations,
    locator: "public.task_run_message_associations",
    fields: TASK_RUN_MESSAGE_ASSOCIATION_METADATA_FIELDS,
  },
  {
    table: protectedTaskExecutionSegmentReceipts,
    locator: "public.protected_task_execution_segment_receipts",
    fields: PROTECTED_TASK_EXECUTION_SEGMENT_METADATA_FIELDS,
  },
  {
    table: protectedTaskContinuationReceipts,
    locator: "public.protected_task_continuation_receipts",
    fields: PROTECTED_TASK_CONTINUATION_METADATA_FIELDS,
  },
] as const satisfies readonly {
  table: PgTable;
  locator: string;
  fields: readonly string[];
}[];

function groupLocators(
  table: string,
  fields: readonly string[],
): readonly string[] {
  return [table, ...fields.map((field) => `${table}.${field}`)];
}

describe("Task execution evidence inventory classifications", () => {
  test("classifies only the exact receipt columns as bounded metadata", () => {
    const expectedLocators = groups.flatMap((group) =>
      groupLocators(group.locator, group.fields)
    ).sort();
    expect(expectedLocators).toHaveLength(38);
    expect(REVIEWED_TASK_EXECUTION_EVIDENCE_COVERAGE_ENTRIES
      .map((entry) => entry.locator).sort()).toEqual(expectedLocators);

    for (const group of groups) {
      expect(getTableConfig(group.table).columns
        .map((column) => column.name).sort()).toEqual([...group.fields].sort());
      const entries = REVIEWED_TASK_EXECUTION_EVIDENCE_COVERAGE_ENTRIES
        .filter((entry) => entry.locator === group.locator
          || entry.locator.startsWith(`${group.locator}.`));
      expect(entries).toHaveLength(group.fields.length + 1);
      for (const entry of entries) {
        expect(entry.classification).toBe("bounded_metadata");
        expect(entry.owner).toBe("packages/runtime");
        expect(entry.migrationState).toBe("not_applicable");
        if (entry.classification === "bounded_metadata") {
          expect(entry.metadataAllowlist).toEqual(group.fields);
          expect(entry.plaintextReason).toContain("exact schema");
        }
      }
    }

    const registered = BASELINE_REGISTRY.entries.filter((entry) =>
      groups.some((group) => entry.locator === group.locator
        || entry.locator.startsWith(`${group.locator}.`))
    );
    expect(registered.map((entry) => entry.locator).sort())
      .toEqual(expectedLocators);
    expect(auditCoverageRegistry(BASELINE_REGISTRY).ok).toBe(true);
  });

  test("binds every Task review to its exact current source payload", async () => {
    expect(SUPERSEDED_TASK_FOUNDATION_SOURCE_ALARM_LOCATORS)
      .toEqual(new Set([
        `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:1`,
        `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:2`,
        `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:3`,
        `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:4`,
        "packages/runtime/src/job.ts#log_emitter:a37d1bc96a5f82fa:1",
        "packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:0ae25e725db4e950:2",
        "packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:0ae25e725db4e950:3",
        "packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:0ae25e725db4e950:4",
        "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:8",
        "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:3",
      ]));
    const exactReviews = REVIEWED_TASK_FOUNDATION_SOURCE_ALARMS.map((review) => ({
      ...review, locator: externalRoomSourceAlarmLocator(review.locator),
    })).filter(
      (review) => OWNED_ALARMS.includes(review.locator),
    );
    expect(exactReviews).toHaveLength(OWNED_ALARM_EXPECTATIONS.length);

    const scanRoots = [...new Set(OWNED_ALARMS.map(
      (locator) => locator.slice(0, locator.indexOf("#")),
    ))];
    const scan = await scanSourceAlarms({
      repoRoot: repositoryRoot,
      scanRoots,
    });
    const exactAlarms = scan.alarms.filter((alarm) =>
      OWNED_ALARMS.includes(alarm.locator)
    );
    expect(exactAlarms.map((alarm) => alarm.locator).sort())
      .toEqual([...OWNED_ALARMS].sort());
    const inspection = inspectSourceAlarmReviews(exactAlarms, exactReviews);
    expect(inspection.errors).toEqual([]);
    expect(inspection.counts).toEqual({
      baselineDebt: 0,
      declaration: 12,
      reviewedExclusion: 30,
      unmapped: 0,
    });

    const sourceByPath = new Map<string, readonly string[]>();
    for (const path of scanRoots) {
      sourceByPath.set(path, (await readFile(join(repositoryRoot, path), "utf8"))
        .split("\n"));
    }
    for (const expected of CURRENT_OWNED_ALARM_EXPECTATIONS) {
      const alarm = exactAlarms.find((candidate) =>
        candidate.locator === expected.locator
      );
      const review = exactReviews.find((candidate) =>
        candidate.locator === expected.locator
      );
      expect(alarm).toBeDefined();
      expect(review?.closure).toBe(expected.closure);
      const lines = sourceByPath.get(alarm!.path);
      expect(lines).toBeDefined();
      expect(lines!.slice(alarm!.line - 1, alarm!.line + 5).join("\n"))
        .toContain(expected.snippet);
    }
  });

  test("keeps production protected Task execution behind the Task content owner", async () => {
    const appSource = await readFile(join(
      repositoryRoot,
      "packages/server/src/app.ts",
    ), "utf8");
    expect(appSource).toContain(
      "createProductionProtectedTaskRuntimeInitialComposition",
    );
    expect(appSource).toContain(
      "const currentProtectedTaskRuntime = () => taskContentOwner.runMutation({",
    );
    expect(appSource).toContain("ordinary: () => Promise.resolve(null)");
    expect(appSource).toContain("protected: initializeProtectedTaskRuntime");
    expect(appSource).toContain("dual: initializeProtectedTaskRuntime");
  });
});
