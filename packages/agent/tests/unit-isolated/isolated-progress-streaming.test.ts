/** Real invocation, LangChain and OpenRouter serializer; synthetic HTTP and accounting only. */
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { HumanMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { configureRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { ModelAttemptSupervisor, resolveModelAttemptPolicy } from "../../src/utils/model-attempt-policy";
import { modelResponseReachedOutputLimit } from "../../src/graph/model-output-limit";
import type { ForegroundChatFundingSession } from "../../src/runtime/foreground-chat-funding";
import { setAgentEventSink } from "../../src/runtime-hooks";

const modelId = "openrouter:moonshotai/kimi-k3";
const privateReasoning = "SYNTHETIC_PRIVATE_REASONING";
const receipts: LLMResult[] = [];
const realtime: unknown[] = [];
const actualDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({ ...actualDb,
  getCachedServerModelConfigRow: () => null,
  kickServerModelConfigRefresh: () => {},
  refreshServerModelConfigCache: async () => null,
}));
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({ ...actualTrust,
  assertCanUseServerProviderCredentials: async () => {},
}));
mock.module("../../src/utils/resolve-fallback-policy", () => ({
  resolveFallbackPolicy: async () => ({ enabled: false, chain: [] }),
}));
const actualHealth = await import("../../src/utils/model-health");
mock.module("../../src/utils/model-health", () => ({ ...actualHealth,
  isModelHealthy: () => true, markModelInvokeFailure: () => {},
}));
const actualSurplus = await import("../../src/providers/surplus-attempt");
mock.module("../../src/providers/surplus-attempt", () => ({ ...actualSurplus,
  canUseQualifiedSurplusChatRoute: () => false,
}));
const actualUsage = await import("../../src/usage/usage-callback");
mock.module("../../src/usage/usage-callback", () => ({ ...actualUsage,
  createUsageCallbackHandler: () => BaseCallbackHandler.fromMethods({
    handleLLMEnd: output => { receipts.push(output); },
  }),
}));
const { invokeChatModelWithFallback } = await import("../../src/utils/chat-model-invocation");
const priorKey = process.env["OPENROUTER_API_KEY"];
const funding: ForegroundChatFundingSession = {
  kind: "server", workload: "research",
  runAttempt: async (id, use) => {
    expect(id).toBe(modelId);
    return use({ usageFunding: { kind: "server", providerRoute: "openrouter" } });
  },
  recheckAttempt: async () => {},
};

