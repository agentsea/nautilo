/**
 * D526 — hermetic progressive-tool cache-wire characterization.
 *
 * The four dispatches use the production protected pre-model -> agent ->
 * provider path. The only transport seam is Anthropic's already-serialized
 * completion method, so no provider request, prompt, or tool body leaves this
 * process. The activation snapshot is produced by Nautilo's real
 * `activate_tools` implementation before it enters the next protected turn.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolCatalog, clearToolCatalog, getToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { z } from "zod";
import type { NautiloState } from "../../src/agent/state";
import {
  createActivatedToolsHandle,
} from "../../src/tools/meta/activated-tools-handle";
import { createActivateToolsTool } from "../../src/tools/meta/activate-tools";
import type { TransientAgentRuntimeConfiguration } from "../../src/runtime/protected-runtime-dispatch";

const MODEL_ID = "anthropic:claude-sonnet-4-6";
const DUMMY_ANTHROPIC_KEY = "d526-hermetic-dummy-key";
const DUMMY_OPENAI_KEY = "d526-hermetic-unused-openai-key";
const CORE_TOOL = "d526_stable_tool";
const DISCOVERABLE_TOOL = "d526_discoverable_tool";

type AnthropicTool = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
};

type AnthropicRequest = {
  readonly system?: unknown;
  readonly messages?: unknown;
  readonly tools?: AnthropicTool[];
};

let runNautiloTransientProtectedModelDispatch: typeof import("../../src/runtime/protected-runtime-dispatch")["runNautiloTransientProtectedModelDispatch"];
const capturedRequests: AnthropicRequest[] = [];
let savedCompletionWithRetry: unknown;
let savedCreateStreamWithRetry: unknown;
let savedFetch: typeof globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
let roomModelControl: { selection: { modelId: string } } | null = null;

function syntheticAnthropicResponse(): Record<string, unknown> {
  return {
    id: "msg_d526_activated_tool_hermetic",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "activated-tool-cache-wire-ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function checkpointState(
  activatedToolNames: string[] = [],
  activatedToolLeases: Array<{ name: string; idleTurns: number }> = [],
): NautiloState {
  return {
    soulFile: "",
    skills: [],
    memoryBrief: "",
    preparedMessages: [],
    messages: [new HumanMessage("D526 activated-tool cache wire probe")],
    model: "openai:gpt-5.6-luna",
    userId: "d526-user",
    causalHumanUserId: "d526-user",
    agentId: "d526-agent",
    actorRole: "owner",
    roomId: "d526-room",
    currentThreadId: "d526-activated-tool-thread",
    turnId: "d526-activated-tool-turn",
    assistantName: "Genie",
    currentFolder: "",
    workspacePath: "",
    userTimezone: "UTC",
    roomRoster: [],
    activatedToolNames,
    activatedToolLeases,
    activationLeasesInitialized: true,
    activationLeasesAgedForTurnId: "d526-activated-tool-turn",
    activationIntentAppliedForTurnId: "d526-activated-tool-turn",
    subagentDepth: 0,
    subagentMaxDepth: 5,
    subagentRun: true,
  } as unknown as NautiloState;
}

const protectedConfiguration: TransientAgentRuntimeConfiguration = {
  formatVersion: 1,
  soulFile: "",
  memoryBrief: "",
  skills: [],
  commands: [],
  onboardingAnswers: [],
};

function fixtureTool(name: string, description: string, schema: z.ZodType) {
  return new DynamicStructuredTool({
    name,
    description,
    schema,
    func: async () => "D526 fixture tool must not execute during cache-wire capture",
  });
}

function registerToolFixture(): void {
  const catalog = new ToolCatalog();
  catalog.register({
    name: CORE_TOOL,
    factory: () => fixtureTool(
      CORE_TOOL,
      "Stable D526 fixture available on every selected turn.",
      z.object({ acknowledgment: z.literal("stable") }),
    ),
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    exposure: "core",
  });
  catalog.register({
    name: DISCOVERABLE_TOOL,
    factory: () => fixtureTool(
      DISCOVERABLE_TOOL,
      "Discoverable D526 fixture activated through Nautilo's existing selection path.",
      z.object({ query: z.string().min(1), mode: z.enum(["precise", "broad"]).default("precise") }),
    ),
    category: "meta",
    trustTier: "guest",
    impact: "read-only",
    exposure: "discoverable",
  });
  initToolCatalog(catalog);
}

function toolWire(request: AnthropicRequest): AnthropicTool[] {
  expect(request.tools).toBeArray();
  return request.tools as AnthropicTool[];
}

/** The SDK's eventual JSON request cannot retain Zod's in-memory helpers. */
function serializedToolWire(request: AnthropicRequest): AnthropicTool[] {
  return JSON.parse(JSON.stringify(toolWire(request))) as AnthropicTool[];
}

