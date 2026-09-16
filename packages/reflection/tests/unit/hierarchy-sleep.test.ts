import { describe, expect, test } from "bun:test";
import type { RecordLifecycle } from "../../src/contracts/hierarchy";
import { InMemoryHierarchyRepository } from "../../src/graph/in-memory-repository";
import { SyntheticHierarchyBridge } from "../../src/graph/synthetic-bridge";
import {
  enqueueScheduledSleepPage,
  HierarchySleepQueue,
  runHierarchySleep,
} from "../../src/sleep/executor";

const audience = { kind: "access" as const, humanRefs: ["casey", "alex"] };
const budget = {
  maxModelCalls: 20,
  maxVisitedRecords: 100,
  maxCreatedRecords: 10,
  maxTraversalWork: 100,
  maxStatementCharacters: 800,
};

function fixture(recordRef: string, lifecycle: RecordLifecycle = "current") {
  return {
    snapshot: {
      recordRef,
      observedContentFingerprint: `fingerprint:${recordRef}`,
      posture: "derived" as const,
      anchors: [],
      statement: `Evidence ${recordRef}`,
      sourceRefs: [],
      childRecordRefs: [],
      structuralHeight: 0,
      lifecycle,
    },
    audience,
    initialPublicationScope: audience,
  };
}

function harness(records = [fixture("a"), fixture("b")]) {
  const repository = new InMemoryHierarchyRepository();
  const bridge = new SyntheticHierarchyBridge({
    repository,
    idGenerator: ({ idempotencyKey }) => `parent-${idempotencyKey}`,
  });
  for (const record of records) bridge.seedEligibleRecord(record, budget);
  return { repository, bridge };
}

describe("pure hierarchy Sleep", () => {
  test("coalesces changes and preserves a newer generation enqueued during a run", async () => {
    const { repository, bridge } = harness();
    const queue = new HierarchySleepQueue();
    queue.enqueue({ logicalObjectRef: "logical-a", generation: 1, recordRef: "a", changeReason: "revised" });
    queue.enqueue({ logicalObjectRef: "logical-a", generation: 2, recordRef: "a", changeReason: "revised" });
    let invoked = false;
    const result = await runHierarchySleep({
      queue,
      repository,
      bridge,
      view: () => ({
        candidateRecordRefs: ["b"],
        existingParentRecordRefs: [],
        eligibleRecordRefs: ["a", "b"],
        initialPublicationScope: audience,
        maxSelectedChildren: 4,
      }),
      invoke: () => {
        if (!invoked) {
          invoked = true;
          queue.enqueue({ logicalObjectRef: "logical-a", generation: 3, recordRef: "a", changeReason: "revised" });
        }
        return Promise.resolve('{"operation":"no_change"}');
      },
      budget: { ...budget, maxModelCalls: 2, maxCreatedRecords: 1 },
    });
    expect(result.applied).toHaveLength(1);
    expect(result.continuation?.pending).toEqual([{
      logicalObjectRef: "logical-a",
      generation: 3,
      recordRef: "a",
      changeReason: "revised",
    }]);
  });

  test("recursively considers a created parent and then converges", async () => {
    const { repository, bridge } = harness();
    const queue = new HierarchySleepQueue();
    queue.enqueue({ logicalObjectRef: "a", generation: 0, recordRef: "a", changeReason: "created" });
    const responses = [
      '{"operation":"create_parent","statement":"A and B belong together.","childRecordRefs":["C0","R1"]}',
      '{"operation":"no_change"}',
    ];
    const result = await runHierarchySleep({
      queue,
      repository,
      bridge,
      view: (changed) => ({
        candidateRecordRefs: changed === "a" ? ["b"] : [],
        existingParentRecordRefs: [],
        eligibleRecordRefs: repository.list().map((record) => record.snapshot.recordRef),
        initialPublicationScope: audience,
        maxSelectedChildren: 4,
      }),
      invoke: () => Promise.resolve(responses.shift()!),
      budget,
    });
    expect(result.applied.map((entry) => entry.operation)).toEqual([
      "create_parent",
      "no_change",
    ]);
    expect(result.continuation).toBeUndefined();
    expect(repository.list()).toHaveLength(3);
  });

  test("returns continuation before doing semantic work when the run is exhausted", async () => {
    const { repository, bridge } = harness();
    const queue = new HierarchySleepQueue();
    queue.enqueue({ logicalObjectRef: "a", generation: 0, recordRef: "a", changeReason: "created" });
    let called = false;
    const result = await runHierarchySleep({
      queue,
      repository,
      bridge,
      view: () => { called = true; throw new Error("not reached"); },
      invoke: () => Promise.resolve('{"operation":"no_change"}'),
      budget: { ...budget, maxModelCalls: 1 },
    });
    expect(called).toBe(false);
    expect(result.continuation?.pending).toHaveLength(1);
  });

  test("does not exceed work budgets after seeing a large eligible view", async () => {
    const { repository, bridge } = harness();
    const queue = new HierarchySleepQueue();
    queue.enqueue({ logicalObjectRef: "a", generation: 0, recordRef: "a", changeReason: "created" });
    let invoked = false;
    const result = await runHierarchySleep({
      queue,
      repository,
      bridge,
      view: () => ({
        candidateRecordRefs: ["b"],
        existingParentRecordRefs: [],
        eligibleRecordRefs: ["a", "b"],
        initialPublicationScope: audience,
        maxSelectedChildren: 4,
      }),
      invoke: () => { invoked = true; return Promise.resolve('{"operation":"no_change"}'); },
      budget: { ...budget, maxVisitedRecords: 2, maxTraversalWork: 2 },
    });
    expect(invoked).toBe(false);
    expect(result.usage).toEqual({
      modelCalls: 0,
      visitedRecords: 0,
      createdRecords: 0,
      traversalWork: 0,
    });
    expect(result.continuation?.pending).toHaveLength(1);
  });

  test("scheduled pages include all retained lifecycle states", () => {
    const records = (["current", "stale", "superseded", "resolved", "sunset"] as const)
      .map((lifecycle, index) => fixture(`r${index}`, lifecycle));
    const { repository } = harness(records);
    const queue = new HierarchySleepQueue();
    const first = enqueueScheduledSleepPage({ queue, repository, pageSize: 2 });
    expect(first.checkpoint).toBeDefined();
    const second = enqueueScheduledSleepPage({
      queue,
      repository,
      pageSize: 2,
      checkpoint: first.checkpoint!,
    });
    expect(second.checkpoint).toBeDefined();
    const third = enqueueScheduledSleepPage({
      queue,
      repository,
      pageSize: 2,
      checkpoint: second.checkpoint!,
    });
    expect([...first.enqueuedRecordRefs, ...second.enqueuedRecordRefs, ...third.enqueuedRecordRefs])
      .toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(third.checkpoint).toBeUndefined();
    expect(() => enqueueScheduledSleepPage({
      queue,
      repository,
      pageSize: 2,
      checkpoint: { afterRecordRef: "unknown" },
    })).toThrow("checkpoint is unknown");
  });
});