beforeEach(() => {
  process.env["OPENROUTER_API_KEY"] = "synthetic-stream-test-key";
  configureRuntimeModelCatalog({ catalogPointerUrl: null });
  receipts.length = 0;
  realtime.length = 0;
  setAgentEventSink({ emit: event => { realtime.push(event); } });
});
afterEach(() => {
  expect(realtime).toEqual([]);
  resetRuntimeModelCatalog();
  setAgentEventSink(null);
});
afterAll(() => {
  if (priorKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = priorKey;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

async function exercise(
  use: (attempt: {
    advance(ms: number): void;
    progress(): Promise<void>;
    finish(reason: string, tool?: boolean): void;
    ping(): void;
    signal(): AbortSignal | undefined;
    parent: AbortController;
    pending: ReturnType<typeof invokeChatModelWithFallback>;
    requests: Record<string, unknown>[];
    idleMs: number;
  }) => Promise<void>,
) {
  let now = 0;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const timers = new Map<Parameters<typeof clearTimeout>[0], { due: number; callback: () => void }>();
  const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign((callback: () => void, ms = 0) => {
    // Preserve the runtime's real handle type while executing callbacks only
    // through the deterministic clock below. No native timer remains active.
    const id = nativeSetTimeout(() => {}, 0);
    nativeClearTimeout(id);
    timers.set(id, { due: now + ms, callback });
    return id;
  }, nativeSetTimeout));
  const clearTimer = spyOn(globalThis, "clearTimeout").mockImplementation(id => {
    for (const handle of timers.keys()) if (handle === id) timers.delete(handle);
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) {
      timers.delete(id);
      timer.callback();
    }
  };
  let observed = deferred<void>();
  const originalProgress = ModelAttemptSupervisor.prototype.reportMeaningfulProgress;
  const progressSpy = spyOn(ModelAttemptSupervisor.prototype, "reportMeaningfulProgress").mockImplementation(function (this: ModelAttemptSupervisor, id: string) {
    const accepted = originalProgress.call(this, id);
    if (accepted) observed.resolve();
    return accepted;
  });
  const started = deferred<void>();
  const requests: Record<string, unknown>[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let providerSignal: AbortSignal | undefined;
  const encoder = new TextEncoder();
  const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  const chunk = (delta: Record<string, unknown>, reason: string | null = null) => ({
    id: "chatcmpl-synthetic", object: "chat.completion.chunk", created: 1, model: "moonshotai/kimi-k3",
    choices: [{ index: 0, delta, finish_reason: reason }],
  });
  const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (target: string | URL | Request, init?: RequestInit) => {
    const url = typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    if (typeof init?.body !== "string") throw new Error("Expected a serialized provider request");
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    providerSignal = init?.signal ?? undefined;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    providerSignal?.addEventListener("abort", () => {
      try { controller.error(providerSignal?.reason); } catch { /* stream already closed */ }
    }, { once: true });
    started.resolve();
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }, { preconnect: () => {} }));
  const parent = new AbortController();
  const tool = new DynamicStructuredTool({ name: "record_finding", description: "Record a synthetic finding",
    schema: z.object({ finding: z.string() }), func: async () => { throw new Error("No tools execute during model invocation"); } });
  const pending = invokeChatModelWithFallback([new HumanMessage("Synthetic research brief")], [tool], modelId,
    "synthetic-human", "synthetic-agent", null, { signal: parent.signal, callbacks: [] }, {
      fundingSession: funding, fundingHumanUserId: "synthetic-human", isolatedProgress: true,
      confidential: true, reasoningOutput: false, modelFallbackMode: "none", sameModelRetryMode: "none",
    });
  // Attach rejection handling immediately while the controlled stream is open.
  void pending.catch(() => {});
  try {
    await Promise.race([started.promise, pending]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.["stream"]).toBe(true);
    expect(requests[0]?.["stream_options"]).toEqual({ include_usage: true });
    expect(requests[0]?.["tools"]).toEqual(expect.arrayContaining([expect.objectContaining({ type: "function" })]));
    const policy = resolveModelAttemptPolicy(modelId);
    expect([...timers.values()].map(timer => timer.due)).toContain(policy.firstProgressMs);
    await use({
      advance, parent, pending, requests, idleMs: policy.progressIdleMs, signal: () => providerSignal,
      progress: async () => {
        observed = deferred<void>();
        send(chunk({ role: "assistant", reasoning: privateReasoning }));
        await Promise.race([observed.promise, pending]);
      },
      ping: () => controller.enqueue(encoder.encode(": keep-alive\n\n")),
      finish: (reason, withTool = false) => {
        if (withTool) {
          send(chunk({ tool_calls: [{ index: 0, id: "call-synthetic", type: "function", function: { name: "record_finding", arguments: "{\"finding\":" } }] }));
          send(chunk({ tool_calls: [{ index: 0, function: { arguments: "\"complete\"}" } }] }, reason));
        } else send(chunk({ content: "Complete findings" }, reason));
        send({ id: "chatcmpl-synthetic", object: "chat.completion.chunk", created: 1,
          model: "moonshotai/kimi-k3", choices: [], usage: { prompt_tokens: 13, completion_tokens: 17, total_tokens: 30,
            completion_tokens_details: { reasoning_tokens: 11 }, cost: 0.0123 } });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(timers.size).toBe(0);
  } finally {
    parent.abort(new Error("Synthetic test cleanup"));
    await pending.catch(() => {});
    transport.mockRestore(); progressSpy.mockRestore(); setTimer.mockRestore(); clearTimer.mockRestore();
  }
}

for (const reason of ["stop", "length", "tool_calls"] as const) {
  test(`isolated invoke observes private reasoning beyond the original deadline and preserves ${reason} receipt`, async () => {
    await exercise(async attempt => {
      // Each chunk arrives inside the idle allowance, while total duration is longer.
      for (let index = 0; index < 3; index++) {
        attempt.advance(attempt.idleMs / 2);
        await attempt.progress();
        expect(attempt.signal()?.aborted).toBe(false);
      }
      attempt.finish(reason, reason === "tool_calls");
      const result = await attempt.pending;
      expect(result.response.response_metadata["finish_reason"]).toBe(reason);
      expect(modelResponseReachedOutputLimit(result.response)).toBe(reason === "length");
      expect(result.response.usage_metadata).toMatchObject({ input_tokens: 13, output_tokens: 17, total_tokens: 30 });
      expect(result.response.content).not.toContain(privateReasoning);
      if (reason === "tool_calls") expect(result.response.tool_calls).toEqual([
        { id: "call-synthetic", name: "record_finding", args: { finding: "complete" }, type: "tool_call" },
      ]);
      else expect(result.response.content).toBe("Complete findings");
      expect(receipts).toHaveLength(1);
      expect(actualUsage.extractUsageFromLLMResult(receipts[0]!)).toMatchObject({
        inputTokens: 13, outputTokens: 17, totalTokens: 30, reasoningTokens: 11, actualCostUsd: 0.0123,
      });
    });
  });
}

for (const outcome of ["first-progress", "idle", "cancellation"] as const) {
  test(`isolated streaming preserves ${outcome} termination without retry`, async () => {
    await exercise(async attempt => {
      if (outcome !== "first-progress") await attempt.progress();
      attempt.ping();
      if (outcome === "cancellation") {
        const cancelled = new Error("Synthetic owner cancellation");
        attempt.parent.abort(cancelled);
        expect(await attempt.pending.catch((error: unknown) => error)).toBe(cancelled);
      } else {
        attempt.advance(attempt.idleMs);
        expect(await attempt.pending.catch((error: unknown) => error)).toMatchObject({ details: {
          kind: outcome === "idle" ? "progress_idle_timeout" : "first_progress_timeout",
          visibleOutput: false, partialState: outcome === "idle", abortRequested: true,
        } });
      }
      expect(attempt.signal()?.aborted).toBe(true);
    });
  });
}
