import { describe, expect, it } from "vitest";
import {
  ROOM_HYDRATION_SERVER_LATENCY_MAP,
  createRoomHydrationTiming,
} from "./room-hydration-timing";

function fakeClock(initial = 0): { now: () => number; advance: (ms: number) => void } {
  let time = initial;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

describe("createRoomHydrationTiming", () => {
  it("partitions an ordered Room selection, token, history, and transcript commit", () => {
    const clock = fakeClock(100);
    const timing = createRoomHydrationTiming(clock);
    const attempt = timing.start(7);

    clock.advance(25);
    expect(attempt.tokenReady()).toMatchObject({ accepted: true, snapshot: { state: "token_ready" } });
    clock.advance(80);
    expect(attempt.historyResponse()).toMatchObject({ accepted: true, snapshot: { state: "history_response" } });
    clock.advance(15);
    const committed = attempt.transcriptCommitted();

    expect(committed).toEqual({
      accepted: true,
      snapshot: {
        generation: 7,
        state: "committed",
        durations: {
          selectionToTokenReady: 25,
          tokenReadyToHistoryResponse: 80,
          selectionToHistoryResponse: 105,
          historyResponseToTranscriptCommit: 15,
          selectionToTranscriptCommit: 120,
        },
      },
    });
  });

  it("rejects invalid phase order and records a payload-free terminal failure", () => {
    const timing = createRoomHydrationTiming(fakeClock());
    const attempt = timing.start(1);

    expect(attempt.historyResponse()).toMatchObject({
      accepted: false,
      reason: "out_of_order",
      snapshot: { state: "selected" },
    });
    expect(attempt.transcriptCommitted()).toMatchObject({
      accepted: false,
      reason: "out_of_order",
      snapshot: { state: "selected" },
    });
    expect(attempt.failed()).toMatchObject({ accepted: true, snapshot: { state: "failed" } });
    expect(attempt.tokenReady()).toMatchObject({
      accepted: false,
      reason: "terminal",
      snapshot: { state: "failed" },
    });
  });

  it("supersedes late callbacks when a newer Room generation starts", () => {
    const clock = fakeClock();
    const timing = createRoomHydrationTiming(clock);
    const first = timing.start(4);
    clock.advance(10);
    const second = timing.start(5);

    expect(first.snapshot()).toMatchObject({ generation: 4, state: "superseded" });
    expect(first.tokenReady()).toMatchObject({ accepted: false, reason: "superseded" });
    expect(second.tokenReady()).toMatchObject({ accepted: true, snapshot: { state: "token_ready" } });
    expect(() => timing.start(5)).toThrow(/increase monotonically/);
    expect(() => timing.start(-1)).toThrow(/non-negative safe integer/);
  });

  it("makes an injected slow history response deterministic without sleeps", () => {
    const clock = fakeClock();
    const attempt = createRoomHydrationTiming(clock).start(3);

    clock.advance(4);
    attempt.tokenReady();
    clock.advance(3_000);
    attempt.historyResponse();
    clock.advance(12);
    const result = attempt.transcriptCommitted();

    expect(result).toMatchObject({
      accepted: true,
      snapshot: {
        durations: {
          tokenReadyToHistoryResponse: 3_000,
          historyResponseToTranscriptCommit: 12,
          selectionToTranscriptCommit: 3_016,
        },
      },
    });
  });

  it("has no arbitrary metadata channel or automatic logging surface", () => {
    const timing = createRoomHydrationTiming(fakeClock());
    const attempt = timing.start(2);
    const bearer = "Bearer must-not-enter-a-timing-trace";

    // The public marker accepts no metadata. Extra JavaScript arguments are
    // ignored, proving they cannot be retained in the timing snapshot.
    (attempt.tokenReady as unknown as (metadata: { bearer: string; roomLabel: string }) => unknown)({
      bearer,
      roomLabel: "private Room",
    });
    const serialized = JSON.stringify(attempt.snapshot());

    expect(attempt.tokenReady.length).toBe(0);
    expect(attempt.historyResponse.length).toBe(0);
    expect(attempt.transcriptCommitted.length).toBe(0);
    expect(serialized).not.toContain(bearer);
    expect(serialized).not.toContain("private Room");
    expect(Object.keys(attempt.snapshot())).toEqual(["generation", "state", "durations"]);
  });

  it("keeps the server breakdown categorical and read-only", () => {
    expect(ROOM_HYDRATION_SERVER_LATENCY_MAP.map((entry) => entry.phase)).toEqual([
      "membership_admission",
      "message_page_query",
      "reaction_enrichment",
      "artifact_enrichment",
      "response_completion",
    ]);
    expect(ROOM_HYDRATION_SERVER_LATENCY_MAP.every(
      (entry) => entry.endpoint === "/api/rooms/:id/messages",
    )).toBe(true);
    expect(Object.isFrozen(ROOM_HYDRATION_SERVER_LATENCY_MAP)).toBe(true);
    expect(Object.isFrozen(ROOM_HYDRATION_SERVER_LATENCY_MAP[0])).toBe(true);
  });
});
