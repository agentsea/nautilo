import { describe, expect, test } from "bun:test";
import {
  AcpTurnCancellationCoordinator,
  AcpTurnFaultOwner,
  AcpTurnSettlementGate,
  type AcpProcessScope,
  type AcpRelayClock,
  type AcpTurnResult,
} from "../../src/index.js";

const SCOPE: AcpProcessScope = {
  connectionId: "connection-1",
  processGeneration: 2,
  acpSessionId: "session-1",
  turnGeneration: 3,
  turnRef: "turn-1",
};

class Clock implements AcpRelayClock {
  #now = 0;
  #next = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.#now; }
  setTimeout(callback: () => void, milliseconds: number): number {
    const id = ++this.#next;
    this.timers.set(id, { at: this.#now + milliseconds, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.#now) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve: (value: T) => resolve?.(value) };
}

function relay(order: string[], terminals: string[] = []) {
  return {
    beginStop: (scope: AcpProcessScope) => { expect(scope).toEqual(SCOPE); order.push("close-permissions"); },
    complete: async (result: AcpTurnResult) => { terminals.push(`interrupted:${result.stopReason}`); },
    fail: async (code: "process_lost" | "upstream_failure") => { terminals.push(`failed:${code}`); },
  };
}

describe("AcpTurnCancellationCoordinator", () => {
  test("stale first Stop cannot mutate or poison the exact coordinator", async () => {
    const prompt = deferred<AcpTurnResult>();
    let writes = 0;
    const coordinator = new AcpTurnCancellationCoordinator({
      relay: relay([]),
      adapter: { stop: async () => { writes += 1; prompt.resolve({ sessionId: SCOPE.acpSessionId, stopReason: "cancelled" }); } },
      promptResult: prompt.promise,
      settlement: new AcpTurnSettlementGate(SCOPE),
      escalate: async () => undefined,
    });
    let stale: unknown;
    try {
      await coordinator.stop({ ...SCOPE, processGeneration: 99 });
    } catch (error) {
      stale = error;
    }
    expect(stale).toMatchObject({ message: "ACP Stop scope is stale" });
    expect(writes).toBe(0);
    expect(await coordinator.stop(SCOPE)).toBe("authoritative_cancelled");
    expect(writes).toBe(1);
  });

  test("orders permission closure before exact cancel and accepts only authoritative cancelled terminal", async () => {
    const order: string[] = [];
    const terminals: string[] = [];
    const prompt = deferred<AcpTurnResult>();
    const coordinator = new AcpTurnCancellationCoordinator({
      relay: relay(order, terminals),
      adapter: { stop: async () => { order.push("session/cancel"); prompt.resolve({ sessionId: "session-1", stopReason: "cancelled" }); } },
      promptResult: prompt.promise,
      settlement: new AcpTurnSettlementGate(SCOPE),
      escalate: async () => { order.push("escalate"); },
    });

    const [first, second] = await Promise.all([coordinator.stop(SCOPE), coordinator.stop(SCOPE)]);
    expect(first).toBe("authoritative_cancelled");
    expect(second).toBe("authoritative_cancelled");
    expect(order).toEqual(["close-permissions", "session/cancel"]);
    expect(terminals).toEqual(["interrupted:cancelled"]);
    let stale: unknown;
    try {
      await coordinator.stop({ ...SCOPE, turnGeneration: 4 });
    } catch (error) {
      stale = error;
    }
    expect(stale).toBeInstanceOf(TypeError);
    expect(stale).toMatchObject({ message: "ACP Stop scope is stale" });
  });

  test("escalates once after the bounded wait when a fake agent stalls", async () => {
    const clock = new Clock();
    const order: string[] = [];
    const terminals: string[] = [];
    const prompt = deferred<AcpTurnResult>();
    const groups = new Map([["binding:2", true], ["sibling:9", true]]);
    const coordinator = new AcpTurnCancellationCoordinator({
      relay: relay(order, terminals),
      adapter: { stop: async () => { order.push("session/cancel"); } },
      promptResult: prompt.promise,
      settlement: new AcpTurnSettlementGate(SCOPE),
      escalate: async (scope) => {
        expect(scope).toEqual(SCOPE);
        groups.set(`binding:${scope.processGeneration}`, false);
        order.push("TERM/KILL supervisor");
      },
      clock,
      terminalWaitMs: 100,
    });
    const stopping = coordinator.stop(SCOPE);
    await Promise.resolve();
    expect(order).toEqual(["close-permissions", "session/cancel"]);
    clock.advance(99);
    await Promise.resolve();
    expect(order).toEqual(["close-permissions", "session/cancel"]);
    clock.advance(1);
    expect(await stopping).toBe("escalated");
    expect(order).toEqual(["close-permissions", "session/cancel", "TERM/KILL supervisor"]);
    expect(terminals).toEqual(["failed:upstream_failure"]);
    expect(groups).toEqual(new Map([["binding:2", false], ["sibling:9", true]]));
    prompt.resolve({ sessionId: "session-1", stopReason: "end_turn" });
    await Promise.resolve();
    expect(terminals).toEqual(["failed:upstream_failure"]);
  });

  test("escalates sanitized non-cancel and adapter-failure outcomes", async () => {
    for (const mode of ["non_cancel", "writer_failure"] as const) {
      let escalations = 0;
      const terminals: string[] = [];
      const order: string[] = [];
      const coordinator = new AcpTurnCancellationCoordinator({
        relay: relay(order, terminals),
        adapter: { stop: mode === "writer_failure" ? async () => { throw new Error("private"); } : async () => undefined },
        promptResult: Promise.resolve({ sessionId: "session-1", stopReason: "refusal" }),
        settlement: new AcpTurnSettlementGate(SCOPE),
        escalate: async () => { escalations += 1; },
      });
      expect(await coordinator.stop(SCOPE)).toBe("escalated");
      expect(escalations).toBe(1);
      expect(terminals).toEqual([
        mode === "writer_failure" ? "failed:process_lost" : "failed:upstream_failure",
      ]);
    }
  });

  test("does not accept a cancelled result from a foreign session as Stop authority", async () => {
    let escalations = 0;
    const terminals: string[] = [];
    const order: string[] = [];
    const coordinator = new AcpTurnCancellationCoordinator({
      relay: relay(order, terminals),
      adapter: { stop: async () => undefined },
      promptResult: Promise.resolve({ sessionId: "foreign-session", stopReason: "cancelled" }),
      settlement: new AcpTurnSettlementGate(SCOPE),
      escalate: async () => { escalations += 1; },
    });
    expect(await coordinator.stop(SCOPE)).toBe("escalated");
    expect(escalations).toBe(1);
    expect(terminals).toEqual(["failed:upstream_failure"]);
  });

  test("a concurrent crash preempts pending Stop and wins one truthful process_lost terminal", async () => {
    const settlement = new AcpTurnSettlementGate(SCOPE);
    const prompt = deferred<AcpTurnResult>();
    const containment = deferred<void>();
    const terminals: string[] = [];
    const sharedRelay = {
      beginStop: () => undefined,
      complete: async (result: AcpTurnResult) => { terminals.push(`interrupted:${result.stopReason}`); },
      fail: async (code: "process_lost" | "upstream_failure") => { terminals.push(`failed:${code}`); },
    };
    const cancellation = new AcpTurnCancellationCoordinator({
      relay: sharedRelay,
      adapter: { stop: async () => undefined },
      promptResult: prompt.promise,
      settlement,
      escalate: async () => undefined,
    });
    const faults = new AcpTurnFaultOwner({
      process: SCOPE,
      settlement,
      relay: sharedRelay,
      teardown: async () => containment.promise,
    });

    const stopping = cancellation.stop(SCOPE);
    await Promise.resolve();
    const crashing = faults.processLost(SCOPE);
    prompt.resolve({ sessionId: SCOPE.acpSessionId, stopReason: "cancelled" });
    expect(await stopping).toBe("superseded");
    expect(terminals).toEqual([]);
    containment.resolve();
    expect(await crashing).toBe(true);
    expect(terminals).toEqual(["failed:process_lost"]);
  });

  test("ordinary completion cannot race past admitted Stop", async () => {
    const settlement = new AcpTurnSettlementGate(SCOPE);
    const prompt = deferred<AcpTurnResult>();
    const terminals: string[] = [];
    const sharedRelay = {
      beginStop: () => undefined,
      complete: async (result: AcpTurnResult) => { terminals.push(`terminal:${result.stopReason}`); },
      fail: async (code: "process_lost" | "upstream_failure") => { terminals.push(`failed:${code}`); },
    };
    const cancellation = new AcpTurnCancellationCoordinator({
      relay: sharedRelay,
      adapter: { stop: async () => undefined },
      promptResult: prompt.promise,
      settlement,
      escalate: async () => undefined,
    });
    const owner = new AcpTurnFaultOwner({
      process: SCOPE,
      settlement,
      relay: sharedRelay,
      teardown: async () => undefined,
    });
    const stopping = cancellation.stop(SCOPE);
    await Promise.resolve();
    let duplicateWrites = 0;
    const duplicate = new AcpTurnCancellationCoordinator({
      relay: sharedRelay,
      adapter: { stop: async () => { duplicateWrites += 1; } },
      promptResult: prompt.promise,
      settlement,
      escalate: async () => undefined,
    });
    expect(await duplicate.stop(SCOPE)).toBe("superseded");
    expect(duplicateWrites).toBe(0);
    expect(await owner.complete(SCOPE, { sessionId: SCOPE.acpSessionId, stopReason: "end_turn" })).toBe(false);
    prompt.resolve({ sessionId: SCOPE.acpSessionId, stopReason: "cancelled" });
    expect(await stopping).toBe("authoritative_cancelled");
    expect(terminals).toEqual(["terminal:cancelled"]);
  });

  test("contains exact scope when relay beginStop throws before cancel write", async () => {
    let cancelWrites = 0;
    let escalations = 0;
    const terminals: string[] = [];
    const coordinator = new AcpTurnCancellationCoordinator({
      relay: {
        beginStop: () => { throw new Error("expired receipt"); },
        complete: async () => { terminals.push("completed"); },
        fail: async (code) => { terminals.push(`failed:${code}`); },
      },
      adapter: { stop: async () => { cancelWrites += 1; } },
      promptResult: Promise.resolve({ sessionId: SCOPE.acpSessionId, stopReason: "cancelled" }),
      settlement: new AcpTurnSettlementGate(SCOPE),
      escalate: async (scope) => { expect(scope).toEqual(SCOPE); escalations += 1; },
    });
    expect(await coordinator.stop(SCOPE)).toBe("escalated");
    expect(cancelWrites).toBe(0);
    expect(escalations).toBe(1);
    expect(terminals).toEqual(["failed:upstream_failure"]);
  });

  test("contains exact scope when authoritative cancellation terminal delivery throws", async () => {
    let escalations = 0;
    const terminals: string[] = [];
    const coordinator = new AcpTurnCancellationCoordinator({
      relay: {
        beginStop: () => undefined,
        complete: async () => { throw new Error("relay backpressure"); },
        fail: async (code) => { terminals.push(`failed:${code}`); },
      },
      adapter: { stop: async () => undefined },
      promptResult: Promise.resolve({ sessionId: SCOPE.acpSessionId, stopReason: "cancelled" }),
      settlement: new AcpTurnSettlementGate(SCOPE),
      escalate: async (scope) => { expect(scope).toEqual(SCOPE); escalations += 1; },
    });
    expect(await coordinator.stop(SCOPE)).toBe("escalated");
    expect(escalations).toBe(1);
    expect(terminals).toEqual(["failed:upstream_failure"]);
  });

  test("cleanup uncertainty cannot suppress the one sanitized failure attempt", async () => {
    const terminals: string[] = [];
    const coordinator = new AcpTurnCancellationCoordinator({
      relay: {
        beginStop: () => undefined,
        complete: async () => undefined,
        fail: async (code) => { terminals.push(`failed:${code}`); },
      },
      adapter: { stop: async () => { throw new Error("writer failed"); } },
      promptResult: new Promise<AcpTurnResult>(() => undefined),
      settlement: new AcpTurnSettlementGate(SCOPE),
      escalate: async () => { throw new Error("cleanup uncertain"); },
    });
    expect(await coordinator.stop(SCOPE)).toBe("escalated");
    expect(terminals).toEqual(["failed:process_lost"]);
  });
});
