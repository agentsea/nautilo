import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as nautiloSchema from "@nautilo/db/schema";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import {
  REVIEWED_TASK_PROTECTION_DATABASE_WRITER_LOCATORS,
  SUPERSEDED_TASK_PROTECTION_DATABASE_WRITER_LOCATORS,
} from "../../baseline/reviewed-task-protection-coverage";

import {
  REVIEWED_TASK_PROTECTION_DTO_DECLARATIONS,
  SUPERSEDED_TASK_PROTECTION_DTO_LOCATORS,
} from "../../baseline/reviewed-task-protection-dto";
import {
  SUPERSEDED_TASK_FOUNDATION_SOURCE_ALARM_LOCATORS,
} from "../../baseline/reviewed-task-foundation-source-alarms";
import {
  auditDtoDeclarations,
  discoverDtoInventory,
} from "../../src/node/dto-inventory";
import {
  discoverDatabaseWriterInventory,
} from "../../src/node/database-writer-inventory";
import { inventoryDrizzleSchema } from "../../src/node/schema-inventory";
import {
  CURRENT_SOURCE_ALARM_REVIEWS,
  inspectSourceAlarmReviews,
} from "../../src/node/source-alarm-review";
import { scanSourceAlarms } from "../../src/node/source-inventory";

const repositoryRoot = join(import.meta.dir, "../../../..");

const reviewedSourcePaths = [
  "packages/db/scripts/finalize-task-cancellation-staging.ts",
  "packages/db/scripts/finalize-task-crypto-lifecycle.ts",
  "packages/db/src/utils/strict-shadow-boundary-health.ts",
  "packages/lattice-bridge/src/server/memory/postgres-foreground-memory-publication.ts",
  "packages/runtime/src/tasks/lifecycle.ts",
  "packages/runtime/src/tasks/report-back.ts",
  "packages/runtime/src/tasks/resolve-task-memory-envelope.ts",
  "packages/runtime/src/tasks/task-observer.ts",
  "packages/server/src/routes/protected-task-runtime-initial-composition.ts",
  "packages/server/src/routes/task-occurrence-policy.ts",
] as const;

const protectedProviderDiagnosticPaths = [
  "packages/agent/src/subagents/deep-research/agent/graph.ts",
  "packages/agent/src/subagents/deep-research/researcher/graph.ts",
  "packages/agent/src/subagents/deep-research/supervisor/graph.ts",
  "packages/agent/src/tools/research/run-deep-research.ts",
  "packages/runtime/src/executors/deep-research-executor.ts",
] as const;

