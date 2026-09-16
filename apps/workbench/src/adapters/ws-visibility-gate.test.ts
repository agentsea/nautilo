import { describe, expect, it } from "vitest";
import {
  VISIBILITY_HIDDEN_DEBOUNCE_MS,
  createVisibilityGate,
  shouldHandleVisibility,
} from "./ws-visibility-gate";

/**
 * Stack 19 Phase 5.5 regression suite — the WS visibility gate.
 *
 * Pin the contract that the original Phase 5 implementation
 * violated:
 *
 *   1. Electron: never suspend on visibility.
 *   2. Browser: 30s debounce on hidden→suspend.
 *   3. Browser: immediate resume.
 *   4. Browser: short tab-switch (< 30s) does NOT churn the WS.
 *   5. Browser: long absence (≥ 30s) still suspends.
 *   6. Browser: rapid visibility flap does not double-suspend.
 *
 * Pre-fix behavior (asserted absent): suspend fired on the FIRST
 * `visibilitychange → hidden` regardless of duration; resume fired
 * on the FIRST `visible` regardless of prior state. That produced
 * the 5-reconnects-in-5-minutes storm captured in s19fresh smoke
 * (2026-05-16 16:11-16:16Z server log).
 */

interface FakeClock {
  now: number;
  setTimer: (cb: () => void, ms: number) => number;
  clearTimer: (h: number) => void;
  tick: (ms: number) => void;
}

function fakeClock(): FakeClock {
  const handles = new Map<number, { cb: () => void; firesAt: number }>();
  let nextId = 1;
  const c: FakeClock = {
    now: 0,
    setTimer(cb, ms) {
      const id = nextId++;
      handles.set(id, { cb, firesAt: c.now + ms });
      return id;
    },
    clearTimer(h) {
      handles.delete(h);
    },
    tick(ms) {
      const target = c.now + ms;
      while (true) {
        let next: { id: number; firesAt: number; cb: () => void } | null = null;
        for (const [id, h] of handles) {
          if (h.firesAt <= target && (next === null || h.firesAt < next.firesAt)) {
            next = { id, firesAt: h.firesAt, cb: h.cb };
          }
        }
        if (next === null) break;
        handles.delete(next.id);
        c.now = next.firesAt;
        next.cb();
      }
      c.now = target;
    },
  };
  return c;
}

interface Counters {
  suspendCalls: number;
  resumeCalls: number;
  suspendedHistory: boolean[];
}

interface TestRig {
  clock: FakeClock;
  visibility: { value: "hidden" | "visible" };
  counters: Counters;
  gate: ReturnType<typeof createVisibilityGate>;
}

function makeRig(): TestRig {
  const clock = fakeClock();
  const visibility = { value: "visible" as "hidden" | "visible" };
  const counters: Counters = { suspendCalls: 0, resumeCalls: 0, suspendedHistory: [] };
  const gate = createVisibilityGate({
    suspend: () => {
      counters.suspendCalls++;
    },
    resume: () => {
      counters.resumeCalls++;
    },
    onSuspendedChange: (s) => {
      counters.suspendedHistory.push(s);
    },
    setTimer: (cb, ms) => clock.setTimer(cb, ms) as unknown as ReturnType<typeof setTimeout>,
    clearTimer: (h) => clock.clearTimer(h as unknown as number),
    readVisibility: () => visibility.value,
  });
  return { clock, visibility, counters, gate };
}

describe("shouldHandleVisibility (Stack 19 Phase 5.5)", () => {
  it("returns false for Electron desktop (never suspend on visibility)", () => {
    expect(shouldHandleVisibility(true)).toBe(false);
  });
  it("returns true for browser", () => {
    expect(shouldHandleVisibility(false)).toBe(true);
  });
});

