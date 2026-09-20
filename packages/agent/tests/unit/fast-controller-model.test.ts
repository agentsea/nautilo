import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ChoiceInput, ChoiceResult } from "../../src/providers/choice";
import type { ChatModel } from "../../src/providers/types";
import { createModelDecider, explicitObjectUnions, type Measurement, type ModelRequest } from "../../scripts/fast-controller/model";
import { runControllerLab } from "../../scripts/fast-controller/lab";
import { parseModelLabArguments } from "../../scripts/fast-controller-model-prover";
import { fixtureCheck, fixtureResume } from "../../scripts/fast-controller-prover";
import { observeOpenRouterFetch, type WireMeasurement } from "../../scripts/fast-controller/transport";

const stateSchema = z.object({ observation: z.object({ id: z.string(), evidenceRefs: z.array(z.string()) }), availableValues: z.array(z.object({ ref: z.string() })),
  currentUI: z.object({ applicationRunning: z.boolean(), dialog: z.boolean(), target: z.string().nullable(), text: z.string().nullable() }),
  unresolved: z.array(z.unknown()) });
const contextSchema = z.object({ state: stateSchema, choices: z.array(z.object({ id: z.string(), description: z.string() })) })
  .transform(({ state, choices }) => ({ ...state, actionChoices: choices.map(({ id, description }) => ({ ref: id, description })) }));

/** Test responder only. Actual paid runs never import this test policy. */
function decision(request: ModelRequest): { choice: string } {
  if (request.role === "router") return { choice: "execute" };
  const data = contextSchema.parse(request.context);
  const description = !data.currentUI.applicationRunning ? "Open Fixture Editor"
    : data.currentUI.dialog ? "Dismiss welcome tip" : "Insert supplied text unchanged into the new document body";
  const choice = data.unresolved.length ? "defer_to_genie"
    : data.availableValues.length === 0 && data.currentUI.applicationRunning
      ? "needs_input"
      : data.actionChoices.find(row => row.description === description)?.ref ?? "rebuild_choices";
  return { choice };
}
const signal = () => new AbortController().signal;
const decide = (request: ModelRequest) => Promise.resolve(decision(request));
function selectorAnswer(input: ChoiceInput, choice: string): ChoiceResult {
  return { selectedId: choice, requestedModelId: input.modelId, resolvedModelId: input.modelId,
    usage: { inputTokens: 10, outputTokens: 1, actualCostUsd: null } };
}
function asModelRequest(input: ChoiceInput): ModelRequest {
  return { role: "controller", instructions: input.instructions, schema: z.unknown(), signal: input.signal,
    context: { state: input.state, choices: input.choices } };
}

