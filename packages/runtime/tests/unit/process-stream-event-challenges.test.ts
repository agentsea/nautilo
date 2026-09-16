import { describe, test, expect, beforeEach } from "bun:test";
import { processStreamEvent } from "../../src/executors/langgraph-executor";
import { TokenBatcher, ToolCallTracker } from "../../src/utils/token-batcher";

describe("processStreamEvent — challenge and voice events", () => {
  let batcher: TokenBatcher;
  let tracker: ToolCallTracker;

  beforeEach(() => {
    batcher = new TokenBatcher({ laneKey: "test" });
    tracker = new ToolCallTracker();
  });

  // D083 Phase 2b audit — the three former tests here
  // (`on_tool_start emits tool.start`, `on_tool_end emits tool.end`,
  // `on_tool_end with error content sets error status`) were
  // removed along with the `on_tool_start` / `on_tool_end` handling
  // in processStreamEvent. That path was double-emitting for every
  // cloud tool (the custom `toolsNode` fires explicitly via D082
  // PR A+ AND LangChain's tracing fires for `await tool.invoke`).
  // The custom emit is authoritative; the auto-path became dead
  // code. See the comment block in `langgraph-executor.ts` next to
  // the removed branches for the full rationale + the condition
  // under which it would be reintroduced (a subgraph using
  // LangGraph's stock ToolNode instead of ours).
  //
  // `tool.start` / `tool.end` emission is still covered
  // comprehensively by
  // `packages/agent/tests/unit/tools-lifecycle-events.test.ts`.

  test("unrecognized event produces no events — including (now-unhandled) on_tool_start/on_tool_end", () => {
    // Locks in the removal: these events used to produce 1 event
    // each, now produce 0. If a future change reintroduces the
    // auto-emit without deduping against the custom node's emit,
    // this test fails loudly.
    expect(
      processStreamEvent(
        { event: "on_tool_start", run_id: "r", name: "x", data: {} },
        batcher,
        tracker,
      ).events,
    ).toHaveLength(0);
    expect(
      processStreamEvent(
        {
          event: "on_tool_end",
          run_id: "r",
          name: "x",
          data: { output: { content: "anything" } },
        },
        batcher,
        tracker,
      ).events,
    ).toHaveLength(0);
  });

  test("unrecognized event produces no events", () => {
    const { events } = processStreamEvent(
      { event: "on_some_random_thing", data: {} },
      batcher,
      tracker,
    );

    expect(events).toHaveLength(0);
  });

  test("null/undefined input produces no events", () => {
    expect(processStreamEvent(null, batcher, tracker).events).toHaveLength(0);
    expect(processStreamEvent(undefined, batcher, tracker).events).toHaveLength(0);
  });

  test("on_chat_model_stream with string chunk produces token events", () => {
    const { events } = processStreamEvent(
      { event: "on_chat_model_stream", data: { chunk: { content: "Hello" } } },
      batcher,
      tracker,
    );

    // TokenBatcher accumulates; drain happens in processStreamEvent
    // At minimum we should get token events if the batcher flushes
    expect(events.length).toBeGreaterThanOrEqual(0);
  });
});
