import { describe, expect, test } from "bun:test";

import {
  advanceRealtimeOpenState,
  initialRealtimeOpenState,
  settleRealtimeIdentityRefresh,
  visibleRealtimeOpenState,
} from "./realtime-open-state";

describe("mobile realtime open lifecycle", () => {
  test("distinguishes the first authenticated open from reconnects", () => {
    const first = advanceRealtimeOpenState(initialRealtimeOpenState("server-a"), "server-a");
    expect(first).toEqual({
      kind: "initial",
      needsIdentityRefresh: false,
      state: { scopeId: "server-a", settled: true, openRevision: 1, recoveryRevision: 0 },
    });

    const second = advanceRealtimeOpenState(first.state, "server-a");
    expect(second).toEqual({
      kind: "reconnect",
      needsIdentityRefresh: true,
      state: { scopeId: "server-a", settled: true, openRevision: 2, recoveryRevision: 1 },
    });
  });

  test("treats a stale first open as recovery without double-counting later reconnects", () => {
    const first = advanceRealtimeOpenState(
      initialRealtimeOpenState("server-a"),
      "server-a",
      { viewerVerified: false },
    );
    expect(first.needsIdentityRefresh).toBe(true);
    expect(first.state).toEqual({
      scopeId: "server-a",
      settled: true,
      openRevision: 1,
      recoveryRevision: 1,
    });
    expect(advanceRealtimeOpenState(first.state, "server-a").state.recoveryRevision).toBe(2);
  });

  test("a new Server scope starts with an initial open", () => {
    const prior = advanceRealtimeOpenState(
      advanceRealtimeOpenState(initialRealtimeOpenState("server-a"), "server-a").state,
      "server-a",
    );
    expect(advanceRealtimeOpenState(prior.state, "server-b")).toEqual({
      kind: "initial",
      needsIdentityRefresh: false,
      state: { scopeId: "server-b", settled: true, openRevision: 1, recoveryRevision: 0 },
    });
  });

  test("masks unsettled and prior-Server revisions at the render boundary", () => {
    const openA = advanceRealtimeOpenState(
      advanceRealtimeOpenState(initialRealtimeOpenState("server-a"), "server-a").state,
      "server-a",
    ).state;
    expect(visibleRealtimeOpenState(openA, "server-b")).toEqual(initialRealtimeOpenState("server-b"));
    expect(visibleRealtimeOpenState({ ...openA, settled: false }, "server-a")).toEqual(
      initialRealtimeOpenState("server-a"),
    );
    expect(visibleRealtimeOpenState(openA, "server-a")).toBe(openA);
  });

  test("waits for a superseding viewer refresh before publishing recovery", async () => {
    const results = ["stale", "verified"] as const;
    let calls = 0;
    expect(await settleRealtimeIdentityRefresh(
      async () => results[calls++] ?? "failed",
      () => true,
    )).toBe(true);
    expect(calls).toBe(2);
  });

  test("abandons identity repair when the socket open loses ownership", async () => {
    let current = true;
    expect(await settleRealtimeIdentityRefresh(
      async () => {
        current = false;
        return "stale";
      },
      () => current,
    )).toBe(false);
  });
});
