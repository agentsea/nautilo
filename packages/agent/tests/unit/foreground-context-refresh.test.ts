import { describe, expect, test } from "bun:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  acceptedForegroundMessages,
  foregroundContextNarrativeAllowanceCharacters,
  foregroundContextProjectionFingerprint,
  streamForegroundGraph,
  type ForegroundGraph,
} from "../../src/graph/foreground-context-refresh";
import type { NautiloState } from "../../src/agent/state";

function state(values: Partial<NautiloState>): NautiloState {
  return {
    messages: [],
    foregroundContextRefreshEligible: true,
    ...values,
  } as NautiloState;
}

function readyState(): NautiloState {
  return state({
    foregroundContextRefresh: {
      kind: "foreground_context_refresh",
      reason: "context_pressure",
      status: "ready",
      modelId: "test:model",
      maximumContextCharacters: 4000,
      projectionFingerprint: "old-projection",
    },
  });
}

describe("streamForegroundGraph", () => {
  test("streams, rebuilds after the settled segment, and reinvokes with an explicit reset", async () => {
    const inputs: unknown[] = [];
    const configs: Record<string, unknown>[] = [];
    const states = [readyState(), state({ foregroundContextRefresh: null })];
    let segment = 0;
    const graph: ForegroundGraph = {
      async *streamEvents(input, config = {}) {
        inputs.push(input);
        configs.push(config);
        segment += 1;
        yield { event: "on_chain_end", name: "pre_model", segment };
      },
      async getState() {
        return { values: states[segment - 1] as unknown as Record<string, unknown> };
      },
      async updateState() {
        throw new Error("stream helper must reinvoke through graph input");
      },
    };

    const streamed: unknown[] = [];
    const iterator = streamForegroundGraph(
      graph,
      { messages: [new HumanMessage("original")] },
      { recursionLimit: 20, configurable: { thread_id: "thread" } },
      {
        rebuildForegroundContext: async ({ request }) => {
          expect(request.projectionFingerprint).toBe("old-projection");
          return [new HumanMessage("bounded replacement")];
        },
      },
    );
    let outcome: Awaited<ReturnType<typeof iterator.next>>["value"] = undefined;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        outcome = next.value;
        break;
      }
      streamed.push(next.value);
    }

    expect(streamed).toHaveLength(2);
    expect(outcome).toEqual({ kind: "terminal", state: states[1], refreshCount: 1 });
    expect(configs.map((entry) => entry["recursionLimit"])).toEqual([20, 19]);
    expect(inputs[1]).toMatchObject({
      messages: [expect.any(HumanMessage)],
      preparedMessages: [],
      approvedToolCalls: [],
      pendingApproval: [],
      computerUseInvocationBindings: {},
      fullMacInvocationBindings: {},
      delegatedLocalExecutionBindings: {},
      githubInvocationBindings: {},
      humanTerminalInvocationBindings: {},
      foregroundContextRefresh: null,
    });
    expect((inputs[1] as Partial<NautiloState>).foregroundContextRefreshLastProjection)
      .toBe(foregroundContextProjectionFingerprint(
        [new HumanMessage("bounded replacement")],
        "test:model",
        4000,
      ));
    expect(inputs[1]).not.toHaveProperty("turnId");
  });

  test("atomically carries a rebuilt source boundary with replacement messages", async () => {
    const inputs: unknown[] = [];
    const states = [readyState(), state({ foregroundContextRefresh: null })];
    let segment = 0;
    const graph: ForegroundGraph = {
      async *streamEvents(input) {
        inputs.push(input);
        segment += 1;
        yield { event: "segment" };
      },
      async getState() {
        return { values: states[segment - 1] as unknown as Record<string, unknown> };
      },
      async updateState() {},
    };
    for await (const _event of streamForegroundGraph(graph, {}, {}, {
      rebuildForegroundContext: async () => ({
        messages: [new HumanMessage("bounded replacement")],
        source: {
          acceptedMessages: [new HumanMessage("accepted")],
          triggerMessageId: 10,
          throughMessageIdInclusive: 14,
        },
      }),
    })) {
      // drain
    }
    expect(inputs[1]).toMatchObject({
      foregroundContextRefreshSource: {
        triggerMessageId: 10,
        throughMessageIdInclusive: 14,
      },
    });
  });

  test("a graph without a rebuild callback retains single-segment behavior", async () => {
    let streams = 0;
    const graph: ForegroundGraph = {
      async *streamEvents() {
        streams += 1;
        yield { event: "segment" };
      },
      async getState() {
        throw new Error("legacy stream must not read checkpoint state");
      },
      async updateState() {},
    };
    for await (const _event of streamForegroundGraph(graph, {}, {})) {
      // drain
    }
    expect(streams).toBe(1);
  });

  test("rebuild failure is propagated without replaying the graph", async () => {
    let streams = 0;
    const graph: ForegroundGraph = {
      async *streamEvents() {
        streams += 1;
        yield { event: "segment" };
      },
      async getState() {
        return { values: readyState() as unknown as Record<string, unknown> };
      },
      async updateState() {},
    };
    const run = async () => {
      for await (const _event of streamForegroundGraph(graph, {}, {}, {
        rebuildForegroundContext: async () => {
          throw new Error("fresh authorized read failed");
        },
      })) {
        // drain
      }
    };
    expect(run()).rejects.toThrow("fresh authorized read failed");
    expect(streams).toBe(1);
  });

  test.each(["consumer", "getState", "rebuild"] as const)(
    "an abort during %s work prevents another segment",
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error(`abort during ${stage}`);
      let streams = 0;
      let stateReads = 0;
      let rebuilds = 0;
      const graph: ForegroundGraph = {
        async *streamEvents() {
          streams += 1;
          yield { event: "segment" };
        },
        async getState() {
          stateReads += 1;
          if (stage === "getState") controller.abort(reason);
          return { values: readyState() as unknown as Record<string, unknown> };
        },
        async updateState() {},
      };
      const iterator = streamForegroundGraph(graph, {}, {
        signal: controller.signal,
      }, {
        rebuildForegroundContext: async () => {
          rebuilds += 1;
          if (stage === "rebuild") controller.abort(reason);
          return [new HumanMessage("bounded")];
        },
      });
      expect((await iterator.next()).done).toBe(false);
      if (stage === "consumer") controller.abort(reason);
      const drain = async () => {
        while (!(await iterator.next()).done) {
          // drain
        }
      };
      expect(drain()).rejects.toBe(reason);
      expect(streams).toBe(1);
      expect(stateReads).toBe(stage === "consumer" ? 0 : 1);
      expect(rebuilds).toBe(stage === "rebuild" ? 1 : 0);
    },
  );

  test("uses the same abort signal for every segment and rebuild", async () => {
    const controller = new AbortController();
    const configs: Record<string, unknown>[] = [];
    const transitionSignals: Array<AbortSignal | undefined> = [];
    const states = [readyState(), state({ foregroundContextRefresh: null })];
    let segment = 0;
    const graph: ForegroundGraph = {
      async *streamEvents(_input, config = {}) {
        configs.push(config);
        segment += 1;
        yield { event: "segment" };
      },
      async getState() {
        return { values: states[segment - 1] as unknown as Record<string, unknown> };
      },
      async updateState() {},
    };
    for await (const _event of streamForegroundGraph(graph, {}, {
      signal: controller.signal,
      recursionLimit: 20,
    }, {
      rebuildForegroundContext: async ({ signal }) => {
        transitionSignals.push(signal);
        return [new HumanMessage("bounded")];
      },
    })) {
      // drain
    }
    expect(configs.map((config) => config["signal"]))
      .toEqual([controller.signal, controller.signal]);
    expect(transitionSignals).toEqual([controller.signal]);
  });

  test("aggregates recursion use across refresh segments before reinvoking", async () => {
    let streams = 0;
    let rebuilds = 0;
    const graph: ForegroundGraph = {
      async *streamEvents() {
        streams += 1;
        yield { event: "on_chain_end", name: "pre_model" };
      },
      async getState() {
        return { values: readyState() as unknown as Record<string, unknown> };
      },
      async updateState() {},
    };
    const run = async () => {
      for await (const _event of streamForegroundGraph(graph, {}, {
        recursionLimit: 2,
      }, {
        rebuildForegroundContext: async () => {
          rebuilds += 1;
          return [new HumanMessage(`bounded ${rebuilds}`)];
        },
      })) {
        // drain
      }
    };
    expect(run()).rejects.toMatchObject({
      name: "GraphRecursionError",
      lc_error_code: "GRAPH_RECURSION_LIMIT",
    });
    expect(streams).toBe(2);
    expect(rebuilds).toBe(1);
  });
});

