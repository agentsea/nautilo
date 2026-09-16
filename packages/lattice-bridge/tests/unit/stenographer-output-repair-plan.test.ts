import {describe, expect, test} from "bun:test";

import {
  decodeStenographerOutputRepairPlan,
  encodeStenographerOutputRepairPlan,
  type StenographerOutputRepairPlan,
} from "../../src/journal/stenographer-output-repair-plan.ts";

const ROOM = "10000000-0000-4000-8000-000000000001";
const NAMESPACE = "20000000-0000-4000-8000-000000000001";
const BATCH = "30000000-0000-4000-8000-000000000001";
const EVENT = "40000000-0000-4000-8000-000000000001";
const CREATED = "2026-09-10T09:00:00.000Z";

function fixture(): StenographerOutputRepairPlan {
  return {
    version: 2,
    binding: {
      receipt: {
        kind: "extraction",
        id: BATCH,
        roomId: ROOM,
        namespaceId: NAMESPACE,
        rebuildGeneration: 4,
        fallbackReason: "device",
        ordinaryOutputFingerprint: new Uint8Array(32).fill(7),
      },
      outputs: [{
        logicalId: EVENT,
        objectId: `repair/${EVENT}`,
        objectType: "nautilo.reflection.record.v1",
        createdAt: Date.parse(CREATED),
        disposition: "create",
        representationGeneration: 1,
        ordinaryRepresentationGeneration: 2,
      }],
    },
    snapshot: {
      roomId: ROOM,
      namespaceId: NAMESPACE,
      rebuildGeneration: 4,
      rollup: null,
      events: [{
        kind: "event",
        rebuildGeneration: 4,
        status: "active",
        binding: {
          eventId: EVENT,
          roomId: ROOM,
          namespaceId: NAMESPACE,
          sequence: 21,
          kind: "fact",
          supersedesEventId: null,
          resolvesEventId: null,
          sourceMessageIds: [7],
          sourceBatchId: BATCH,
          batchLocalOrdinal: 0,
          extractorVersion: "m219-v1",
          createdAt: CREATED,
        },
        payload: {
          kind: "reflection_record",
          recordId: EVENT,
          lifecycle: "current",
          structuralHeight: 0,
          processingGeneration: 2,
          ordinaryRepresentationGeneration: 2,
          protectedMapping: {status: "missing"},
        },
      }],
    },
  };
}

describe("Stenographer output repair plan codec", () => {
  test("round-trips the complete metadata inventory canonically", () => {
    const bytes = encodeStenographerOutputRepairPlan(fixture());
    const decoded = decodeStenographerOutputRepairPlan(bytes);
    const canonical = encodeStenographerOutputRepairPlan(decoded);
    expect(canonical).toEqual(bytes);
    expect(decoded).toEqual(fixture());
  });

  test("rejects generation and output-inventory tampering", () => {
    const original = fixture();
    expect(() => encodeStenographerOutputRepairPlan({
      ...original,
      snapshot: {...original.snapshot, rebuildGeneration: 5},
    })).toThrow("scope differs");
    expect(() => encodeStenographerOutputRepairPlan({
      ...original,
      binding: {
        ...original.binding,
        outputs: [{...original.binding.outputs[0]!, logicalId: "substitute"}],
      },
    })).toThrow("differs from its snapshot");
    expect(() => encodeStenographerOutputRepairPlan({
      ...original,
      binding: {...original.binding, outputs: []},
    })).toThrow("outputs");
  });
});
