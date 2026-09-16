import { describe, expect, test } from "bun:test";
import { TASK_SUMMARY_HIERARCHY_FIXTURES } from "../../../../dev/fixtures/task-summary-hierarchy";
import { toTaskSummary, toOwnerVisibleTaskSummary } from "../../src/routes/tasks";

function source(
  hierarchy: { parentTaskId: string | null; depth: number },
) {
  return {
    id: "task-1",
    ...hierarchy,
    status: "running" as const,
    preset: "task" as const,
    metadata: {},
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
