import { describe, expect, test } from "bun:test";
import { ACP_RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import {
  HERMES_ACP_HARNESS_TASK_EXECUTION_DESCRIPTOR,
  createHermesAcpHarnessTask,
  type HermesAcpHarnessTaskDeps,
} from "../../src/acp/harness-task";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";

const request = {
  ownerId: OWNER,
  requestorId: OWNER,
  agentId: AGENT,
  prompt: "Repair this",
  preset: "task" as const,
  scheduleKind: "now" as const,
  targetChat: "orphan" as const,
  callingRoomId: ROOM,
  targetUserIds: [OWNER],
  useScope: false,
  toolsMode: "auto" as const,
  awaitResponse: false,
  resultDelivery: "raw_and_wake" as const,
  harness: "hermes-acp" as const,
};
function session(relayId = "relay-1", overrides: Partial<{
  userId: string;
  relaySessionId: string;
  pairingGenerationRef: string;
  desktopSessionId: string;
  selectedProtocolVersion: number;
  capabilityRevision: number;
}> = {}) {
  return {
    relayId,
    userId: OWNER,
    relaySessionId: "session-1",
    pairingGenerationRef: "pairing-1",
    desktopSessionId: "desktop-1",
    selectedProtocolVersion: ACP_RELAY_PROTOCOL_VERSION,
    capabilityRevision: 4,
    ...overrides,
  };
}

function harness(overrides: Partial<HermesAcpHarnessTaskDeps> = {}) {
  let created: Parameters<HermesAcpHarnessTaskDeps["createTask"]>[0] | undefined;
  const sessions = new Map([["relay-1", session()]]);
  let listConnectedCalls = 0;
  let getSessionCalls = 0;
  const readinessCalls: unknown[] = [];
  const deps: HermesAcpHarnessTaskDeps = {
    facts: {
      getAgentOwner: async () => OWNER,
      roomExists: async () => true,
      isAgentMember: async () => true,
    },
    relay: {
      listConnected: async () => {
        listConnectedCalls++;
        return [...sessions.keys()];
      },
      getAcpSession: (relayId, userId) => {
        getSessionCalls++;
        const candidate = sessions.get(relayId) ?? null;
        return candidate?.userId === userId ? candidate : null;
      },
      requestAcpReadiness: async (input) => {
        readinessCalls.push(input);
        return "ready";
      },
    },
    createTask: async (input) => {
      created = input;
      return { taskId: "55555555-5555-4555-8555-555555555555", status: "pending" };
    },
    mintRequestId: () => "request-1",
    ...overrides,
  };
  return {
    deps,
    sessions,
    created: () => created,
    listConnectedCalls: () => listConnectedCalls,
    getSessionCalls: () => getSessionCalls,
    readinessCalls: () => readinessCalls,
  };
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected admission failure");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("createHermesAcpHarnessTask", () => {
  test("admits exactly one authenticated v14 ready relay and seals only safe metadata", async () => {
    const h = harness();
    expect(await createHermesAcpHarnessTask(h.deps, request)).toEqual({
      taskId: "55555555-5555-4555-8555-555555555555",
      status: "pending",
      execution: "hermes-acp",
    });
    expect(h.readinessCalls()).toEqual([{
      relayId: "relay-1",
      userId: OWNER,
      requestId: "request-1",
      registrationId: "hermes-acp",
      timeoutMs: 10_000,
    }]);
    expect(h.created()).toEqual({
      ownerId: OWNER,
      requestorId: OWNER,
      agentId: AGENT,
      prompt: "Repair this",
      scheduleKind: "now",
      targetChat: "last_in_namespace",
      targetRoomId: ROOM,
      callingRoomId: ROOM,
      targetUserIds: [OWNER],
      toolsMode: "none",
      toolsWhitelist: [],
      resultDelivery: "raw_and_wake",
      requestedModelId: null,
      metadata: {
        execution: {
          ...HERMES_ACP_HARNESS_TASK_EXECUTION_DESCRIPTOR,
          readiness: {
            relayId: "relay-1",
            relaySessionId: "session-1",
            pairingGenerationRef: "pairing-1",
            desktopSessionId: "desktop-1",
            selectedProtocolVersion: ACP_RELAY_PROTOCOL_VERSION,
            capabilityRevision: 4,
          },
        },
      },
    });
    const execution = (h.created()!.metadata as { execution: Record<string, unknown> }).execution;
    expect(Object.keys(execution).sort()).toEqual(["harnessId", "readiness", "source", "version"]);
    expect(Object.keys(execution["readiness"] as Record<string, unknown>).sort()).toEqual([
      "capabilityRevision",
      "desktopSessionId",
      "pairingGenerationRef",
      "relayId",
      "relaySessionId",
      "selectedProtocolVersion",
    ]);
  });

  test("positive allowlist omits every malicious caller extra before sealing", async () => {
    const h = harness();
    await createHermesAcpHarnessTask(h.deps, {
      ...request,
      id: "forged-task-id",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      fireLockId: "forged-lock",
      fireLockedAt: new Date("2026-01-01"),
      catchup: "run_once",
      expectedOutput: "caller-controlled",
      scheduleKind: "cron",
      runAt: new Date("2030-01-01"),
      cron: "* * * * *",
      timezone: "UTC",
      targetChat: "new_dm",
      targetRoomId: "forged-room",
      targetUserIds: ["forged-user"],
      resultDelivery: "raw_and_wake",
      toolsMode: "whitelist",
      toolsWhitelist: ["shell"],
      useScope: true,
      scopeId: "forged-scope",
      requestedModelId: "forged-model",
      selectionProfile: "smartest",
      selectionSpec: { objective: "smart" },
      metadata: { raw: "caller-controlled" },
      workingDirectory: "/private/path",
      collaborationMode: "work",
      harnessModelId: "provider-model",
      provider: "provider",
      workspaceReceipt: "receipt",
      rawAcp: { untrusted: true },
    } as unknown as typeof request);
    expect(h.created()).toEqual({
      ownerId: OWNER,
      requestorId: OWNER,
      agentId: AGENT,
      prompt: "Repair this",
      scheduleKind: "now",
      targetChat: "last_in_namespace",
      targetRoomId: ROOM,
      callingRoomId: ROOM,
      targetUserIds: [OWNER],
      toolsMode: "none",
      toolsWhitelist: [],
      resultDelivery: "raw_and_wake",
      requestedModelId: null,
      metadata: {
        execution: {
          ...HERMES_ACP_HARNESS_TASK_EXECUTION_DESCRIPTOR,
          readiness: {
            relayId: "relay-1",
            relaySessionId: "session-1",
            pairingGenerationRef: "pairing-1",
            desktopSessionId: "desktop-1",
            selectedProtocolVersion: ACP_RELAY_PROTOCOL_VERSION,
            capabilityRevision: 4,
          },
        },
      },
    });
    expect(Object.keys(h.created()!).sort()).toEqual([
      "agentId",
      "callingRoomId",
      "metadata",
      "ownerId",
      "prompt",
      "requestedModelId",
      "requestorId",
      "resultDelivery",
      "scheduleKind",
      "targetChat",
      "targetRoomId",
      "targetUserIds",
      "toolsMode",
      "toolsWhitelist",
    ]);
  });

  test("preserves dispatcher-authored nested lineage while retaining sealed Hermes routing", async () => {
    const h = harness();
    await createHermesAcpHarnessTask(h.deps, {
      ...request,
      parentTaskId: "44444444-4444-4444-8444-444444444444",
      depth: 3,
    });

    expect(h.created()).toMatchObject({
      ownerId: OWNER,
      requestorId: OWNER,
      agentId: AGENT,
      parentTaskId: "44444444-4444-4444-8444-444444444444",
      depth: 3,
      scheduleKind: "now",
      targetChat: "last_in_namespace",
      targetRoomId: ROOM,
      callingRoomId: ROOM,
      toolsMode: "none",
      toolsWhitelist: [],
      resultDelivery: "raw_and_wake",
      requestedModelId: null,
    });
  });

  test.each([
    [{ parentTaskId: "parent" }],
    [{ depth: 2 }],
    [{ parentTaskId: "parent", depth: -1 }],
    [{ parentTaskId: "parent", depth: 1.5 }],
  ])("rejects incomplete or malformed lineage before relay probing or Task write", async (lineage) => {
    const h = harness();
    await expectFailure(createHermesAcpHarnessTask(h.deps, {
      ...request,
      ...lineage,
    } as never), "ACP_HARNESS_UNAVAILABLE");
    expect(h.listConnectedCalls()).toBe(0);
    expect(h.readinessCalls()).toEqual([]);
    expect(h.created()).toBeUndefined();
  });

  test.each([
    ["no connected ACP relay", (h: ReturnType<typeof harness>) => h.sessions.clear(), "ACP_HARNESS_UNAVAILABLE"],
    ["ambiguous relay", (h: ReturnType<typeof harness>) => h.sessions.set("relay-2", session("relay-2")), "ACP_HARNESS_UNAVAILABLE"],
    ["pre-v14 relay", (h: ReturnType<typeof harness>) => h.sessions.set("relay-1", session("relay-1", { selectedProtocolVersion: ACP_RELAY_PROTOCOL_VERSION - 1 })), "ACP_HARNESS_UNAVAILABLE"],
    ["foreign relay snapshot", (h: ReturnType<typeof harness>) => h.sessions.set("relay-1", session("relay-1", { userId: "foreign" })), "ACP_HARNESS_UNAVAILABLE"],
    ["missing current Room", (h: ReturnType<typeof harness>) => { (h.deps as { facts: HermesAcpHarnessTaskDeps["facts"] }).facts = { ...h.deps.facts, roomExists: async () => false }; }, "ACP_ROOM_UNAVAILABLE"],
    ["foreign Agent", (h: ReturnType<typeof harness>) => { (h.deps as { facts: HermesAcpHarnessTaskDeps["facts"] }).facts = { ...h.deps.facts, getAgentOwner: async () => "foreign" }; }, "ACP_SOURCE_FORBIDDEN"],
    ["non-member Agent", (h: ReturnType<typeof harness>) => { (h.deps as { facts: HermesAcpHarnessTaskDeps["facts"] }).facts = { ...h.deps.facts, isAgentMember: async () => false }; }, "ACP_SOURCE_FORBIDDEN"],
  ] as const)("fails closed with zero Task write for %s", async (_name, mutate, code) => {
    const h = harness();
    mutate(h);
    await expectFailure(createHermesAcpHarnessTask(h.deps, request), code);
    expect(h.created()).toBeUndefined();
  });

  test("requires a calling current Room before probing or writing", async () => {
    const h = harness();
    await expectFailure(createHermesAcpHarnessTask(h.deps, { ...request, callingRoomId: null }), "ACP_ROOM_UNAVAILABLE");
    expect(h.readinessCalls()).toEqual([]);
    expect(h.created()).toBeUndefined();
  });

  test("rejects a substituted requestor before any relay probe or Task write", async () => {
    const h = harness();
    await expectFailure(createHermesAcpHarnessTask(h.deps, {
      ...request,
      requestorId: "44444444-4444-4444-8444-444444444444",
    }), "ACP_SOURCE_FORBIDDEN");
    expect(h.listConnectedCalls()).toBe(0);
    expect(h.getSessionCalls()).toBe(0);
    expect(h.readinessCalls()).toEqual([]);
    expect(h.created()).toBeUndefined();
  });

  test.each(["native", "unknown-harness"])("rejects malformed %s harness before any relay probe or Task write", async (harnessId) => {
    const h = harness();
    await expectFailure(createHermesAcpHarnessTask(h.deps, {
      ...request,
      harness: harnessId,
    } as unknown as typeof request), "ACP_HARNESS_UNAVAILABLE");
    expect(h.listConnectedCalls()).toBe(0);
    expect(h.getSessionCalls()).toBe(0);
    expect(h.readinessCalls()).toEqual([]);
    expect(h.created()).toBeUndefined();
  });

  test.each(["missing", "incompatible", "authentication_required", "unavailable"] as const)("does not write a Task when readiness is %s", async (state) => {
    const h = harness({
      relay: {
        listConnected: async () => ["relay-1"],
        getAcpSession: (relayId, userId) => relayId === "relay-1" && userId === OWNER ? session() : null,
        requestAcpReadiness: async () => state,
      },
    });
    await expectFailure(createHermesAcpHarnessTask(h.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(h.created()).toBeUndefined();
  });

  test("normalizes relay errors and rejects a stale socket after readiness without writing", async () => {
    const unavailable = harness({
      relay: {
        listConnected: async () => ["relay-1"],
        getAcpSession: (relayId, userId) => relayId === "relay-1" && userId === OWNER ? session() : null,
        requestAcpReadiness: async () => { throw new Error("host /secret/path"); },
      },
    });
    await expectFailure(createHermesAcpHarnessTask(unavailable.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(unavailable.created()).toBeUndefined();

    let reads = 0;
    const stale = harness({
      relay: {
        listConnected: async () => ["relay-1"],
        getAcpSession: (relayId, userId) => {
          if (relayId !== "relay-1" || userId !== OWNER) return null;
          return reads++ === 0 ? session() : session("relay-1", { capabilityRevision: 5 });
        },
        requestAcpReadiness: async () => "ready",
      },
    });
    await expectFailure(createHermesAcpHarnessTask(stale.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(stale.created()).toBeUndefined();

    const enumerationFailure = harness({
      relay: {
        listConnected: async () => { throw new Error("internal relay detail"); },
        getAcpSession: () => null,
        requestAcpReadiness: async () => "ready",
      },
    });
    await expectFailure(createHermesAcpHarnessTask(enumerationFailure.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(enumerationFailure.created()).toBeUndefined();
  });

  test("uses immutable pre-readiness facts for authority and the Task write", async () => {
    const mutable = { ...request };
    const h = harness({
      relay: {
        listConnected: async () => ["relay-1"],
        getAcpSession: (relayId, userId) => relayId === "relay-1" && userId === OWNER ? session() : null,
        requestAcpReadiness: async () => {
          mutable.ownerId = "attacker-owner";
          mutable.requestorId = "attacker-requestor";
          mutable.agentId = "attacker-agent";
          mutable.prompt = "attacker prompt";
          mutable.callingRoomId = "attacker-room";
          (mutable as { harness: string }).harness = "codex";
          return "ready";
        },
      },
    });
    await createHermesAcpHarnessTask(h.deps, mutable);
    expect(h.created()).toMatchObject({
      ownerId: OWNER,
      requestorId: OWNER,
      agentId: AGENT,
      prompt: "Repair this",
      callingRoomId: ROOM,
      targetRoomId: ROOM,
      targetUserIds: [OWNER],
    });
  });

  test("requires the session relay id to equal the enumerated relay id", async () => {
    const h = harness();
    h.sessions.set("relay-1", session("different-relay"));
    await expectFailure(createHermesAcpHarnessTask(h.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(h.readinessCalls()).toEqual([]);
    expect(h.created()).toBeUndefined();
  });

  test("rejects a changed relay id after readiness without writing", async () => {
    let reads = 0;
    const h = harness({
      relay: {
        listConnected: async () => ["relay-1"],
        getAcpSession: (relayId, userId) => {
          if (relayId !== "relay-1" || userId !== OWNER) return null;
          return reads++ === 0 ? session("relay-1") : session("relay-2");
        },
        requestAcpReadiness: async () => "ready",
      },
    });
    await expectFailure(createHermesAcpHarnessTask(h.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(h.created()).toBeUndefined();
  });

  test.each([
    ["a relay-session successor", { relaySessionId: "session-2" }],
    ["a desktop successor reusing the relay-session id", { desktopSessionId: "desktop-2" }],
  ] as const)("rejects %s after readiness without writing", async (_name, successor) => {
    let reads = 0;
    const h = harness({
      relay: {
        listConnected: async () => ["relay-1"],
        getAcpSession: (relayId, userId) => {
          if (relayId !== "relay-1" || userId !== OWNER) return null;
          return reads++ === 0 ? session() : session("relay-1", successor);
        },
        requestAcpReadiness: async () => "ready",
      },
    });
    await expectFailure(createHermesAcpHarnessTask(h.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(h.created()).toBeUndefined();
  });

  test("rejects an oversized session identity before readiness and writing", async () => {
    const h = harness();
    h.sessions.set("relay-1", session("relay-1", { relaySessionId: "x".repeat(513) }));
    await expectFailure(createHermesAcpHarnessTask(h.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(h.readinessCalls()).toEqual([]);
    expect(h.created()).toBeUndefined();
  });
});
