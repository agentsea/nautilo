import { describe, expect, test } from "bun:test";
import {
  actors,
  roomMembers,
  rooms,
} from "@nautilo/db";
import type {
  HarnessExecutionOutput,
  ProtectedTaskRunningOccurrence,
} from "@nautilo/runtime";
import type {
  AcpExecutionScope,
  AcpProcessScope,
  RelayAcpSemanticEvent,
  RelayAcpTerminalEvent,
} from "@nautilo/relay";
import type { TaskPayloadV1 } from "@nautilo/lattice-bridge";
import {
  createProtectedTaskHermesProvider,
} from "../../src/routes/protected-task-hermes-execution";
import {
  parseProtectedTaskHermesSelection,
} from "../../src/routes/protected-task-hermes-selection";

const OWNER = "owner";
const AGENT = "agent";
const TASK = "task";
const RUN = "run";
const JOB = "job";
const ROOM = "room";
const readiness = {
  relayId: "relay",
  relaySessionId: "socket",
  pairingGenerationRef: "pairing",
  desktopSessionId: "desktop",
  selectedProtocolVersion: 14,
  capabilityRevision: 3,
};
const selection = parseProtectedTaskHermesSelection({
  execution: {
    version: 1,
    harnessId: "hermes-acp",
    source: "genie",
    readiness,
  },
})!;
const occurrence: ProtectedTaskRunningOccurrence = {
  task: {
    id: TASK,
    ownerId: OWNER,
    requestorId: OWNER,
    agentId: AGENT,
    callingRoomId: ROOM,
    scheduleKind: "now",
    contentRepresentation: "protected",
    contentNamespaceId: "namespace",
    contentRevision: 1,
    cryptoObjectId: "definition-object",
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32),
  },
  run: {
    id: RUN,
    taskId: TASK,
    jobId: JOB,
    graphThreadId: `subagent:task:${TASK}:${RUN}`,
    status: "running",
    startedAt: new Date("2026-10-13T00:00:00.000Z"),
  },
};
const reference = {
  kind: "protected_task_run_v1" as const,
  taskId: TASK,
  taskRunId: RUN,
  inputObjectId: "definition-object",
  resultObjectId: "result-object",
  authorizationRequestId: `task-run-authorization:${RUN}`,
  policyRevision: 17,
  executionSegment: 1,
};
const payload: TaskPayloadV1 = {
  formatVersion: 1,
  prompt: "private prompt",
  expectedOutput: null,
  protectedMetadata: {},
};
const process: AcpProcessScope = {
  connectionId: "connection",
  processGeneration: 1,
  acpSessionId: "acp-session",
  turnGeneration: 2,
  turnRef: "turn",
};
type ProviderInput = Parameters<typeof createProtectedTaskHermesProvider>[0];
type Relay = ProviderInput["relay"];
type Event = RelayAcpSemanticEvent | RelayAcpTerminalEvent;
type WaitStage = "readiness" | "prepare" | "start" | "next";
const exactSession = Object.freeze({ ...readiness, userId: OWNER });

function deferred<Value = void>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

async function observed(calls: readonly string[], value: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !calls.includes(value); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  expect(calls).toContain(value);
}

class IdentityDatabase {
  readonly projections: string[][] = [];
  roomPresent = true;
  ownerId = OWNER;
  memberPresent = true;

  select(fields: Record<string, unknown>) {
    this.projections.push(Object.keys(fields).sort());
    return {
      from: (table: unknown) => {
        const rows = () => {
          if (table === rooms) return this.roomPresent ? [{ id: ROOM }] : [];
          if (table === actors) return [{ ownerId: this.ownerId }];
          if (table === roomMembers) return this.memberPresent ? [{ actorId: "agent-actor" }] : [];
          throw new Error("unexpected protected Hermes identity table");
        };
        const where = (_condition: unknown) => ({ limit: async (_limit: number) => rows() });
        return {
          where,
          innerJoin: (_joined: unknown, _condition: unknown) => ({ where }),
        };
      },
    };
  }
}

function semantic(scope: AcpExecutionScope): RelayAcpSemanticEvent {
  return {
    type: "relay:acp-semantic",
    registrationId: "hermes-acp",
    scope,
    process,
    capabilities: { requests: "unsupported" },
    payload: { kind: "assistant_completed", vendorItemId: "answer", text: "private answer" },
    eventId: "semantic",
    eventSequence: 2,
  };
}

