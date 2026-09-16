import { describe, expect, test } from "bun:test";
import type { DirectDatabase, Task } from "@nautilo/db";
import { resolveTargetRoom } from "@nautilo/runtime";
import {
  CODEX_HARNESS_TASK_EXECUTION_DESCRIPTOR,
  createCodexHarnessTask,
  type CodexHarnessTaskDeps,
} from "../../src/codex/harness-task";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const PROFILE = "44444444-4444-4444-8444-444444444444";

function harness(overrides: Partial<CodexHarnessTaskDeps> = {}) {
  let created: Parameters<CodexHarnessTaskDeps["createTask"]>[0] | undefined;
  const deps: CodexHarnessTaskDeps = {
    preferences: {
      getOwnerPreference: async () => ({ enabled: true, accountProfileId: PROFILE, defaultPosture: "codex_default" }),
      getProfile: async () => ({
        id: PROFILE, userId: OWNER, relayId: "relay", profileHandle: PROFILE,
        profileGeneration: 1, accountGeneration: 1,
        authState: "signed_in", removalState: "active",
      }),
    },
    facts: {
      getAgentOwner: async () => OWNER,
      roomExists: async () => true,
      isAgentMember: async () => true,
    },
    models: {
      list: async () => ({ models: [{
        id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol",
        description: "Frontier coding model", isDefault: true,
      }], preferredModelId: "gpt-5.6-sol" }),
    },
    limits: {
      resolve: async (modelId) => ({
        modelId,
        catalogVersion: "test-catalog-v1",
        contextTokens: 1_000_000,
        maxOutputTokens: 128_000,
      }),
    },
    preflight: { prepare: async () => undefined },
    readiness: {
      check: async () => ({
        relayId: "relay",
        pairingGenerationRef: "pairing-1",
        capabilityRevision: 4,
      }),
    },
    createTask: async (input) => {
      created = input;
      return { taskId: "55555555-5555-4555-8555-555555555555", status: "pending" };
    },
    ...overrides,
  };
  return { deps, created: () => created };
}

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
  harness: "codex" as const,
  collaborationMode: "work" as const,
};

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected harness admission to fail");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("createCodexHarnessTask", () => {
  test("seals immediate current-Room Codex execution metadata", async () => {
    const h = harness();
    expect(await createCodexHarnessTask(h.deps, {
      ...request,
      workingDirectory: "/projects/nautilo",
    })).toMatchObject({
      execution: "codex",
      status: "pending",
    });
    expect(h.created()).toMatchObject({
      scheduleKind: "now",
      targetChat: "last_in_namespace",
      targetRoomId: ROOM,
      callingRoomId: ROOM,
      targetUserIds: [OWNER],
      toolsMode: "none",
      resultDelivery: "raw_and_wake",
      requestedModelId: null,
      metadata: {
        execution: {
          ...CODEX_HARNESS_TASK_EXECUTION_DESCRIPTOR,
          harnessModelId: "gpt-5.6-sol",
          outputContract: {
            version: 1,
            capabilityModelId: "openai:gpt-5.6-sol",
            catalogVersion: "test-catalog-v1",
            contextTokens: 1_000_000,
            outputTokens: 128_000,
          },
          workingDirectory: "/projects/nautilo",
          readiness: {
            relayId: "relay",
            pairingGenerationRef: "pairing-1",
            capabilityRevision: 4,
          },
        },
      },
    });
  });

  test("its sealed Task descriptor keeps the calling Room through runtime resolution", async () => {
    const h = harness();
    await createCodexHarnessTask(h.deps, {
      ...request,
      workingDirectory: "/projects/nautilo",
    });
    const created = h.created();
    expect(created).toBeDefined();

    const task = {
      id: "55555555-5555-4555-8555-555555555555",
      ...created,
    } as Task;
    const db = {
      select: () => { throw new Error("runtime must not fall back to namespace lookup"); },
      insert: () => { throw new Error("runtime must not create another Room"); },
    } as unknown as DirectDatabase;

    expect(await resolveTargetRoom(task, { db })).toEqual({
      roomId: ROOM,
      graphThreadId: `room:${ROOM}:bot:${AGENT}`,
    });
  });

  test("keeps Plan in the sealed descriptor", async () => {
    const h = harness();
    await createCodexHarnessTask(h.deps, { ...request, collaborationMode: "plan" });
    expect(h.created()).toMatchObject({
      metadata: {
        execution: {
          version: 1,
          harnessId: "codex",
          source: "genie",
          collaborationMode: "plan",
          harnessModelId: "gpt-5.6-sol",
          readiness: {
            relayId: "relay",
            pairingGenerationRef: "pairing-1",
            capabilityRevision: 4,
          },
        },
      },
    });
  });

  test("validates an advanced model id through the live harness catalog before sealing only that id", async () => {
    const h = harness();
    await createCodexHarnessTask(h.deps, { ...request, harnessModelId: "gpt-5.6-sol" });
    expect(h.created()).toMatchObject({
      requestedModelId: null,
      metadata: { execution: { harnessModelId: "gpt-5.6-sol" } },
    });
  });

  test("rejects an unadvertised harness model selection", async () => {
    const h = harness();
    await expectFailure(
      createCodexHarnessTask(h.deps, { ...request, harnessModelId: "invented" }),
      "CODEX_MODEL_UNAVAILABLE",
    );
  });

  test("explicit Codex selection never falls back", async () => {
    const h = harness({
      preferences: {
        getOwnerPreference: async () => ({ enabled: false, accountProfileId: PROFILE, defaultPosture: "codex_default" }),
        getProfile: async () => undefined,
      },
    });
    await expectFailure(createCodexHarnessTask(h.deps, request), "CODEX_NOT_ENABLED");
    expect(h.created()).toBeUndefined();
  });

  test("maps a synchronous pre-task readiness failure to the paired host before creating a durable Task", async () => {
    const unavailable = harness({
      readiness: {
        check: () => {
          throw Object.assign(new Error("stale workspace"), { code: "CODEX_STALE" });
        },
      },
    });
    await expectFailure(
      createCodexHarnessTask(unavailable.deps, request),
      "CODEX_HOST_UNAVAILABLE",
    );
    expect(unavailable.created()).toBeUndefined();
  });

  test("rehydrates a cold selected profile before readiness and model admission", async () => {
    const order: string[] = [];
    const h = harness({
      preflight: { prepare: async () => { order.push("preflight"); } },
      readiness: {
        check: async () => {
          order.push("readiness");
          return { relayId: "relay", pairingGenerationRef: "pairing-1", capabilityRevision: 4 };
        },
      },
      models: {
        list: async () => {
          order.push("models");
          return { models: [{
            id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol",
            description: "Frontier coding model", isDefault: true,
          }], preferredModelId: "gpt-5.6-sol" };
        },
      },
    });

    await createCodexHarnessTask(h.deps, request);
    expect(order).toEqual(["preflight", "readiness", "models"]);
  });

  test("does not hide missing Room authority behind another executor", async () => {
    const h = harness({ facts: { getAgentOwner: async () => OWNER, roomExists: async () => false, isAgentMember: async () => false } });
    await expectFailure(
      createCodexHarnessTask(h.deps, request),
      "CODEX_ROOM_UNAVAILABLE",
    );
    expect(h.created()).toBeUndefined();
  });

  test("rejects a foreign or non-member source Genie before creating either executor", async () => {
    const foreign = harness({
      facts: {
        getAgentOwner: async () => "66666666-6666-4666-8666-666666666666",
        roomExists: async () => true,
        isAgentMember: async () => true,
      },
    });
    await expectFailure(
      createCodexHarnessTask(foreign.deps, request),
      "CODEX_SOURCE_FORBIDDEN",
    );
    expect(foreign.created()).toBeUndefined();

    const absent = harness({
      facts: {
        getAgentOwner: async () => OWNER,
        roomExists: async () => true,
        isAgentMember: async () => false,
      },
    });
    await expectFailure(
      createCodexHarnessTask(absent.deps, request),
      "CODEX_SOURCE_FORBIDDEN",
    );
    expect(absent.created()).toBeUndefined();
  });
});
