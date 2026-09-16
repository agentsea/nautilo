/**
 * D201 — per-user soul must come from profiles.soul_file only.
 * Empty/null profile soul must NOT fall back to the operator's disk mirror.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import * as realNautiloAgent from "@nautilo/agent";
import * as realTrust from "@nautilo/trust";

let loadSoulFromDiskCalls = 0;
let capturedGraphSoulFile: string | undefined;
let capturedGraphAssistantName: string | undefined;
let capturedGraphModel: string | null | undefined;

mock.module("@nautilo/agent", () => ({
  ...realNautiloAgent,
  getProfile: async () => ({
    soulFile: "OWNER SOUL — must not leak into agent identity",
    name: "Owner Profile Name",
    defaultModel: "owner-model-must-not-leak",
  }),
  getProfileByAgentId: async () => {
    throw new Error("Execution must use the narrow Agent configuration projection");
  },
  getAgentExecutionConfigById: async (agentId: string) => ({
    soulFile: agentId === "agent-casey" ? "Casey agent soul" : null,
    name: agentId === "agent-casey" ? "Casey Genie" : "Test Agent",
    defaultModel: agentId === "agent-casey" ? "casey-model" : "test-model",
  }),
  loadSoulFileFromDisk: async () => {
    loadSoulFromDiskCalls += 1;
    return "OPERATOR DISK SOUL — must not leak";
  },
  createCheckpointSaver: () => ({}),
  createNautiloGraph: () => ({
    getState: async () => ({ values: { messages: [] } }),
    streamEvents: (input: Record<string, unknown>) => {
      capturedGraphSoulFile = input["soulFile"] as string | undefined;
      capturedGraphAssistantName = input["assistantName"] as string | undefined;
      capturedGraphModel = input["model"] as string | null | undefined;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: true as const, value: undefined }),
          };
        },
      };
    },
  }),
  getDefaultModel: () => ({ id: "test-model" }),
  // Model availability is covered by M252's dedicated runtime tests. Keep this
  // D201 identity fixture focused on which profile owns the selected value.
  resolveModelRole: (
    _role: string,
    options?: { configuredId?: string | null },
  ) => options?.configuredId?.trim() || "test-model",
  maybeSummarizeImagesWithVisionFallback: async () => [],
  getAgentDisplayNameById: async () => null,
  getPromptBrief: async () => "",
  appendTranscriptMessages: async () => ({
    failedIndices: [],
    insertedCount: 0,
    insertedRows: [],
  }),
}));

mock.module("@nautilo/trust", () => ({
  ...realTrust,
  getPolicyResolver: () => ({}),
  envelopeReadableNamespaces: () => [],
  getBootstrapDefaultAgentId: () => "default-agent",
}));

const { langgraphExecutor } = await import("../../src/executors/langgraph-executor");

afterAll(() => {
  mock.module("@nautilo/agent", () => realNautiloAgent);
  mock.module("@nautilo/trust", () => realTrust);
});

describe("langgraph executor soul resolution (D201)", () => {
  test("empty profile soul passes empty string — no disk fallback", async () => {
    loadSoulFromDiskCalls = 0;
    capturedGraphSoulFile = undefined;
    capturedGraphAssistantName = undefined;
    capturedGraphModel = undefined;

    const ac = new AbortController();
    // M125 Phase 2.6 — executor now requires an explicit agentId (no
    // bootstrap fallback). Provide one so we still exercise the
    // soul-resolution path under test.
    const gen = langgraphExecutor(
      {
        ownerId: "user-test",
        message: "hi",
        agentId: "default-agent",
      },
      "job-d201-soul",
      "app:default",
      ac.signal,
    );
    for await (const _ of gen) {
      // drain until stream completes
    }

    expect(loadSoulFromDiskCalls).toBe(0);
    expect(capturedGraphSoulFile).toBeDefined();
    expect(capturedGraphSoulFile!).toBe("");
  });

  test("agent profile owns soul/name/model even when ownerId is the room sender", async () => {
    loadSoulFromDiskCalls = 0;
    capturedGraphSoulFile = undefined;
    capturedGraphAssistantName = undefined;
    capturedGraphModel = undefined;

    const ac = new AbortController();
    const gen = langgraphExecutor(
      {
        ownerId: "alex-user",
        message: "hi",
        agentId: "agent-casey",
      },
      "job-d317-foreign-agent-identity",
      "room:test:user:alex:bot:agent-casey",
      ac.signal,
    );
    for await (const _ of gen) {
      // drain until stream completes
    }

    expect(loadSoulFromDiskCalls).toBe(0);
    expect(capturedGraphSoulFile as string | undefined).toBe("Casey agent soul");
    expect(capturedGraphAssistantName as string | undefined).toBe("Casey Genie");
    expect(capturedGraphModel as string | null | undefined).toBe("casey-model");
  });
});

/**
 * M125 Phase 2.6 / QA #11 — the executor must throw loudly when no
 * agentId resolves (neither `input.agentId` nor `memoryAccessEnvelope.agentId`).
 * Pre-M125 it silently borrowed `getBootstrapDefaultAgentId()` and
 * dispatched the turn into the operator's agent partition. Background
 * jobs and stale callers must now fail at the source.
 */
describe("langgraph executor — M125 Phase 2.6 (agentId required)", () => {
  test("throws when neither input.agentId nor envelope.agentId is set", async () => {
    const ac = new AbortController();
    const gen = langgraphExecutor(
      { ownerId: "user-x", message: "hi" },
      "job-m125-no-agent",
      "app:default",
      ac.signal,
    );
    let threwExpected = false;
    try {
      for await (const _ of gen) {
        // drain (should never iterate — throw happens before stream)
      }
    } catch (err) {
      threwExpected = err instanceof Error && /agentId required/.test(err.message);
    }
    expect(threwExpected).toBe(true);
  });
});