function stableCacheBreakpoint(request: AnthropicRequest): string {
  expect(request.system).toBeArray();
  const system = request.system as Array<Record<string, unknown>>;
  expect(system[0]).toMatchObject({
    type: "text",
    cache_control: { type: "ephemeral" },
  });
  expect(typeof system[0]?.["text"]).toBe("string");
  expect((system[0]?.["text"] as string).length).toBeGreaterThan(0);
  return system[0]?.["text"] as string;
}

beforeAll(async () => {
  const realTrust = await import("@nautilo/trust");
  mock.module("@nautilo/db", () => ({
    getCachedServerModelConfigRow: () => null,
    getProfileDefaultModelControlSelection: async () => null,
    getRoomAgentModelControlSelection: async () => roomModelControl,
    kickServerModelConfigRefresh: () => {},
    insertLlmUsageEvent: async () => {
      throw new Error("D526 activated-tool cache-wire test must not persist usage");
    },
  }));
  mock.module("../../src/utils/resolve-fallback-policy", () => ({
    resolveFallbackPolicy: async () => ({ enabled: false, chain: [] }),
  }));
  mock.module("../../src/notifications/session-notifications", () => ({
    drainSessionNotifications: async () => [],
    buildSessionNotificationsBlock: () => null,
  }));
  mock.module("@nautilo/trust", () => ({
    ...realTrust,
    envelopeReadableNamespaces: () => [],
    assertCanUseServerProviderCredentials: async (humanUserId: string) => {
      expect(humanUserId).toBe("d526-user");
    },
  }));

  savedEnv["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"];
  savedEnv["OPENAI_API_KEY"] = process.env["OPENAI_API_KEY"];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    throw new Error(`Unexpected HTTP request in D526 activated-tool cache-wire test: ${url}`);
  }) as unknown as typeof globalThis.fetch;
  process.env["ANTHROPIC_API_KEY"] = DUMMY_ANTHROPIC_KEY;
  process.env["OPENAI_API_KEY"] = DUMMY_OPENAI_KEY;

  const proto = ChatAnthropic.prototype as unknown as {
    completionWithRetry: (request: AnthropicRequest) => Promise<unknown>;
    createStreamWithRetry: () => Promise<unknown>;
  };
  savedCompletionWithRetry = proto.completionWithRetry;
  savedCreateStreamWithRetry = proto.createStreamWithRetry;
  proto.completionWithRetry = async (request) => {
    capturedRequests.push(request);
    return syntheticAnthropicResponse();
  };
  proto.createStreamWithRetry = async () => {
    throw new Error("D526 activated-tool cache-wire test expected non-streaming Anthropic invoke");
  };

  registerToolFixture();
  ({ runNautiloTransientProtectedModelDispatch } = await import(
    "../../src/runtime/protected-runtime-dispatch"
  ));
});

afterAll(() => {
  (ChatAnthropic.prototype as unknown as {
    completionWithRetry: unknown;
    createStreamWithRetry: unknown;
  }).completionWithRetry = savedCompletionWithRetry;
  (ChatAnthropic.prototype as unknown as {
    createStreamWithRetry: unknown;
  }).createStreamWithRetry = savedCreateStreamWithRetry;
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearToolCatalog();
  mock.restore();
});