describe("model-driven lab with injected offline decisions", () => {
  test("classifier -> fast repair -> classifier preserves receipts and inserts the original value once", async () => {
    const result = await runControllerLab({ scenario: "incomplete_choices", entry: "controller", maxRequests: 5,
      signal: signal(), selectorHandoff: true,
      selector: { modelId: "fixture-choice", maxChoices: 255, choose: input => {
        const raw = asModelRequest(input);
        const selected = decision(raw);
        return Promise.resolve(selectorAnswer(input, selected.choice === "rebuild_choices" ? "defer_to_genie" : selected.choice));
      } },
      decide: request => {
        const data = contextSchema.parse(request.context);
        expect(data.currentUI.applicationRunning).toBe(true);
        expect(data.actionChoices.some(row => row.description === "Open Fixture Editor")).toBe(false);
        return Promise.resolve({ choice: data.actionChoices.some(row => row.description.startsWith("Insert")) ? "return_to_selector" : "rebuild_choices" });
      } });
    expect(result.phase).toBe("complete"); expect(result.requests).toBe(4); expect(result.selectorCalls).toBe(3);
    expect(result.roleTransitions.map(row => [row.from, row.to, row.receipts])).toEqual([
      ["decision", "controller", 1], ["controller", "decision", 1],
    ]);
    expect(result.state.receipts).toHaveLength(2); expect(result.actual.insertions).toBe(1);
    expect(result.actual.text).toBe("A quiet page becomes a field of light.");
  });
  test("fast interpretation cannot erase an unknown effect inherited from the classifier", async () => {
    const result = await runControllerLab({ scenario: "uncertain_hidden", entry: "controller", maxRequests: 4,
      signal: signal(), selectorHandoff: true, decide,
      selector: { modelId: "fixture-choice", maxChoices: 255,
        choose: input => Promise.resolve(selectorAnswer(input, decision(asModelRequest(input)).choice)) } });
    expect(result.phase).toBe("handoff"); expect(result.state.handoff?.reason).toBe("unresolved_effect");
    expect(result.state.unresolved).toHaveLength(1); expect(result.actual.insertions).toBe(1);
    expect(result.roleTransitions).toHaveLength(1); expect(result.roleTransitions[0]?.unresolved).toBe(1);
    expect(result.requests).toBe(4);
  });
  test("one caller budget spans selector and controller, including role switching", async () => {
    const result = await runControllerLab({ scenario: "incomplete_choices", entry: "controller", maxRequests: 2,
      signal: signal(), selectorHandoff: true, decide: () => { throw new Error("budget must prevent controller call"); },
      selector: { modelId: "fixture-choice", maxChoices: 255, choose: input => {
        const selected = decision(asModelRequest(input));
        return Promise.resolve(selectorAnswer(input, selected.choice === "rebuild_choices" ? "defer_to_genie" : selected.choice));
      } } });
    expect(result.requests).toBe(2); expect(result.phase).toBe("handoff");
    expect(result.state.handoff?.reason).toBe("experiment_request_budget");
    expect(result.state.receipts).toHaveLength(1); expect(result.actual.insertions).toBe(0);
  });
  for (const scenario of ["controller", "surprise", "uncertain_readback"] as const) test(`${scenario} completes useful work without scripted runner actions`, async () => {
    const result = await runControllerLab({ scenario, entry: "router", maxRequests: 8, signal: signal(), decide });
    expect(result.phase).toBe("complete");
    expect(result.actual.insertions).toBe(1);
    expect(result.actual.dialog).toBe(false);
    expect(result.guiCalls).toBe(0);
  });
  test("direct route finishes with one selection and no controller call", async () => {
    const result = await runControllerLab({ scenario: "direct", entry: "router", maxRequests: 1, signal: signal(),
      decide: async () => ({ choice: "direct_0" }) });
    expect(result.phase).toBe("complete");
    expect(result.requests).toBe(1);
    expect(result.actual.applicationRunning).toBe(true);
    expect(result.actual.insertions).toBe(0);
  });
  test("wrong direct routing cannot falsely complete a compound request", async () => {
    const result = await runControllerLab({ scenario: "controller", entry: "router", maxRequests: 4, signal: signal(),
      decide: async request => request.role === "router" ? { choice: "direct_0" } : decision(request) });
    expect(result.phase).toBe("complete");
    expect(result.actual.insertions).toBe(1);
    expect(result.state.receipts).toHaveLength(2);
  });
  test("unknown effect stays unknown and hidden text never reaches model context", async () => {
    const result = await runControllerLab({ scenario: "uncertain_hidden", entry: "controller", maxRequests: 4, signal: signal(),
      decide: async request => {
        const data = contextSchema.parse(request.context);
        expect(data.currentUI.text).toBeNull();
        if (data.currentUI.applicationRunning) expect(data.actionChoices.some(row => row.description === "Open Fixture Editor")).toBe(false);
        if (data.unresolved.length) expect(data.actionChoices.some(row => row.description.startsWith("Insert"))).toBe(false);
        expect(request.context).not.toHaveProperty("scenario");
        expect(request.context).not.toHaveProperty("actual");
        return decision(request);
      } });
    expect(result.phase).toBe("handoff");
    expect(result.state.unresolved).toHaveLength(1);
    expect(result.actual.insertions).toBe(1);
  });
  test("typed external supervisor reply resumes without replaying launch", async () => {
    const result = await runControllerLab({ scenario: "handoff_resume", entry: "controller", maxRequests: 6, signal: signal(), decide,
      supervisor: async state => ({ reply: fixtureResume(state), suppliedText: "A quiet page becomes a field of light." }) });
    expect(result.phase).toBe("complete");
    expect(result.supervisorReplies).toBe(1);
    expect(result.state.receipts).toHaveLength(2);
    expect(result.actual.insertions).toBe(1);
  });
  test("an incomplete menu is rebuilt before useful work, not mistaken for impossible work", async () => {
    const result = await runControllerLab({ scenario: "incomplete_choices", entry: "controller", maxRequests: 4, signal: signal(), decide });
    expect(result.phase).toBe("complete"); expect(result.choiceRebuilds).toBe(1);
    expect(result.transitions.map(row => row.decision)).toEqual(["act", "rebuild_choices", "act"]);
    expect(result.actual.insertions).toBe(1);
  });
  test("workflow replan and supervisor return preserve prior launch and original input", async () => {
    let replanned = false;
    const result = await runControllerLab({ scenario: "controller", entry: "controller", maxRequests: 4, signal: signal(),
      decide: async request => {
        const data = contextSchema.parse(request.context);
        if (data.currentUI.applicationRunning && !replanned) { replanned = true; return { choice: "request_replan" }; }
        return decision(request);
      }, supervisor: async state => {
        expect(state.receipts).toHaveLength(1);
        expect(state.handoff?.question).toContain("Reevaluate this workflow");
        return { reply: fixtureResume(state) };
      } });
    expect(result.phase).toBe("complete"); expect(result.supervisorReplies).toBe(1);
    expect(result.state.receipts).toHaveLength(2); expect(result.actual.insertions).toBe(1);
  });
  test("optional Choice selector uses the same loop without a generative controller call", async () => {
    const result = await runControllerLab({ scenario: "surprise", entry: "controller", maxRequests: 4, signal: signal(),
      decide: async () => { throw new Error("must_not_call_big_or_fast_model"); },
      selector: { modelId: "fixture-choice", maxChoices: 255, choose: async input => {
        const selected = z.object({ choice: z.string() }).parse(decision({ role: "controller", instructions: input.instructions,
          schema: z.unknown(), signal: input.signal, context: { state: input.state, choices: input.choices } }));
        return { selectedId: selected.choice, requestedModelId: input.modelId, resolvedModelId: input.modelId,
          usage: { inputTokens: 10, outputTokens: 1, actualCostUsd: null } };
      } } });
    expect(result.phase).toBe("complete"); expect(result.selectorCalls).toBe(3); expect(result.requests).toBe(3);
    expect(result.actual.insertions).toBe(1);
  });
  test("bad operation can be corrected without dispatching it", async () => {
    let first = true;
    const result = await runControllerLab({ scenario: "controller", entry: "controller", maxRequests: 4, signal: signal(),
      decide: async request => {
        if (!first) return decision(request);
        first = false;
        return { bad: "not executable" };
      } });
    expect(result.phase).toBe("complete");
    expect(result.requests).toBe(3);
    expect(result.state.receipts).toHaveLength(2);
  });
  test("controller answers omit harness authority fields and see actual control labels", async () => {
    const seen: unknown[] = [];
    const result = await runControllerLab({ scenario: "surprise", entry: "controller", maxRequests: 4, signal: signal(),
      decide: async request => {
        const schema = z.toJSONSchema(request.schema);
        expect(schema).toHaveProperty("properties.choice");
        expect(schema).not.toHaveProperty("properties.checkpointId");
        expect(schema).not.toHaveProperty("properties.observationId");
        seen.push(request.context);
        return decision(request);
      } });
    expect(result.phase).toBe("complete");
    expect(seen[1]).toHaveProperty("state.currentUI.controls.0.label", "Dismiss welcome tip");
    expect(seen[2]).toHaveProperty("state.currentUI.controls.0.label", "New document body");
  });
  test("exhaustion returns a checkpoint rather than claiming completion", async () => {
    const result = await runControllerLab({ scenario: "controller", entry: "controller", maxRequests: 1, signal: signal(), decide });
    expect(result.phase).toBe("handoff");
    expect(result.state.handoff?.reason).toBe("experiment_request_budget");
    expect(result.actual.applicationRunning).toBe(true);
    expect(result.actual.insertions).toBe(0);
  });
  test("supplied content passes by reference and model-authored replacement cannot execute", async () => {
    let attemptedRewrite = false;
    const result = await runControllerLab({ scenario: "controller", entry: "controller", maxRequests: 4, signal: signal(),
      decide: async request => {
        const data = contextSchema.parse(request.context);
        expect(request.context).not.toHaveProperty("suppliedText");
        if (!data.currentUI.text) expect(JSON.stringify(request.context)).not.toContain("A quiet page becomes a field of light.");
        if (data.currentUI.applicationRunning && !attemptedRewrite) {
          attemptedRewrite = true;
          return { body: { kind: "act", operation: { kind: "insert", target: data.currentUI.target,
            valueRef: "supplied-text", text: "Rewritten by the model" }, verify: [fixtureCheck] } };
        }
        return decision(request);
      } });
    expect(result.phase).toBe("complete");
    expect(result.actual.text).toBe("A quiet page becomes a field of light.");
    expect(result.actual.insertions).toBe(1);
    expect(result.rejected).toHaveLength(1);
  });
  test("action references are checkpoint bound and cannot be replayed after state changes", async () => {
    let oldRef: string | undefined;
    let attemptedReplay = false;
    const result = await runControllerLab({ scenario: "controller", entry: "controller", maxRequests: 4, signal: signal(),
      decide: async request => {
        const data = contextSchema.parse(request.context);
        if (oldRef && !attemptedReplay) {
          attemptedReplay = true;
          return { choice: oldRef };
        }
        oldRef = data.actionChoices[0]!.ref;
        return decision(request);
      } });
    expect(result.phase).toBe("complete");
    expect(result.rejected).toEqual([{ request: 2, code: "unknown_action_reference" }]);
    expect(result.actual.insertions).toBe(1);
    expect(result.state.receipts).toHaveLength(2);
  });
  test("cancellation during inference prevents execution", async () => {
    const abort = new AbortController();
    const result = await runControllerLab({ scenario: "controller", entry: "controller", maxRequests: 4, signal: abort.signal,
      decide: async request => { abort.abort(); return decision(request); } });
    expect(result.phase).toBe("stopped");
    expect(result.state.receipts).toHaveLength(0);
  });
});