describe("Task protection inventory closure", () => {
  test("binds every added Task database writer to a known schema table", async () => {
    const schema = inventoryDrizzleSchema(nautiloSchema);
    const tableExports = Object.fromEntries(schema.objects
      .filter(object => object.kind === "table")
      .flatMap(object => object.exportNames.map(exportName => [
        exportName,
        object.locator,
      ])));
    const observed = new Set((await discoverDatabaseWriterInventory(
      repositoryRoot,
      tableExports,
    )).map(writer => writer.locator));

    expect(REVIEWED_TASK_PROTECTION_DATABASE_WRITER_LOCATORS).toHaveLength(67);
    expect(new Set(REVIEWED_TASK_PROTECTION_DATABASE_WRITER_LOCATORS).size)
      .toBe(67);
    for (const locator of REVIEWED_TASK_PROTECTION_DATABASE_WRITER_LOCATORS) {
      expect(observed).toContain(locator);
    }
    expect(SUPERSEDED_TASK_PROTECTION_DATABASE_WRITER_LOCATORS).toHaveLength(4);
    expect(new Set(SUPERSEDED_TASK_PROTECTION_DATABASE_WRITER_LOCATORS).size)
      .toBe(4);
    for (const locator of SUPERSEDED_TASK_PROTECTION_DATABASE_WRITER_LOCATORS) {
      expect(observed).not.toContain(locator);
    }
    expect(observed).toContain(
      "packages/db/src/queries/tasks.ts#acceptProtectedTaskHumanContinuation:update:public.jobs:1",
    );
    expect(observed).toContain(
      "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##replaceUnclaimedAuthority:delete:public.background_crypto_authorization_domain_requirements:1",
    );
    expect(observed).toContain(
      "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##replaceUnclaimedAuthority:delete:public.background_crypto_authorization_namespace_requirements:1",
    );
    expect(observed).toContain(
      "packages/runtime/src/protected-execution/background-authorization/postgres-repository.ts##replaceUnclaimedAuthority:update:public.background_crypto_authorization_requests:1",
    );
  });

  test("binds each reviewed Task HTTP declaration to the exact current DTO", async () => {
    const locators = new Set(REVIEWED_TASK_PROTECTION_DTO_DECLARATIONS.map(
      (declaration) => declaration.locator,
    ));
    const observations = (await discoverDtoInventory(repositoryRoot)).filter(
      (observation) => locators.has(observation.locator),
    );
    const effectiveDeclarations = DTO_BASELINE_DECLARATIONS.filter(
      (declaration) => locators.has(declaration.locator),
    );

    expect(REVIEWED_TASK_PROTECTION_DTO_DECLARATIONS).toHaveLength(38);
    expect(locators.size).toBe(38);
    expect(effectiveDeclarations).toHaveLength(38);
    expect(new Set(effectiveDeclarations.map((declaration) =>
      declaration.locator)).size).toBe(38);
    expect(observations).toHaveLength(38);
    expect(auditDtoDeclarations({
      observations,
      declarations: effectiveDeclarations,
    })).toEqual({
      ok: true,
      counts: {
        observations: 38,
        declarations: 38,
        arbitraryPayloads: 9,
      },
    });
    expect([...locators].filter((locator) =>
      locator.startsWith("http:request_response:POST /api/tasks/external-requests")
    )).toHaveLength(4);
    const fallbackDeclarations = new Map(effectiveDeclarations
      .filter((declaration) => declaration.locator.includes("ordinary-fallback"))
      .map((declaration) => [
        declaration.locator,
        declaration.structuralSignatures?.join("\n") ?? "",
      ]));
    expect(fallbackDeclarations.size).toBe(4);
    expect(fallbackDeclarations.get(
      "http:request_response:POST /api/protected/tasks/ordinary-fallback-plan",
    )).toContain('purpose:"task.ordinary_fallback.create"');
    expect(fallbackDeclarations.get(
      "http:request_response:POST /api/protected/tasks/:taskId/ordinary-fallback-plan",
    )).toContain('purpose:"task.ordinary_fallback.update"');
    expect(fallbackDeclarations.get(
      "http:request_response:POST /api/protected/tasks/ordinary-fallback",
    )).toContain("response.body:{nextFireAt:string;status:string;taskId:string}");
    expect(fallbackDeclarations.get(
      "http:request_response:PATCH /api/protected/tasks/:taskId/ordinary-fallback",
    )).toContain("content:{contentRevision:number;cryptoAccessRevision:number");
    for (const signature of fallbackDeclarations.values()) {
      expect(signature).not.toMatch(/catch:function|finally:function|then:function/);
    }
    expect(SUPERSEDED_TASK_PROTECTION_DTO_LOCATORS).toEqual(new Set([
      "http:request_response:GET /api/tasks",
      "http:request_response:GET /api/tasks/:id",
      "http:request_response:GET /api/tasks/:id/content-access-recovery",
      "http:request_response:GET /api/tasks/pending-attention",
      "http:request_response:PATCH /api/tasks/:id",
      "http:request_response:POST /api/tasks",
      "http:request_response:POST /api/tasks/:id/content-access-recovery",
    ]));
  });

  test("keeps every current Task diagnostic and migration finalizer explicitly reviewed", async () => {
    const scan = await scanSourceAlarms({
      repoRoot: repositoryRoot,
      scanRoots: reviewedSourcePaths,
    });
    const reviews = CURRENT_SOURCE_ALARM_REVIEWS.filter((review) =>
      reviewedSourcePaths.some((path) => review.locator.startsWith(`${path}#`))
    );
    const inspection = inspectSourceAlarmReviews(scan.alarms, reviews);

    expect(scan.errors).toEqual([]);
    expect(inspection.errors).toEqual([]);
    expect(inspection.counts.unmapped).toBe(0);
    expect(reviews.some((review) =>
      review.locator.includes("finalize-task-cancellation-staging.ts")
      && review.closure === "reviewed_exclusion"
    )).toBe(true);
    expect(reviews.some((review) =>
      review.locator.includes("resolve-task-memory-envelope.ts")
      && review.closure === "declaration"
    )).toBe(true);
    expect(scan.alarms.some((alarm) =>
      alarm.locator.startsWith(
        "packages/lattice-bridge/src/server/memory/postgres-foreground-memory-publication.ts#",
      )
    )).toBe(false);
  });

  test("keeps protected provider diagnostics closed without retiring ordinary log debt", async () => {
    const scan = await scanSourceAlarms({
      repoRoot: repositoryRoot,
      scanRoots: protectedProviderDiagnosticPaths,
    });
    const reviews = CURRENT_SOURCE_ALARM_REVIEWS.filter((review) =>
      protectedProviderDiagnosticPaths.some((path) =>
        review.locator.startsWith(`${path}#`)
      )
    );
    const inspection = inspectSourceAlarmReviews(scan.alarms, reviews);

    expect(scan.errors).toEqual([]);
    expect(scan.alarms).toHaveLength(11);
    expect(inspection.errors).toEqual([]);
    expect(inspection.counts).toEqual({
      baselineDebt: 4,
      declaration: 7,
      reviewedExclusion: 0,
      unmapped: 0,
    });
  });

  test("retires relocated dispatch diagnostics and the replaced observer diagnostic", () => {
    for (const occurrence of [2, 3, 4]) {
      expect(SUPERSEDED_TASK_FOUNDATION_SOURCE_ALARM_LOCATORS).toContain(
        `packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:0ae25e725db4e950:${occurrence}`,
      );
    }
    expect(SUPERSEDED_TASK_FOUNDATION_SOURCE_ALARM_LOCATORS).toContain(
      "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:3",
    );
    expect(SUPERSEDED_TASK_FOUNDATION_SOURCE_ALARM_LOCATORS).toContain(
      "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:8",
    );
  });
});