describe("createVisibilityGate (Stack 19 Phase 5.5 debounce)", () => {
  it("starts idle", () => {
    const rig = makeRig();
    expect(rig.gate.state()).toBe("idle");
    expect(rig.counters.suspendCalls).toBe(0);
    expect(rig.counters.resumeCalls).toBe(0);
  });

  it("REGRESSION: short hidden flap (< 30s) does NOT suspend (pre-fix WOULD have suspended immediately)", () => {
    const rig = makeRig();
    rig.visibility.value = "hidden";
    rig.gate.onVisibilityChange();
    expect(rig.gate.state()).toBe("pending-suspend");
    rig.clock.tick(5_000);
    expect(rig.counters.suspendCalls).toBe(0);
    rig.visibility.value = "visible";
    rig.gate.onVisibilityChange();
    expect(rig.gate.state()).toBe("idle");
    expect(rig.counters.suspendCalls).toBe(0);
    expect(rig.counters.resumeCalls).toBe(0);
  });

  it("REGRESSION: rapid flap storm (10 cycles in 30s) does NOT churn — zero suspends, zero resumes", () => {
    const rig = makeRig();
    for (let i = 0; i < 10; i++) {
      rig.visibility.value = "hidden";
      rig.gate.onVisibilityChange();
      rig.clock.tick(1_000);
      rig.visibility.value = "visible";
      rig.gate.onVisibilityChange();
      rig.clock.tick(1_000);
    }
    expect(rig.counters.suspendCalls).toBe(0);
    expect(rig.counters.resumeCalls).toBe(0);
    expect(rig.gate.state()).toBe("idle");
  });

  it("hidden continuously for 30s DOES suspend exactly once", () => {
    const rig = makeRig();
    rig.visibility.value = "hidden";
    rig.gate.onVisibilityChange();
    rig.clock.tick(VISIBILITY_HIDDEN_DEBOUNCE_MS);
    expect(rig.counters.suspendCalls).toBe(1);
    expect(rig.gate.state()).toBe("suspended");
    expect(rig.counters.suspendedHistory).toEqual([true]);
  });

  it("hidden ≥ 30s then visible: suspend then resume, each exactly once", () => {
    const rig = makeRig();
    rig.visibility.value = "hidden";
    rig.gate.onVisibilityChange();
    rig.clock.tick(VISIBILITY_HIDDEN_DEBOUNCE_MS);
    expect(rig.counters.suspendCalls).toBe(1);
    rig.visibility.value = "visible";
    rig.gate.onVisibilityChange();
    expect(rig.counters.resumeCalls).toBe(1);
    expect(rig.gate.state()).toBe("idle");
    expect(rig.counters.suspendedHistory).toEqual([true, false]);
  });

  it("after suspend, repeated hidden events do not re-suspend", () => {
    const rig = makeRig();
    rig.visibility.value = "hidden";
    rig.gate.onVisibilityChange();
    rig.clock.tick(VISIBILITY_HIDDEN_DEBOUNCE_MS);
    rig.gate.onVisibilityChange();
    rig.gate.onVisibilityChange();
    expect(rig.counters.suspendCalls).toBe(1);
  });

  it("visible while idle (never suspended) does not call resume", () => {
    const rig = makeRig();
    rig.visibility.value = "visible";
    rig.gate.onVisibilityChange();
    rig.gate.onVisibilityChange();
    expect(rig.counters.resumeCalls).toBe(0);
  });

  it("dispose cancels pending suspend before fire", () => {
    const rig = makeRig();
    rig.visibility.value = "hidden";
    rig.gate.onVisibilityChange();
    expect(rig.gate.state()).toBe("pending-suspend");
    rig.gate.dispose();
    rig.clock.tick(VISIBILITY_HIDDEN_DEBOUNCE_MS * 2);
    expect(rig.counters.suspendCalls).toBe(0);
  });

  it("debounce constant matches the documented 30s contract", () => {
    expect(VISIBILITY_HIDDEN_DEBOUNCE_MS).toBe(30_000);
  });
});