test("projection fingerprints distinguish equal-sized changed content", () => {
  const before = foregroundContextProjectionFingerprint(
    [new HumanMessage({ id: "request", content: "alpha" })],
    "test:model",
    4000,
  );
  const after = foregroundContextProjectionFingerprint(
    [new HumanMessage({ id: "request", content: "bravo" })],
    "test:model",
    4000,
  );
  expect(after).not.toBe(before);
});

test("narrative allowance reserves prepared instructions and accepted requests", () => {
  const system = new SystemMessage("immutable instructions ".repeat(80));
  const accepted = new HumanMessage({ id: "accepted", content: "current request ".repeat(40) });
  const allowance = foregroundContextNarrativeAllowanceCharacters(
    1000,
    [system, accepted],
    [accepted, accepted],
  );
  expect(allowance).toBeLessThan(4000);
  expect(foregroundContextNarrativeAllowanceCharacters(
    1,
    [system],
    [accepted],
  )).toBe(0);
});

test("accepted requests deduplicate projected originals but preserve repeated identical replies", () => {
  const original = new HumanMessage("start");
  const firstYes = new HumanMessage("yes");
  const secondYes = new HumanMessage("yes");
  const transient = new HumanMessage({
    content: "runtime context",
    additional_kwargs: { nautilo_transient_context: true },
  });
  expect(acceptedForegroundMessages(
    [original, firstYes],
    [original, firstYes, secondYes, transient],
  )).toEqual([original, firstYes, secondYes]);
});
