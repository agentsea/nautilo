import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { OpenRouterReasoningCompletions } from "../../src/providers/openrouter-reasoning";
import { createOpenAI } from "../../src/providers/factory";
import { ProviderTimeoutError } from "../../src/providers/errors";
import { ModelAttemptSupervisor, classifyModelStreamProgress, type ResolvedModelAttemptPolicy } from "../../src/utils/model-attempt-policy";
import { bindModelAttemptProgressSinkByKey, recordStreamActivityFromEvent, _resetAgentTurnContextsForTests } from "../../src/runtime/turn-context";
import { scopeSubagentVisibleToken } from "../../src/subagents/scope-subagent/token-stream";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";

beforeAll(async () => { await activateModelCatalogForTests(["openrouter:z-ai/glm-5.1"]); });
afterAll(() => resetRuntimeModelCatalog());

class InspectableCompletions extends OpenRouterReasoningCompletions {
  convert(delta: Record<string, unknown>) {
    return this._convertCompletionsDeltaToBaseMessageChunk(delta, {
      id: "synthetic", object: "chat.completion.chunk", created: 0, model: "synthetic",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    }, "assistant");
  }
}
const adapter = new InspectableCompletions({ model: "synthetic", apiKey: "unused-test-key" });
const event = (delta: Record<string, unknown>, attemptId = "reasoning-attempt") => ({
  event: "on_chat_model_stream", metadata: { model_attempt_id: attemptId }, data: { chunk: adapter.convert(delta) },
});
afterEach(() => _resetAgentTurnContextsForTests());

test("the OpenRouter factory installs the reasoning-aware completions adapter", async () => {
  const model = await createOpenAI({ modelId: "openrouter:z-ai/glm-5.1", apiKey: "unused-test-key", maxTokens: 128 });
  expect((model as unknown as { completions: unknown }).completions).toBeInstanceOf(OpenRouterReasoningCompletions);
});

test("actual LangChain chunks retain provider reasoning as nonvisible semantic progress", () => {
  for (const delta of [
    { reasoning_content: "synthetic reasoning token" },
    { reasoning: "synthetic reasoning token" },
    { reasoning_details: [{ type: "reasoning.text", text: "synthetic reasoning token", index: 0 }] },
    { reasoning_details: [{ type: "reasoning.summary", summary: "synthetic summary", index: 0 }] },
    { reasoning_details: [{ type: "reasoning.encrypted", data: "synthetic opaque bytes", index: 0 }] },
  ]) {
    const chunkEvent = event(delta);
    expect(classifyModelStreamProgress(chunkEvent).meaningful).toBe(true);
    expect(scopeSubagentVisibleToken(chunkEvent)).toBe("");
    expect(Object.keys(chunkEvent.data.chunk.additional_kwargs).length).toBeGreaterThan(0);
    expect(chunkEvent.data.chunk.additional_kwargs["__raw_response"]).toBeUndefined();
  }
  for (const delta of [{}, { reasoning: "" }, { reasoning_content: "" },
    { reasoning_details: [{ type: "reasoning.text", id: "metadata-only", index: 0 }] },
    { reasoning_details: [{ type: "reasoning.encrypted", data: "[REDACTED]" }] }]) {
    expect(classifyModelStreamProgress(event(delta)).meaningful).toBe(false);
  }
});

async function virtualTime(run: (advance: (ms: number) => void, now: () => number) => Promise<void>) {
  let clock = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fire: () => void }>();
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    timers.set(++id, { at: clock + ms, fire: callback });
    return id;
  }) as unknown as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((timerId: number) => {
    timers.delete(timerId);
  }) as unknown as typeof clearTimeout);
  try {
    await run((ms) => {
      const end = clock + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock = next[1].at;
        timers.delete(next[0]);
        next[1].fire();
      }
      clock = end;
    }, () => clock);
  } finally { set.mockRestore(); clear.mockRestore(); }
}

const policy: ResolvedModelAttemptPolicy = { attemptId: "reasoning-attempt", modelId: "openrouter:z-ai/glm-5.3",
  firstProgressMs: 180_000, progressIdleMs: 180_000,
  provenance: { firstProgress: { kind: "temporary_legacy", id: "D264/D331", version: "2026-08" },
    progressIdle: { kind: "temporary_legacy", id: "D264/D331", version: "2026-08" } } };

test("reasoning survives the original 180s deadline, empty metadata cannot extend idle, and stale attempts cannot keep it alive", async () => {
  await virtualTime(async (advance, now) => {
    const supervisor = new ModelAttemptSupervisor(policy, { now, onTimeout: (outcome) => new ProviderTimeoutError(policy.modelId, policy.progressIdleMs, {
      kind: outcome.timeoutKind, attemptId: policy.attemptId, policyProvenance: {}, elapsedMs: outcome.elapsedMs,
      visibleOutput: outcome.visibleOutput, partialState: outcome.partialState, abortRequested: outcome.abortRequested,
      safeToFallback: outcome.safeToFallback,
    }) });
    bindModelAttemptProgressSinkByKey("synthetic-reasoning-key", supervisor);
    const pending = supervisor.race(new Promise<never>(() => {})).catch((error: unknown) => error);
    for (let i = 0; i < 6; i++) {
      advance(120_000);
      expect(supervisor.signal.aborted).toBe(false);
      expect(recordStreamActivityFromEvent(event({ reasoning_details: [{ type: "reasoning.text", text: "synthetic delta" }] }), "synthetic-reasoning-key")).toBe(true);
    }
    expect(now()).toBe(720_000);
    advance(179_999);
    expect(recordStreamActivityFromEvent(event({ reasoning: "" }), "synthetic-reasoning-key")).toBe(false);
    expect(recordStreamActivityFromEvent(event({ reasoning: "late delta" }, "old-attempt"), "synthetic-reasoning-key")).toBe(false);
    advance(1);
    expect(await pending).toMatchObject({ details: { kind: "progress_idle_timeout", elapsedMs: 900_000, partialState: true } });
    expect(supervisor.signal.aborted).toBe(true);
  });
});

test("parent cancellation still stops an attempt receiving reasoning", async () => {
  await virtualTime(async (advance, now) => {
    const parent = new AbortController();
    const supervisor = new ModelAttemptSupervisor(policy, { now, parentSignal: parent.signal, onTimeout: () => new Error("unexpected timeout") });
    bindModelAttemptProgressSinkByKey("synthetic-cancel-key", supervisor);
    const pending = supervisor.race(new Promise<never>(() => {})).catch((error: unknown) => error);
    advance(120_000);
    recordStreamActivityFromEvent(event({ reasoning_content: "synthetic delta" }), "synthetic-cancel-key");
    const cancelled = new Error("User cancelled");
    parent.abort(cancelled);
    expect(await pending).toBe(cancelled);
    expect(supervisor.signal.aborted).toBe(true);
  });
});
