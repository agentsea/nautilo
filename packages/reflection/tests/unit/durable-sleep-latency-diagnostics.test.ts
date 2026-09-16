import { describe, expect, test } from "bun:test";

import {
  DurableSleepLatencyWindow,
  type DurableSleepItemLatencySample,
} from "../../src/sleep/latency-diagnostics";

function sample(
  lane: DurableSleepItemLatencySample["lane"],
  endToEndElapsedMs: number,
): DurableSleepItemLatencySample {
  return {
    lane,
    queueElapsedMs: endToEndElapsedMs,
    claimStoreElapsedMs: 1,
    authorityElapsedMs: 2,
    searchProjectionElapsedMs: 3,
    sameRoomCandidateElapsedMs: 4,
    crossRoomCandidateElapsedMs: lane === "cross_room" ? 5 : 0,
    selectedOpenElapsedMs: 6,
    promptConstructionElapsedMs: 7,
    promptInputCount: 2,
    promptCodePoints: 100,
    modelElapsedMs: 8,
    modelAttempts: 1,
    modelRepairs: 0,
    modelFailures: 0,
    proposalValidationElapsedMs: 9,
    publicationPlanningElapsedMs: 10,
    finalAuthorityElapsedMs: 11,
    productPublicationElapsedMs: 12,
    completionElapsedMs: 13,
    recursiveAdmissionElapsedMs: 14,
    endToEndElapsedMs,
  };
}

describe("durable Sleep latency diagnostics", () => {
  test("keeps a bounded rolling window and reports nearest-rank percentiles by lane", () => {
    const window = new DurableSleepLatencyWindow(4);
    window.add([
      sample("same_room", 10),
      sample("same_room", 20),
      sample("cross_room", 30),
      sample("same_room", 40),
      sample("same_room", 50),
    ]);

    expect(window.snapshot()).toMatchObject({
      sameRoom: {
        endToEnd: { samples: 3, p50Ms: 40, p90Ms: 50, maximumMs: 50 },
      },
      crossRoom: {
        endToEnd: { samples: 1, p50Ms: 30, p90Ms: 30, maximumMs: 30 },
      },
    });
  });

  test("rejects invalid counters and resets with a new process-local window", () => {
    const invalid = { ...sample("same_room", 10), modelRepairs: 2 };
    expect(() => new DurableSleepLatencyWindow().add([invalid])).toThrow(
      "repair count",
    );
    const restarted = new DurableSleepLatencyWindow();
    expect(restarted.snapshot().sameRoom.endToEnd.samples).toBe(0);
  });
});