function terminal(scope: AcpExecutionScope): RelayAcpTerminalEvent {
  return {
    type: "relay:acp-terminal",
    registrationId: "hermes-acp",
    scope,
    process,
    status: "completed",
    eventId: "terminal",
    eventSequence: 3,
  };
}

function fixture(options: Partial<{
  waitAt: WaitStage;
  nextNever: boolean;
  containResult: boolean;
  events: (scope: AcpExecutionScope) => readonly Event[];
  sessions: readonly NonNullable<ReturnType<Relay["getAcpSession"]>>[];
  closeThrows: boolean;
  startRequests: "unsupported" | "supported";
}> = {}) {
  const db = new IdentityDatabase();
  const calls: string[] = [];
  const gate = deferred();
  let current = true;
  let cursor = 0;
  let activeScope: AcpExecutionScope | null = null;
  let processFrozenAtSubscription = false;
  const pause = async (stage: WaitStage) => {
    if (options.waitAt === stage) {
      calls.push(`pending:${stage}`);
      await gate.promise;
    }
  };
  const sessions = options.sessions ?? [exactSession];
  const relay: Relay = {
    listConnected: async () => {
      calls.push("list-connected");
      return sessions.map((session) => session.relayId);
    },
    getAcpSession: (relayId, userId) => {
      calls.push("session");
      return sessions.find((session) => session.relayId === relayId
        && (userId === undefined || session.userId === userId)) ?? null;
    },
    requestAcpReadiness: async () => {
      calls.push("readiness");
      await pause("readiness");
      return "ready";
    },
    requestAcpPrepare: async () => {
      calls.push("prepare");
      await pause("prepare");
      return {
        workspaceReceiptId: "workspace",
        workspaceRevision: "1",
        workspaceFingerprint: "workspace-fingerprint",
        workspaceExpiresAt: "2099-01-01T00:00:00.000Z",
      };
    },
    requestAcpStart: async ({ scope }) => {
      calls.push("start");
      activeScope = scope;
      await pause("start");
      return {
        type: "relay:acp-started",
        registrationId: "hermes-acp",
        scope,
        process,
        capabilities: { requests: options.startRequests ?? "unsupported" },
        eventId: "started",
        eventSequence: 1,
      };
    },
    subscribeAcpExecution: (scope, receivedProcess) => {
      calls.push("subscribe");
      processFrozenAtSubscription = Object.isFrozen(receivedProcess);
      const events = options.events?.(scope) ?? [semantic(scope), terminal(scope)];
      return {
        next: async () => {
          calls.push("next");
          if (options.nextNever === true) return await new Promise<Event | null>(() => undefined);
          await pause("next");
          return events[cursor++] ?? null;
        },
        acknowledge: () => { calls.push("ack"); },
        close: () => {
          calls.push("close");
          if (options.closeThrows === true) throw new Error("private close failure");
        },
      };
    },
    containAcpExecution: () => {
      calls.push("contain");
      return options.containResult ?? true;
    },
  };
  let minted = 0;
  const provider = createProtectedTaskHermesProvider({
    db: db as unknown as ProviderInput["db"],
    relay,
    mintId: () => `opaque-${++minted}`,
  });
  const controller = new AbortController();
  const assertCurrent = async () => {
    calls.push("current");
    if (!current) throw new Error("stale protected authority");
  };
  const start = async (currentPayload: TaskPayloadV1 = payload) => {
    const admission = await provider.admit(OWNER, selection);
    if (admission === null) throw new Error("missing exact Hermes admission");
    return provider.start({
      occurrence,
      reference,
      jobId: JOB,
      signal: controller.signal,
      assertCurrent,
      admission,
      payload: currentPayload,
    });
  };
  return {
    provider,
    db,
    calls,
    gate,
    controller,
    start,
    scope: () => activeScope,
    processFrozenAtSubscription: () => processFrozenAtSubscription,
    setCurrent: (value: boolean) => { current = value; },
  };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    return error;
  }
}