beforeEach(() => {
  capturedRequests.length = 0;
  roomModelControl = { selection: { modelId: MODEL_ID } };
});

describe("D526 Anthropic tool-selection cache wire", () => {
  test("keeps stable and activated cache spans byte-shaped around one real activation", async () => {
    await runNautiloTransientProtectedModelDispatch({
      checkpointState: checkpointState(),
      configuration: protectedConfiguration,
    });
    await runNautiloTransientProtectedModelDispatch({
      checkpointState: checkpointState(),
      configuration: protectedConfiguration,
    });

    const activationHandle = createActivatedToolsHandle();
    const activation = createActivateToolsTool({ activatedTools: activationHandle });
    expect(getToolCatalog()?.size).toBe(2);
    const activationResult = JSON.parse(await activation.invoke({
      names: [DISCOVERABLE_TOOL],
      families: [],
    })) as {
      accepted: string[];
      rejected: unknown[];
      activeToolNames: string[];
      note: string;
    };
    expect(activationResult).toEqual({
      accepted: [DISCOVERABLE_TOOL],
      rejected: [],
      activeToolNames: [DISCOVERABLE_TOOL],
      note: "Accepted deferred tool schemas are callable on the next model step; exact host, trust, and local-consent checks are revalidated at invocation.",
    });
    expect(activationHandle.snapshotLeases()).toEqual([{ name: DISCOVERABLE_TOOL, idleTurns: 0 }]);
    // Activation selects an existing catalog entry; it neither mounts nor
    // registers a new provider tool.
    expect(getToolCatalog()?.size).toBe(2);

    await runNautiloTransientProtectedModelDispatch({
      checkpointState: checkpointState(
        activationResult.activeToolNames,
        activationHandle.snapshotLeases(),
      ),
      configuration: protectedConfiguration,
    });
    await runNautiloTransientProtectedModelDispatch({
      checkpointState: checkpointState(
        activationResult.activeToolNames,
        activationHandle.snapshotLeases(),
      ),
      configuration: protectedConfiguration,
    });

    expect(capturedRequests).toHaveLength(4);
    const [stable, stableAgain, activated, activatedAgain] = capturedRequests;
    expect(stable).toBeDefined();
    expect(stableAgain).toBeDefined();
    expect(activated).toBeDefined();
    expect(activatedAgain).toBeDefined();
    const cacheBlocks = capturedRequests.map((request) => {
      expect(request).toMatchObject({ model: "claude-sonnet-4-6" });
      return stableCacheBreakpoint(request);
    });
    expect(cacheBlocks[0]).toBe(cacheBlocks[1]);
    expect(cacheBlocks[2]).toBe(cacheBlocks[3]);
    expect(cacheBlocks[2]).not.toBe(cacheBlocks[0]);

    expect(serializedToolWire(stable!)).toEqual([
      {
        name: CORE_TOOL,
        description: "Stable D526 fixture available on every selected turn.",
        input_schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { acknowledgment: { type: "string", const: "stable" } },
          required: ["acknowledgment"],
          additionalProperties: false,
        },
      },
    ]);
    expect(serializedToolWire(stableAgain!)).toEqual(serializedToolWire(stable!));
    expect(serializedToolWire(activated!)).toEqual([
      ...serializedToolWire(stable!),
      {
        name: DISCOVERABLE_TOOL,
        description: "Discoverable D526 fixture activated through Nautilo's existing selection path.",
        input_schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            query: { type: "string", minLength: 1 },
            mode: { type: "string", enum: ["precise", "broad"], default: "precise" },
          },
          required: ["query", "mode"],
          additionalProperties: false,
        },
      },
    ]);
    expect(serializedToolWire(activatedAgain!)).toEqual(serializedToolWire(activated!));
  });
});