describe("existing provider adapter, tested without network", () => {
  const schema = z.object({ answer: z.string() }).strict();
  function fake(invoke: ChatModel["invoke"]): ChatModel {
    return { invoke, bindTools: (tools, options) => {
      expect(tools).toHaveLength(1);
      expect(options?.["parallel_tool_calls"]).toBe(false);
      expect(options?.["tool_choice"]).toBe("auto");
      return { invoke };
    } };
  }
  const request = (tail: unknown): ModelRequest => ({ role: "controller", instructions: "Stable instructions", context: tail, schema, signal: signal() });
  test("provider response -> strict parser -> controller -> executor -> independent goal proof", async () => {
    let malformedFirst = true;
    const measurements: Measurement[] = [];
    const model = fake(async messages => {
      if (malformedFirst) { malformedFirst = false; return { tool_calls: [] }; }
      const message = messages[1] as { content: unknown };
      if (typeof message.content !== "string") throw new Error("Expected JSON context");
      const context: unknown = JSON.parse(message.content);
      const args = decision({ ...request(context), context });
      return { tool_calls: [{ name: "submit_decision", args }] };
    });
    const report = await runControllerLab({ scenario: "surprise", entry: "controller", maxRequests: 6,
      signal: signal(), decide: createModelDecider(model, measurements) });
    expect(report.phase).toBe("complete");
    expect(report.actual.insertions).toBe(1);
    expect(measurements.map(row => row.outcome)).toEqual(["invalid", "valid", "valid", "valid"]);
    expect(report.state.receipts).toHaveLength(3);
    expect(new Set(measurements.map(row => row.prefixHash)).size).toBe(1);
  });
  test("real adapter parsing path produces a structured result and measured cache facts", async () => {
    const measurements: Measurement[] = [];
    const model = fake(async () => ({ tool_calls: [{ name: "submit_decision", args: { answer: "yes" } }],
      usage_metadata: { input_tokens: 101, output_tokens: 7, input_token_details: { cache_read: 80 } },
      response_metadata: { usage: { cost: 0.001 } } }));
    const call = createModelDecider(model, measurements);
    expect(await call(request({ observation: 1 }))).toEqual({ answer: "yes" });
    await call(request({ observation: 2 }));
    expect(measurements[0]!.prefixHash).toBe(measurements[1]!.prefixHash);
    expect(measurements[0]).toMatchObject({ inputTokens: 101, outputTokens: 7, cacheReadTokens: 80,
      cacheWriteTokens: null, actualCostUsd: 0.001, outcome: "valid" });
  });
  for (const response of [{ tool_calls: [] }, { tool_calls: [{ name: "shell", args: {} }] },
    { tool_calls: [{ name: "submit_decision", args: { answer: "yes", extra: true } }] },
    { tool_calls: [{ name: "submit_decision", args: { answer: "yes" } }, { name: "submit_decision", args: { answer: "yes" } }] }]) {
    test("invalid model output never becomes an executable proposal", async () => {
      const measurements: Measurement[] = [];
      expect(await createModelDecider(fake(async () => response), measurements)(request({})).catch((error: Error) => error.message)).toBe("invalid_model_decision");
      expect(measurements[0]!.outcome).toBe("invalid");
      expect(measurements[0]!.cacheReadTokens).toBeNull();
    });
  }
  test("provider errors are sanitized, late cancelled responses retain usage", async () => {
    const measurements: Measurement[] = [];
    expect(await createModelDecider(fake(async () => { throw new Error("sensitive provider body"); }), measurements)(request({})).catch((error: Error) => error.message)).toBe("provider_error");
    expect(JSON.stringify(measurements)).not.toContain("sensitive");
    const abort = new AbortController();
    const call = createModelDecider(fake(async () => { abort.abort(); return { usage_metadata: { input_tokens: 17 } }; }), measurements);
    expect(await call({ ...request({}), signal: abort.signal }).catch((error: Error) => error.message)).toBe("cancelled");
    expect(measurements[1]).toMatchObject({ outcome: "cancelled", inputTokens: 17 });
  });
  test("missing bindTools refuses without invocation", () => {
    expect(() => createModelDecider({ invoke: async () => { throw new Error("must not run"); } }, [])).toThrow("structured_tool_output_unavailable");
  });
});