describe("protected Hermes provider", () => {
  test("admits the sealed machine after reconnect without selecting another owner device", async () => {
    const refreshed = { ...exactSession, relaySessionId: "new-socket", desktopSessionId: "new-desktop", capabilityRevision: 4 };
    const f = fixture({ sessions: [refreshed, { ...exactSession, relayId: "second-relay" }] });
    expect(await f.provider.admit(OWNER, selection)).toEqual(refreshed);
    expect(await f.provider.admit("other-owner", selection)).toBeNull();
    expect(await fixture({ sessions: [] }).provider.admit(OWNER, selection)).toBeNull();
    expect(await fixture({ sessions: [{ ...exactSession, relayId: "second-relay" }] }).provider.admit(OWNER, selection)).toBeNull();
    const session = await f.start();
    const outputs = [];
    for await (const output of session.outputs) outputs.push(output);
    expect(outputs.map(output => output.kind)).toEqual(["assistant_completed", "terminal"]);
    expect(f.calls.filter(call => call === "start")).toHaveLength(1);
  });

  test("re-pairing and incompatible refreshed sockets remain unavailable", async () => {
    for (const change of [{ pairingGenerationRef: "new-pairing" }, { selectedProtocolVersion: 13 },
      { capabilityRevision: -1 }, { relaySessionId: "" }, { userId: "other-owner" }]) {
      expect(await fixture({ sessions: [{ ...exactSession, ...change }] }).provider.admit(OWNER, selection)).toBeNull();
    }
  });

  test("checks only closed Room, owner, and membership identities before the first provider effect", async () => {
    for (const mutate of [
      (db: IdentityDatabase) => { db.roomPresent = false; },
      (db: IdentityDatabase) => { db.ownerId = "other-owner"; },
      (db: IdentityDatabase) => { db.memberPresent = false; },
    ]) {
      const f = fixture();
      mutate(f.db);
      expect(await rejected(f.start())).toBeInstanceOf(TypeError);
      expect(f.calls).not.toContain("readiness");
      expect(f.calls).not.toContain("prepare");
      expect(f.calls).not.toContain("start");
      expect(f.db.projections).toEqual([["id"], ["ownerId"], ["actorId"]]);
    }
  });

  test("rejects protected metadata before identity reads or provider disclosure", async () => {
    const f = fixture();
    expect(await rejected(f.start({
      ...payload,
      protectedMetadata: { privateProviderInput: "must not cross" },
    }))).toMatchObject({ message: "Protected Hermes definition is unsupported" });
    expect(f.db.projections).toEqual([]);
    expect(f.calls).toEqual(["list-connected", "session"]);
  });

  test("returns normalized candidate and completed terminal outputs without a request channel", async () => {
    const f = fixture();
    const session = await f.start();
    const outputs: HarnessExecutionOutput[] = [];
    for await (const output of session.outputs) outputs.push(output);

    expect(outputs).toHaveLength(2);
    const candidate = outputs[0];
    expect(candidate?.kind).toBe("assistant_completed");
    if (candidate?.kind !== "assistant_completed") throw new Error("missing Hermes candidate");
    expect(candidate.text).toBe("private answer");
    expect(candidate.attribution).toEqual({
      taskId: TASK,
      roomId: ROOM,
      bindingId: "opaque-2",
      bindingGeneration: "opaque-3",
      vendorSessionId: "acp-session",
      vendorTurnId: "turn",
      vendorItemId: null,
    });
    expect(outputs[1]).toEqual({
      kind: "terminal",
      status: "completed",
      attribution: {
        taskId: TASK,
        roomId: ROOM,
        bindingId: "opaque-2",
        bindingGeneration: "opaque-3",
        vendorSessionId: "acp-session",
        vendorTurnId: "turn",
        vendorItemId: null,
      },
    });
    expect(session.hasLiveRequest("request", OWNER)).toBeFalse();
    expect(await rejected(session.respond({} as never, {} as never))).toMatchObject({
      message: "Protected Hermes requests are unsupported",
    });
    expect(f.calls.filter((call) => call === "ack")).toHaveLength(2);
    expect(f.calls).not.toContain("contain");
    expect(f.calls.at(-1)).toBe("close");
  });

  test("copies and freezes both host-returned workspace and process identity snapshots", async () => {
    const f = fixture();
    await f.start();
    expect(Object.isFrozen(f.scope())).toBeTrue();
    expect(Object.isFrozen(f.scope()?.socket)).toBeTrue();
    expect(Object.isFrozen(f.scope()?.binding)).toBeTrue();
    expect(Object.isFrozen(f.scope()?.workspace)).toBeTrue();
    expect(f.processFrozenAtSubscription()).toBeTrue();
  });

  test("revalidates after readiness and workspace preparation before another provider effect", async () => {
    for (const [stage, forbidden] of [
      ["readiness", "prepare"],
      ["prepare", "start"],
    ] as const) {
      const f = fixture({ waitAt: stage });
      const pending = f.start();
      await observed(f.calls, `pending:${stage}`);
      f.setCurrent(false);
      f.gate.resolve();
      expect(await rejected(pending)).toMatchObject({ message: "stale protected authority" });
      expect(f.calls).not.toContain(forbidden);
      expect(f.calls).not.toContain("subscribe");
    }
  });

  test("revalidates after process start before subscribing to its output stream", async () => {
    const f = fixture({ waitAt: "start" });
    const pending = f.start();
    await observed(f.calls, "pending:start");
    f.setCurrent(false);
    f.gate.resolve();
    expect(await rejected(pending)).toMatchObject({ message: "stale protected authority" });
    expect(f.calls).not.toContain("subscribe");
    expect(f.calls.filter((call) => call === "contain")).toHaveLength(1);
  });

  test("contains one exact late-known process when grant authority ends during start", async () => {
    const f = fixture({ waitAt: "start" });
    const pending = f.start();
    await observed(f.calls, "pending:start");
    f.controller.abort(new DOMException("grant expired", "AbortError"));
    expect(await rejected(pending)).toMatchObject({ name: "AbortError" });

    f.gate.resolve();
    await observed(f.calls, "contain");
    expect(f.calls.filter((call) => call === "contain")).toHaveLength(1);
    expect(f.calls).not.toContain("subscribe");
  });

  test("rejects a started process that advertises a Human request channel", async () => {
    const f = fixture({ startRequests: "supported" });
    expect(await rejected(f.start())).toMatchObject({
      message: "Protected Hermes provider receipt changed",
    });
    expect(f.calls).not.toContain("subscribe");
    expect(f.calls.filter((call) => call === "contain")).toHaveLength(1);
  });

  test("releases a stalled stream without treating best-effort containment as a receipt", async () => {
    const f = fixture({ nextNever: true, containResult: false });
    const session = await f.start();
    const pending = session.outputs[Symbol.asyncIterator]().next();
    await observed(f.calls, "next");
    f.controller.abort(new DOMException("grant expired", "AbortError"));

    expect(await rejected(pending)).toMatchObject({ name: "AbortError" });
    expect(f.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "contain")).toHaveLength(1);
    expect(f.calls).not.toContain("ack");
  });

  test("a private subscription close failure cannot mask or skip exact containment", async () => {
    const f = fixture({ closeThrows: true });
    const session = await f.start();
    const iterator = session.outputs[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { kind: "assistant_completed", text: "private answer" },
    });

    expect(await iterator.return?.()).toMatchObject({ done: true });
    expect(f.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "contain")).toHaveLength(1);
  });

  test("rejects stale authority after stream receipt without yielding, acknowledging, or replaying", async () => {
    const f = fixture({ waitAt: "next" });
    const session = await f.start();
    const pending = session.outputs[Symbol.asyncIterator]().next();
    await observed(f.calls, "pending:next");
    f.setCurrent(false);
    f.gate.resolve();

    expect(await rejected(pending)).toMatchObject({ message: "stale protected authority" });
    expect(f.calls).not.toContain("ack");
    expect(f.calls.filter((call) => call === "contain")).toHaveLength(1);
    expect(f.db.projections.length % 3).toBe(0);
    for (let offset = 0; offset < f.db.projections.length; offset += 3) {
      expect(f.db.projections.slice(offset, offset + 3)).toEqual([
        ["id"],
        ["ownerId"],
        ["actorId"],
      ]);
    }
  });
});


test("Hermes rejects OpenCode-only runtime status and cross-registration output", async () => {
  for (const altered of ["status", "registration"] as const) {
    const f = fixture({ events: scope => {
      const original = semantic(scope);
      return [altered === "status" ? { ...original, payload: { kind: "runtime_status", state: "healthy" } }
        : { ...original, registrationId: "opencode-acp" }];
    } });
    const session = await f.start();
    expect(await rejected(session.outputs[Symbol.asyncIterator]().next())).toBeInstanceOf(TypeError);
    expect(f.calls).not.toContain("ack");
    expect(f.calls.filter(call => call === "contain")).toHaveLength(1);
  }
});
