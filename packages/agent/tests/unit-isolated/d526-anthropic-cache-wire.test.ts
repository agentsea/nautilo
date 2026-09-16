/**
 * D526 — hermetic cache-wire characterization.
 *
 * This drives the production protected transient dispatch all the way through
 * preModelNode -> agentNode -> invokeChatModelWithFallback -> universal model
 * factory -> bindTools -> LangChain's Anthropic serializer. The only seam is
 * LangChain's final Anthropic completion method, after it has assembled the
 * request object and immediately before the SDK client would send it. Its
 * synthetic response makes this a zero-billing, zero-network test while the
 * captured object is the request body the client would otherwise serialize.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import type { NautiloState } from "../../src/agent/state";
import type { TransientAgentRuntimeConfiguration } from "../../src/runtime/protected-runtime-dispatch";

const MODEL_ID = "anthropic:claude-sonnet-4-6";
const DUMMY_ANTHROPIC_KEY = "d526-hermetic-dummy-key";
const DUMMY_OPENAI_KEY = "d526-hermetic-unused-openai-key";

type AnthropicRequest = {
  readonly system?: unknown;
  readonly messages?: unknown;
  readonly tools?: unknown;
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
    id: "msg_d526_hermetic",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "cache-wire-ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    // Keep usage at zero so Nautilo's real constructor-attached usage callback
    // has nothing to persist. The provider factory and callback wiring still
    // execute exactly as production does.
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function checkpointState(model: string): NautiloState {
  return {
    // Protected dispatch requires these durable fields to be clean. The
    // configuration below lends its plaintext only to this one invocation.
    soulFile: "",
    skills: [],
    memoryBrief: "",
    preparedMessages: [],
    messages: [new HumanMessage("D526 hermetic cache wire probe")],
    model,
    userId: "d526-user",
    agentId: "d526-agent",
    actorRole: "owner",
    roomId: "d526-room",
    currentThreadId: "d526-hermetic-thread",
    turnId: "d526-hermetic-turn",
    assistantName: "Genie",
    currentFolder: "",
    workspacePath: "",
    userTimezone: "UTC",
    roomRoster: [],
    activatedToolNames: [],
    activatedToolLeases: [],
    subagentDepth: 0,
    subagentMaxDepth: 5,
    // This suppresses the durable session-notification drain; the test is
    // intentionally confined to the protected model dispatch and has no DB.
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

beforeAll(async () => {
  // Preserve the Trust facade's full public export surface: several unrelated
  // type-safe tool modules import nominal Trust values while this prompt is
  // assembled. Only the envelope predicate is relevant to this hermetic run.
  const realTrust = await import("@nautilo/trust");
  // The fallback policy and server-model cache are independent persistence
  // boundaries. Keep their production callers intact while giving this test a
  // deterministic no-DB answer.
  mock.module("@nautilo/db", () => ({
    getCachedServerModelConfigRow: () => null,
    getProfileDefaultModelControlSelection: async () => null,
    getRoomAgentModelControlSelection: async () => roomModelControl,
    kickServerModelConfigRefresh: () => {},
    insertLlmUsageEvent: async () => {
      throw new Error("D526 cache-wire test must not persist usage");
    },
  }));
  mock.module("../../src/utils/resolve-fallback-policy", () => ({
    resolveFallbackPolicy: async () => ({ enabled: false, chain: [] }),
  }));
  mock.module("../../src/notifications/session-notifications", () => ({
    drainSessionNotifications: async () => [],
    buildSessionNotificationsBlock: () => null,
  }));
  // The nodes need only this pure envelope projection. Mocking the package
  // facade avoids loading unrelated Trust database adapters into a test whose
  // contract is strictly the model wire.
  mock.module("@nautilo/trust", () => ({
    ...realTrust,
    envelopeReadableNamespaces: () => [],
  }));

  // This process-local key is deliberately synthetic. The SDK still follows
  // its ordinary direct-Anthropic construction path, but no secret is read.
  savedEnv["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"];
  savedEnv["OPENAI_API_KEY"] = process.env["OPENAI_API_KEY"];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    throw new Error(`Unexpected HTTP request in D526 cache-wire test: ${url}`);
  }) as unknown as typeof globalThis.fetch;
  process.env["ANTHROPIC_API_KEY"] = DUMMY_ANTHROPIC_KEY;
  // Agent model-role resolution validates the pre-model's OpenAI selection
  // before room controls replace it with Sonnet. This key is never routed or
  // sent; it only reproduces a configured default-model environment.
  process.env["OPENAI_API_KEY"] = DUMMY_OPENAI_KEY;
  // Lowest controllable no-network seam for this non-streaming production
  // path. `_generateNonStreaming` has already merged invocation parameters
  // and serialized Nautilo's LangChain messages into `request`; the real
  // method would next hand exactly this object to Anthropic's HTTP client.
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
    throw new Error("D526 cache-wire test expected non-streaming Anthropic invoke");
  };

  // A deliberately empty catalog still exercises the real progressive-tool
  // resolver plus bindTools([]), without constructing any tool with I/O.
  initToolCatalog(new ToolCatalog());
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
  mock.restore();
});

beforeEach(() => {
  capturedRequests.length = 0;
  // Reproduce the live turn's room-scoped selection: agentNode chooses Sonnet
  // after preModelNode has already projected the prompt from state.model.
  roomModelControl = { selection: { modelId: MODEL_ID } };
});

describe("D526 Anthropic cache marker reaches the SDK wire", () => {
  test("room-selected Sonnet receives the cache marker even when pre-model projected OpenAI", async () => {
    const result = await runNautiloTransientProtectedModelDispatch({
      checkpointState: checkpointState("openai:gpt-5.6-luna"),
      configuration: protectedConfiguration,
    });

    expect(result.model).toBe(MODEL_ID);
    expect(capturedRequests).toHaveLength(1);
    const request = capturedRequests[0]!;
    expect(request).toMatchObject({ model: "claude-sonnet-4-6" });
    expect(request.messages).toEqual([
      {
        role: "user",
        content: "D526 hermetic cache wire probe",
      },
    ]);
    expect(request.system).toBeArray();
    const system = request.system as Array<Record<string, unknown>>;
    expect(system[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" },
    });
    expect(typeof system[0]?.["text"]).toBe("string");
    expect((system[0]?.["text"] as string).length).toBeGreaterThan(0);
  });

  test("positive control: Sonnet-prepared state reaches the wire with its stable cache breakpoint", async () => {
    const result = await runNautiloTransientProtectedModelDispatch({
      checkpointState: checkpointState(MODEL_ID),
      configuration: protectedConfiguration,
    });

    expect(result.model).toBe(MODEL_ID);
    expect(capturedRequests).toHaveLength(1);
    const request = capturedRequests[0]!;
    expect(request).toMatchObject({ model: "claude-sonnet-4-6" });
    expect(request.system).toBeArray();
    const system = request.system as Array<Record<string, unknown>>;
    expect(system[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" },
    });
    expect(typeof system[0]?.["text"]).toBe("string");
    expect((system[0]?.["text"] as string).length).toBeGreaterThan(0);
  });
});
