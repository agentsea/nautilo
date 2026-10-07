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
const SETTLEMENT_ALARM =
  "packages/runtime/src/job-manager.ts#log_emitter:7ef703451e44cded:2";
const LOCK_RELEASE_ALARM =
  "packages/runtime/src/job-manager.ts#log_emitter:7ef703451e44cded:6";
const OWNED_ALARMS = [
  FINALIZER_ALARM,
  SETTLEMENT_ALARM,
  LOCK_RELEASE_ALARM,
] as const;

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
    expect(expectedLocators).toHaveLength(37);
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

  test("closes only the deterministic finalizer and payload-free diagnostics", async () => {
    expect(SUPERSEDED_TASK_FOUNDATION_SOURCE_ALARM_LOCATORS)
      .toEqual(new Set([SETTLEMENT_ALARM]));
    const exactReviews = REVIEWED_TASK_FOUNDATION_SOURCE_ALARMS.filter(
      (review) => OWNED_ALARMS.includes(
        review.locator as (typeof OWNED_ALARMS)[number],
      ),
    );
    expect(exactReviews).toHaveLength(3);
    expect(exactReviews.every((review) =>
      review.closure === "reviewed_exclusion"
    )).toBe(true);

    const scan = await scanSourceAlarms({ repoRoot: repositoryRoot });
    const exactAlarms = scan.alarms.filter((alarm) =>
      OWNED_ALARMS.includes(alarm.locator as (typeof OWNED_ALARMS)[number])
    );
    expect(exactAlarms.map((alarm) => alarm.locator).sort())
      .toEqual([...OWNED_ALARMS].sort());
    const inspection = inspectSourceAlarmReviews(scan.alarms);
    for (const locator of OWNED_ALARMS) {
      expect(inspection.errors).not.toContain(
        `new source alarm has no closure: ${locator}`,
      );
    }
    expect(inspection.reviews.filter((review) =>
      OWNED_ALARMS.includes(review.locator as (typeof OWNED_ALARMS)[number])
    )).toEqual(exactReviews);

    const finalizerSource = await readFile(join(
      repositoryRoot,
      "packages/db/scripts/finalize-task-execution-evidence.ts",
    ), "utf8");
    const settlementSource = await readFile(join(
      repositoryRoot,
      "packages/runtime/src/job-manager.ts",
    ), "utf8");
    expect(finalizerSource).toContain("writeFileSync(path, result)");
    expect(settlementSource).toContain(
      "protected_task_execution_settlement_failed job=${job.id}",
    );
    expect(settlementSource).toContain(
      'log("[lane] foreground_pre_persistence_lock_release_failed")',
    );
  });
});
