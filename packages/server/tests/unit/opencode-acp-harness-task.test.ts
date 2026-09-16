import { describe, expect, test } from "bun:test";
import { OPENCODE_ACP_RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import {
  OPENCODE_ACP_HARNESS_TASK_EXECUTION_DESCRIPTOR,
  createOpenCodeAcpHarnessTask,
  type CreateOpenCodeAcpHarnessTaskInput,
  type OpenCodeAcpHarnessTaskDeps,
} from "../../src/acp/opencode-harness-task";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";

const request: CreateOpenCodeAcpHarnessTaskInput = {
  ownerId: OWNER,
  requestorId: OWNER,
  agentId: AGENT,
  prompt: "Inspect the repository",
  callingRoomId: ROOM,
  harness: "opencode-acp",
  executionProfile: "interactive",
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
    selectedProtocolVersion: OPENCODE_ACP_RELAY_PROTOCOL_VERSION,
    capabilityRevision: 5,
    ...overrides,
  };
}

function harness(overrides: Partial<OpenCodeAcpHarnessTaskDeps> = {}) {
  let created: Parameters<OpenCodeAcpHarnessTaskDeps["createTask"]>[0] | undefined;
  const sessions = new Map([["relay-1", session()]]);
  const openCodeRelays = new Set(["relay-1"]);
  const readinessCalls: unknown[] = [];
  let relayProbes = 0;
  const deps: OpenCodeAcpHarnessTaskDeps = {
    facts: {
      getAgentOwner: async () => OWNER,
      roomExists: async () => true,
      isAgentMember: async () => true,
    },
    relay: {
      listConnected: async () => { relayProbes++; return [...sessions.keys()]; },
      getAcpSessionForRegistration: (relayId, userId, registrationId) => {
        if (registrationId !== "opencode-acp" || !openCodeRelays.has(relayId)) return null;
        const candidate = sessions.get(relayId) ?? null;
        return candidate?.userId === userId ? candidate : null;
      },
      requestAcpReadiness: async (input) => { readinessCalls.push(input); return "ready"; },
    },
    createTask: async (input) => {
      created = input;
      return { taskId: "55555555-5555-4555-8555-555555555555", status: "pending" };
    },
    mintRequestId: () => "request-1",
    ...overrides,
  };
  return { deps, sessions, openCodeRelays, created: () => created, readinessCalls: () => readinessCalls, relayProbes: () => relayProbes };
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected admission failure");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("createOpenCodeAcpHarnessTask", () => {
  test.each(["interactive", "autonomous", "plan"] as const)(
    "admits one authenticated v15-ready desktop and seals the explicit %s profile",
    async (executionProfile) => {
      const h = harness();
      expect(await createOpenCodeAcpHarnessTask(h.deps, { ...request, executionProfile })).toEqual({
        taskId: "55555555-5555-4555-8555-555555555555",
        status: "pending",
        execution: "opencode-acp",
      });
      expect(h.readinessCalls()).toEqual([{
        relayId: "relay-1",
        userId: OWNER,
        requestId: "request-1",
        registrationId: "opencode-acp",
        timeoutMs: 5_000,
      }]);
      expect(h.created()).toEqual({
        ownerId: OWNER,
        requestorId: OWNER,
        agentId: AGENT,
        prompt: "Inspect the repository",
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
            ...OPENCODE_ACP_HARNESS_TASK_EXECUTION_DESCRIPTOR,
            executionProfile,
            readiness: {
              relayId: "relay-1",
              relaySessionId: "session-1",
              pairingGenerationRef: "pairing-1",
              desktopSessionId: "desktop-1",
              selectedProtocolVersion: OPENCODE_ACP_RELAY_PROTOCOL_VERSION,
              capabilityRevision: 5,
            },
          },
        },
      });
    },
  );

  test.each([
    ["missing profile", { executionProfile: undefined }],
    ["unknown profile", { executionProfile: "full-access" }],
    ["wrong harness", { harness: "hermes-acp" }],
    ["extra path", { workingDirectory: "/private/owner" }],
    ["extra provider", { provider: "secret-provider" }],
    ["extra model", { model: "paid-model" }],
    ["extra environment", { env: { TOKEN: "secret" } }],
    ["extra process", { pid: 1234 }],
    ["extra metadata", { metadata: { rawAcp: true } }],
  ] as const)("rejects malformed input with %s before readiness or Task write", async (_name, extra) => {
    const h = harness();
    await expectFailure(createOpenCodeAcpHarnessTask(h.deps, {
      ...request,
      ...extra,
    } as unknown as CreateOpenCodeAcpHarnessTaskInput), "ACP_HARNESS_UNAVAILABLE");
    expect(h.relayProbes()).toBe(0);
    expect(h.readinessCalls()).toEqual([]);
    expect(h.created()).toBeUndefined();
  });

  test("rejects substituted authority before probing the desktop", async () => {
    const h = harness();
    await expectFailure(createOpenCodeAcpHarnessTask(h.deps, {
      ...request,
      requestorId: "44444444-4444-4444-8444-444444444444",
    }), "ACP_SOURCE_FORBIDDEN");
    expect(h.relayProbes()).toBe(0);
    expect(h.created()).toBeUndefined();
  });

  test.each([
    ["missing Room", { roomExists: async () => false }, "ACP_ROOM_UNAVAILABLE"],
    ["foreign Agent", { getAgentOwner: async () => "foreign" }, "ACP_SOURCE_FORBIDDEN"],
    ["non-member Agent", { isAgentMember: async () => false }, "ACP_SOURCE_FORBIDDEN"],
  ] as const)("fails closed for %s", async (_name, factOverride, code) => {
    const h = harness({ facts: { ...harness().deps.facts, ...factOverride } });
    await expectFailure(createOpenCodeAcpHarnessTask(h.deps, request), code);
    expect(h.created()).toBeUndefined();
  });

  test("requires exactly one safe v15 desktop before readiness", async () => {
    const old = harness();
    old.sessions.set("relay-1", session("relay-1", { selectedProtocolVersion: OPENCODE_ACP_RELAY_PROTOCOL_VERSION - 1 }));
    await expectFailure(createOpenCodeAcpHarnessTask(old.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(old.readinessCalls()).toEqual([]);

    const ambiguous = harness();
    ambiguous.sessions.set("relay-2", session("relay-2"));
    ambiguous.openCodeRelays.add("relay-2");
    await expectFailure(createOpenCodeAcpHarnessTask(ambiguous.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(ambiguous.readinessCalls()).toEqual([]);
    expect(ambiguous.created()).toBeUndefined();
  });

  test("ignores a Hermes-only v15 desktop when exactly one desktop advertises OpenCode", async () => {
    const h = harness();
    h.sessions.set("relay-2", session("relay-2"));
    expect(await createOpenCodeAcpHarnessTask(h.deps, request)).toMatchObject({
      execution: "opencode-acp",
      status: "pending",
    });
    expect(h.readinessCalls()).toHaveLength(1);
    expect(h.readinessCalls()[0]).toMatchObject({ relayId: "relay-1" });
  });

  test.each(["missing", "incompatible", "authentication_required", "unavailable"] as const)(
    "does not persist when OpenCode readiness is %s",
    async (state) => {
      const h = harness({
        relay: {
          listConnected: async () => ["relay-1"],
          getAcpSessionForRegistration: (relayId, userId, registrationId) =>
            relayId === "relay-1" && userId === OWNER && registrationId === "opencode-acp" ? session() : null,
          requestAcpReadiness: async () => state,
        },
      });
      await expectFailure(createOpenCodeAcpHarnessTask(h.deps, request), "ACP_HARNESS_UNAVAILABLE");
      expect(h.created()).toBeUndefined();
    },
  );

  test("normalizes private errors and rejects a successor socket generation", async () => {
    const unavailable = harness({
      relay: {
        listConnected: async () => { throw new Error("/private/owner/path"); },
        getAcpSessionForRegistration: () => null,
        requestAcpReadiness: async () => "ready",
      },
    });
    await expectFailure(createOpenCodeAcpHarnessTask(unavailable.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(unavailable.created()).toBeUndefined();

    let reads = 0;
    const stale = harness({
      relay: {
        listConnected: async () => ["relay-1"],
        getAcpSessionForRegistration: (relayId, userId, registrationId) =>
          relayId === "relay-1" && userId === OWNER && registrationId === "opencode-acp"
          ? session("relay-1", { capabilityRevision: reads++ === 0 ? 5 : 6 })
          : null,
        requestAcpReadiness: async () => "ready",
      },
    });
    await expectFailure(createOpenCodeAcpHarnessTask(stale.deps, request), "ACP_HARNESS_UNAVAILABLE");
    expect(stale.created()).toBeUndefined();

    const writeFailure = harness({
      createTask: async () => { throw new Error("database failed at /private/owner/path"); },
    });
    await expectFailure(createOpenCodeAcpHarnessTask(writeFailure.deps, request), "ACP_HARNESS_UNAVAILABLE");
  });

  test("snapshots profile and authority before readiness", async () => {
    const mutable = { ...request };
    const h = harness({
      relay: {
        listConnected: async () => ["relay-1"],
        getAcpSessionForRegistration: (relayId, userId, registrationId) =>
          relayId === "relay-1" && userId === OWNER && registrationId === "opencode-acp" ? session() : null,
        requestAcpReadiness: async () => {
          mutable.prompt = "changed";
          mutable.executionProfile = "autonomous";
          return "ready";
        },
      },
    });
    await createOpenCodeAcpHarnessTask(h.deps, mutable);
    expect(h.created()).toMatchObject({
      prompt: "Inspect the repository",
      metadata: { execution: { executionProfile: "interactive" } },
    });
  });

  test.each([
    ["Room existence", (state: { room: boolean; owner: string; member: boolean }) => { state.room = false; }, "ACP_ROOM_UNAVAILABLE"],
    ["Agent owner", (state: { room: boolean; owner: string; member: boolean }) => { state.owner = "foreign"; }, "ACP_SOURCE_FORBIDDEN"],
    ["Agent membership", (state: { room: boolean; owner: string; member: boolean }) => { state.member = false; }, "ACP_SOURCE_FORBIDDEN"],
  ] as const)("rechecks %s after readiness and performs zero Task writes on drift", async (_name, mutate, code) => {
    const state = { room: true, owner: OWNER, member: true };
    const h = harness({
      facts: {
        roomExists: async () => state.room,
        getAgentOwner: async () => state.owner,
        isAgentMember: async () => state.member,
      },
      relay: {
        listConnected: async () => ["relay-1"],
        getAcpSessionForRegistration: (relayId, userId, registrationId) =>
          relayId === "relay-1" && userId === OWNER && registrationId === "opencode-acp" ? session() : null,
        requestAcpReadiness: async () => {
          mutate(state);
          return "ready";
        },
      },
    });
    await expectFailure(createOpenCodeAcpHarnessTask(h.deps, request), code);
    expect(h.created()).toBeUndefined();
  });
});
