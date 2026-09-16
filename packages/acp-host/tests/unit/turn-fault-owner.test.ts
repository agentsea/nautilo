import { describe, expect, test } from "bun:test";
import {
  AcpAdapterError,
  AcpTurnFaultOwner,
  AcpTurnSettlementGate,
  type AcpFaultTerminalCode,
  type AcpProcessScope,
} from "../../src/index.js";

const CURRENT: AcpProcessScope = {
  connectionId: "connection-current",
  processGeneration: 7,
  acpSessionId: "session-current",
  turnGeneration: 4,
  turnRef: "turn-current",
};

const CASES: readonly Readonly<{
  name: string;
  invoke(owner: AcpTurnFaultOwner, scope: AcpProcessScope): Promise<boolean>;
  code: AcpFaultTerminalCode;
}>[] = [
  {
    name: "oversized inbound",
    invoke: (owner, scope) => owner.observe(scope, Promise.reject(new AcpAdapterError("line_too_large", "private oversized bytes"))),
    code: "process_lost",
  },
  {
    name: "malformed inbound",
    invoke: (owner, scope) => owner.observe(scope, Promise.reject(new AcpAdapterError("invalid_response", "private malformed bytes"))),
    code: "upstream_failure",
  },
  {
    name: "out-of-order session update",
    invoke: (owner, scope) => owner.observe(scope, Promise.reject(new AcpAdapterError("invalid_response", "private foreign session"))),
    code: "upstream_failure",
  },
  {
    name: "slow semantic consumer overflow",
    invoke: (owner, scope) => owner.observe(scope, Promise.reject(new AcpAdapterError("update_overflow", "private queue state"))),
    code: "process_lost",
  },
  {
    name: "child crash",
    invoke: (owner, scope) => owner.processLost(scope),
    code: "process_lost",
  },
];

describe("AcpTurnFaultOwner", () => {
  for (const fault of CASES) {
    test(`${fault.name} tears down only the exact generation and emits one terminal`, async () => {
      const groups = new Map([["binding:7", true], ["sibling:11", true]]);
      const terminals: string[] = [];
      const owner = new AcpTurnFaultOwner({
        process: CURRENT,
        settlement: new AcpTurnSettlementGate(CURRENT),
        relay: {
          complete: async () => { terminals.push("completed"); },
          fail: async (code) => { terminals.push(`failed:${code}`); },
        },
        teardown: async (scope) => {
          expect(scope).toEqual(CURRENT);
          groups.set(`binding:${scope.processGeneration}`, false);
        },
      });

      const [first, duplicate] = await Promise.all([
        fault.invoke(owner, CURRENT),
        fault.invoke(owner, CURRENT),
      ]);
      expect(first).toBe(true);
      expect(duplicate).toBe(true);
      expect(groups).toEqual(new Map([["binding:7", false], ["sibling:11", true]]));
      expect(terminals).toEqual([`failed:${fault.code}`]);
      expect(await owner.complete(CURRENT, { sessionId: "session-current", stopReason: "end_turn" })).toBe(false);
      expect(terminals).toEqual([`failed:${fault.code}`]);
    });
  }

  test("late prior-generation crash and completion cannot disturb or terminalize the successor", async () => {
    let teardowns = 0;
    const terminals: string[] = [];
    const owner = new AcpTurnFaultOwner({
      process: CURRENT,
      settlement: new AcpTurnSettlementGate(CURRENT),
      relay: {
        complete: async () => { terminals.push("completed"); },
        fail: async (code) => { terminals.push(`failed:${code}`); },
      },
      teardown: async () => { teardowns += 1; },
    });
    const stale = { ...CURRENT, connectionId: "connection-old", processGeneration: 6, turnGeneration: 3 };
    expect(await owner.processLost(stale)).toBe(false);
    expect(await owner.complete(stale, { sessionId: stale.acpSessionId, stopReason: "end_turn" })).toBe(false);
    expect(teardowns).toBe(0);
    expect(terminals).toEqual([]);
    expect(await owner.complete(CURRENT, { sessionId: CURRENT.acpSessionId, stopReason: "end_turn" })).toBe(true);
    expect(terminals).toEqual(["completed"]);
  });

  test("normal completion relay failure triggers exact teardown and keeps late paths fenced", async () => {
    let teardowns = 0;
    const terminals: string[] = [];
    const owner = new AcpTurnFaultOwner({
      process: CURRENT,
      settlement: new AcpTurnSettlementGate(CURRENT),
      relay: {
        complete: async () => { throw new Error("relay unavailable"); },
        fail: async (code) => { terminals.push(`failed:${code}`); },
      },
      teardown: async (scope) => { expect(scope).toEqual(CURRENT); teardowns += 1; },
    });
    expect(await owner.complete(CURRENT, { sessionId: CURRENT.acpSessionId, stopReason: "end_turn" })).toBe(true);
    expect(teardowns).toBe(1);
    expect(terminals).toEqual(["failed:upstream_failure"]);
    expect(await owner.processLost(CURRENT)).toBe(false);
    expect(await owner.complete(CURRENT, { sessionId: CURRENT.acpSessionId, stopReason: "end_turn" })).toBe(false);
    expect(teardowns).toBe(1);
    expect(terminals).toEqual(["failed:upstream_failure"]);
  });
});