test("CLI has no accidental paid default or credential argument", () => {
  expect(parseModelLabArguments(["--list"]).kind).toBe("list");
  expect(parseModelLabArguments(["--help"]).kind).toBe("help");
  for (const args of [[], ["--live"], ["--api-key", "not-accepted"], ["--list", "--live"]]) {
    expect(() => parseModelLabArguments(args)).toThrow();
  }
  const args = ["--live", "--model", "catalog:model", "--case", "direct", "--entry", "router",
    "--max-requests", "4", "--max-output-tokens", "512", "--duration-ms", "120000"];
  expect(parseModelLabArguments(args).kind).toBe("live");
  expect(parseModelLabArguments([...args, "--controller-model", "catalog:controller"])).toHaveProperty("controllerModelId", "catalog:controller");
  expect(parseModelLabArguments([...args, "--reasoning", "off"])).toHaveProperty("reasoning", "off");
  expect(() => parseModelLabArguments([...args, "--reasoning", "made-up"])).toThrow();
  expect(() => parseModelLabArguments([...args.slice(0, -1), "2147483648"])).toThrow();
});

test("wire observer retains the response but records only usage and retry attempts", async () => {
  const rows: WireMeasurement[] = [];
  const fake = (async () => Response.json({ usage: { cost: 0.002, prompt_tokens: 40, completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 7 } }, id: "private-request", user_id: "private-account", choices: [{ text: "synthetic content", finish_reason: "length" }] })) as unknown as typeof fetch;
  const observed = observeOpenRouterFetch(fake, rows, () => "controller");
  const response = await observed("https://openrouter.ai/api/v1/chat/completions");
  expect(z.object({ id: z.string() }).parse(await response.json()).id).toBe("private-request");
  await observed("https://openrouter.ai/api/v1/chat/completions");
  await observed("https://example.org/unrelated");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ role: "controller", status: 200, costUsd: 0.002, inputTokens: 40, outputTokens: 10, cacheReadTokens: 30,
    reasoningTokens: 7, finishReason: "length" });
  expect(JSON.stringify(rows)).not.toContain("private");
  expect(JSON.stringify(rows)).not.toContain("content");
});

test("object union annotation preserves branches and nullable semantics", () => {
  const union = { oneOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "number" } } }] };
  expect(explicitObjectUnions(union)).toEqual({ ...union, type: "object" });
  expect(union).not.toHaveProperty("type");
  const nullable = { anyOf: [{ type: "object" }, { type: "null" }] };
  expect(explicitObjectUnions(nullable)).toEqual(nullable);
});
