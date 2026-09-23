import { describe, expect, test } from "bun:test";
import { TASK_SUMMARY_HIERARCHY_FIXTURES } from "../../../../dev/fixtures/task-summary-hierarchy";
import { toTaskSummary, toOwnerVisibleTaskSummary, toTaskContentSummaryV1 } from "../../src/routes/tasks";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type { Task } from "@nautilo/db";

function source(
  hierarchy: { parentTaskId: string | null; depth: number },
) {
  return {
    id: "task-1",
    ...hierarchy,
    status: "running" as const,
    preset: "task" as const,
    metadata: {},
    contentRepresentation: "ordinary" as const,
    prompt: "Map the canonical hierarchy",
    scheduleKind: "now" as const,
    cron: null,
    nextFireAt: null,
    callingRoomId: null,
    lastError: null,
  };
}

describe("toTaskSummary hierarchy contract", () => {
  const fixture = TASK_SUMMARY_HIERARCHY_FIXTURES;

  test("maps a root with explicit null parent and depth zero", () => {
    expect(
      toTaskSummary(
        source({ parentTaskId: null, depth: fixture.root.expectedDepth }),
      ),
    ).toMatchObject({ parentTaskId: null, depth: 0 });
  });

  test("maps a nested Task without reconstructing its hierarchy", () => {
    expect(
      toTaskSummary(
        source({
          parentTaskId: "parent-task-id",
          depth: fixture.nested.expectedDepth,
        }),
      ),
    ).toMatchObject({ parentTaskId: "parent-task-id", depth: 1 });
  });

  test("preserves orphaned lineage as null parent with non-zero depth", () => {
    expect(
      toTaskSummary(
        source({
          parentTaskId: null,
          depth: fixture.orphanedLineage.expectedDepth,
        }),
      ),
    ).toMatchObject({ parentTaskId: null, depth: 1 });
  });
});

test("legacy summary mapping refuses protected content instead of treating an empty prompt as success", () => {
  expect(() => toTaskSummary({
    ...source({ parentTaskId: null, depth: 0 }),
    contentRepresentation: "protected",
    prompt: "",
  })).toThrow("Protected Task content requires the current client projection");
});


test("research Resume is an explicit owner enrichment, never model metadata", () => {
  const row = { ...source({ parentTaskId: null, depth: 0 }), status: "errored" as const,
    metadata: { canResumeResearch: true }, agentId: "agent-1", targetRoomId: null,
    createdAt: new Date("2026-09-08T00:00:00Z"), requestedModelId: null };
  expect(toTaskSummary(row).canResumeResearch).toBeUndefined();
  const owner = { agentName: "Genie", lastModelId: null };
  expect(toOwnerVisibleTaskSummary(row, owner).canResumeResearch).toBeUndefined();
  expect(toOwnerVisibleTaskSummary(row, { ...owner, canResumeResearch: false }).canResumeResearch).toBeUndefined();
  expect(toOwnerVisibleTaskSummary(row, { ...owner, canResumeResearch: true }).canResumeResearch).toBe(true);
});

test("current Task summary projects verified protected coordinates without plaintext", () => {
  const id = "91000000-0000-4000-8000-000000000001";
  const protectedTask = {
    ...source({ parentTaskId: null, depth: 0 }),
    id,
    contentRepresentation: "protected",
    contentNamespaceId: "91000000-0000-4000-8000-000000000002",
    contentRevision: 1,
    cryptoObjectId: deriveTaskContentCryptoObjectIdV1({ kind: "definition", taskId: id, contentRevision: 1 }),
    cryptoAccessRevision: 0,
    cryptoMappingState: "verified",
    prompt: "SECRET TASK PROMPT",
    expectedOutput: "SECRET EXPECTATION",
    lastError: "SECRET ERROR",
    metadata: { preparation: { researchWork: { subject: "SECRET SUBJECT" } } },
    agentId: "91000000-0000-4000-8000-000000000003",
    targetRoomId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    requestedModelId: null,
  } as unknown as Task;
  const summary = toTaskContentSummaryV1(protectedTask, {
    agentName: "Genie", lastModelId: null,
  });
  expect(summary.content).toEqual({
    dtoVersion: 1, status: "protected", objectId: protectedTask.cryptoObjectId!,
    contentRevision: 1, cryptoAccessRevision: 0,
  });
  const encoded = JSON.stringify(summary);
  for (const secret of ["SECRET TASK PROMPT", "SECRET EXPECTATION", "SECRET ERROR", "SECRET SUBJECT"]) {
    expect(encoded).not.toContain(secret);
  }
  expect(toTaskContentSummaryV1({ ...protectedTask, cryptoMappingState: "stale" }, {
    agentName: null, lastModelId: null,
  }).content).toEqual({ dtoVersion: 1, status: "unavailable", reason: "authority_changed" });
  expect(toTaskContentSummaryV1({ ...protectedTask, cryptoObjectId: "wrong" }, {
    agentName: null, lastModelId: null,
  }).content).toEqual({ dtoVersion: 1, status: "unavailable", reason: "integrity_failure" });
  expect(toTaskContentSummaryV1({
    ...protectedTask, contentRepresentation: "ordinary", contentRevision: 0,
  }, {
    agentName: null, lastModelId: null,
    pendingDefinitionReason: "waiting_for_authorization",
  }).content).toEqual({
    dtoVersion: 1, status: "unavailable", reason: "waiting_for_authorization",
  });
});
