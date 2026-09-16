import { describe, expect, test } from "bun:test";

import {
  planProtectedStenographerCompaction,
  PROTECTED_STENOGRAPHER_COMPACTION_EVENT_TRIGGER,
  PROTECTED_STENOGRAPHER_COMPACTION_MAX_EVENT_INPUTS,
} from "../../src/stenographer/protected-stenographer-compaction-planner";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "20000000-0000-4000-8000-000000000001";
const BATCH_ID = "30000000-0000-4000-8000-000000000001";

function event(sequence: number) {
  return {
    eventId:
      `40000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    objectId: `journal-event-object-${sequence}`,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    sequence,
    kind: "fact" as const,
    status: "active" as const,
    supersedesEventId: null,
    resolvesEventId: null,
    sourceMessageIds: [sequence],
    sourceBatchId: BATCH_ID,
    batchLocalOrdinal: sequence - 1,
    extractorVersion: "m241-v1",
    createdAt: "2026-08-04T12:00:00.000Z",
  };
}

describe("protected Stenographer compaction metadata planner", () => {
  test("waits below the conservative worst-case event threshold and authorizes at it", () => {
    expect(
      planProtectedStenographerCompaction({
        events: Array.from(
          { length: PROTECTED_STENOGRAPHER_COMPACTION_EVENT_TRIGGER - 1 },
          (_, index) => event(index + 1),
        ),
        latestRollup: null,
      }),
    ).toEqual({ status: "wait", reason: "not_due" });

    const planned = planProtectedStenographerCompaction({
      events: Array.from(
        { length: PROTECTED_STENOGRAPHER_COMPACTION_EVENT_TRIGGER },
        (_, index) => event(index + 1),
      ),
      latestRollup: null,
    });
    expect(planned.status).toBe("authorize");
    if (planned.status !== "authorize") return;
    expect(planned.bindings).toHaveLength(
      PROTECTED_STENOGRAPHER_COMPACTION_EVENT_TRIGGER,
    );
    expect(planned.inputObjectIds[0]).toBe("journal-event-object-1");
    expect(planned.sourceBindingFingerprint).toHaveLength(32);
    expect(JSON.stringify(planned)).not.toContain("statement");
    expect(JSON.stringify(planned)).not.toContain("content");
  });

  test("keeps the oldest compactable prefix and newest protected tail within the exact input bound", () => {
    const planned = planProtectedStenographerCompaction({
      events: Array.from({ length: 1_000 }, (_, index) => event(index + 2)),
      latestRollup: {
        rollupId: "50000000-0000-4000-8000-000000000001",
        objectId: "journal-rollup-object-0",
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        throughEventSequence: 1,
        sourceEventCount: 1,
        modelId: "model-v1",
        compactorVersion: "m241-v1",
        createdAt: "2026-08-04T11:00:00.000Z",
      },
    });
    expect(planned.status).toBe("authorize");
    if (planned.status !== "authorize") return;
    expect(planned.bindings).toHaveLength(
      PROTECTED_STENOGRAPHER_COMPACTION_MAX_EVENT_INPUTS + 1,
    );
    expect(planned.inputObjectIds[0]).toBe("journal-rollup-object-0");
    expect(planned.inputObjectIds[1]).toBe("journal-event-object-2");
    expect(planned.inputObjectIds.at(-1)).toBe("journal-event-object-1001");
    expect(new Set(planned.inputObjectIds).size)
      .toBe(planned.inputObjectIds.length);
  });

  test("blocks duplicate, cross-Room, out-of-order, and missing crypto mappings without opening content", () => {
    const cases = [
      [event(1), event(1)],
      [
        event(1),
        { ...event(2), roomId: "10000000-0000-4000-8000-000000000099" },
      ],
      [event(2), event(1)],
      [{ ...event(1), objectId: null }],
    ];
    for (const events of cases) {
      expect(
        planProtectedStenographerCompaction({
          events: events as never,
          latestRollup: null,
          force: true,
        }),
      ).toMatchObject({ status: "blocked" });
    }
  });
});
