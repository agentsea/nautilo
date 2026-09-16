/**
 * Unit tests for D084 — chained-interrupt scan in resume paths.
 *
 * Why these tests exist — the 2026-04-21 continuous-execution test
 * proved that resuming a graph from an `approval_ask` interrupt, when
 * the very next step raises ANOTHER `approval_ask`, silently stalls
 * because the resume function never scans post-stream state for new
 * interrupts. `langgraph-executor.ts` does scan (first-turn path) but
 * `resume-approval-ask.ts` and `resume-approval.ts` did not (resume
 * path). The fix ports that scan into a shared helper
 * (`emitChainedInterrupts`) and wires both resume functions to call
 * it before flushing.
 *
 * These tests guard the D084 invariant:
 *   - `collectPendingInterruptEvents` translates each interrupt in
 *     each task into a ServerEvent (pure function).
 *   - `emitChainedInterrupts` scans `graph.getState()`, calls the
 *     processor's `emit()` for every resulting ServerEvent, and
 *     degrades gracefully when `emit` is undefined (warns, no
 *     throw).
 *   - Specific interrupt-type fan-out: approval_ask → approval.ask,
 *     prove_it_challenge → prove_it.challenge, identity_challenge
 *     → identity.challenge. Covers every D061 + M036 + identity
 *     flow.
 *
 * A future refactor that removes the post-stream scan or the `emit`
 * method MUST fail these tests — otherwise the multi-step graduated
 * approval flow silently regresses and every continuous task stalls
 * on step 2.
 */

import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import {
  collectPendingInterruptEvents,
  interruptValueToServerEvent,
} from "../../src/graph/interrupt-mapping";
import {
  emitChainedInterrupts,
  type GraphLikeForInterruptScan,
  type StreamEventProcessor,
} from "../../src/graph/resume-approval";

// ---------------------------------------------------------------------------
// `collectPendingInterruptEvents` — pure function scanning a graph
// getState() payload for interrupts.
// ---------------------------------------------------------------------------

describe("collectPendingInterruptEvents — D084 helper", () => {
  test("empty / missing state → empty array", () => {
    expect(collectPendingInterruptEvents(undefined, "t1", "l1")).toEqual([]);
    expect(collectPendingInterruptEvents({}, "t1", "l1")).toEqual([]);
    expect(collectPendingInterruptEvents({ tasks: [] }, "t1", "l1")).toEqual([]);
  });

  test("tasks with no interrupts → empty array", () => {
    const state = { tasks: [{ name: "agent", interrupts: undefined }] };
    expect(collectPendingInterruptEvents(state, "t1", "l1")).toEqual([]);
  });

  test("single chained approval_ask → one approval.ask event", () => {
    const state = {
      tasks: [
        {
          name: "post_model",
          interrupts: [
            {
              value: {
                type: "approval_ask",
                tools: [{ name: "run_shell", args: { command: "ls" } }],
                reason: "destructive",
                reasonCode: "destructive-tool",
                allowedVerbs: ["once", "room", "always", "deny"],
              },
            },
          ],
        },
      ],
    };

    const events = collectPendingInterruptEvents(state, "thread-x", "lane-x");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("approval.ask");
    expect((events[0] as ServerEvent & { threadId: string }).threadId).toBe(
      "thread-x",
    );
    expect((events[0] as ServerEvent & { laneKey: string }).laneKey).toBe(
      "lane-x",
    );
  });

  test("chained prove_it_challenge → one prove_it.challenge event", () => {
    const state = {
      tasks: [
        {
          interrupts: [
            {
              value: {
                type: "prove_it_challenge",
                tools: [{ name: "run_shell", args: {}, id: "tc_1" }],
              },
            },
          ],
        },
      ],
    };

    const events = collectPendingInterruptEvents(state, "t", "l");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("prove_it.challenge");
  });

  test("same-turn prove_it challenges carry their exact LangGraph interrupt ids", () => {
    const state = {
      tasks: [{
        interrupts: [
          {
            id: "11111111111111111111111111111111",
            value: { type: "prove_it_challenge", tools: [{ name: "first", args: {} }] },
          },
          {
            id: "22222222222222222222222222222222",
            value: { type: "prove_it_challenge", tools: [{ name: "second", args: {} }] },
          },
        ],
      }],
    };

    const events = collectPendingInterruptEvents(state, "t", "l");
    expect(events).toMatchObject([
      { type: "prove_it.challenge", challengeId: "11111111111111111111111111111111" },
      { type: "prove_it.challenge", challengeId: "22222222222222222222222222222222" },
    ]);
  });

  test("legacy prove_it interrupt without an id preserves the legacy event shape", () => {
    const events = collectPendingInterruptEvents({
      tasks: [{ interrupts: [{
        value: { type: "prove_it_challenge", tools: [] },
      }] }],
    }, "t", "l");

    expect(events).toEqual([{ type: "prove_it.challenge", threadId: "t", laneKey: "l", tools: [] }]);
    expect("challengeId" in events[0]!).toBe(false);
  });

  test("recovers a legacy projection preview expiry from its exact checkpoint snapshot", () => {
    const events = collectPendingInterruptEvents({
      values: {
        projectionSnapshots: [{
          kind: "protected",
          toolCallId: "share-1",
          reference: { expiresAt: 1_800_000_000_000 },
        }],
      },
      tasks: [{ interrupts: [{
        value: {
          type: "approval_ask",
          approvalId: "approval-1",
          tools: [{
            id: "share-1",
            name: "share_memory",
            args: { mode: "project" },
            shareMemoryPreview: {
              projection: { mode: "project", content: "safe", roomLabel: "Room" },
            },
          }],
        },
      }] }],
    }, "t", "l");

    expect((events[0] as { tools: Array<{ shareMemoryPreview?: { projection?: { expiresAt?: number } } }> })
      .tools[0]?.shareMemoryPreview?.projection?.expiresAt).toBe(1_800_000_000_000);
  });

  test("does not copy an unrelated snapshot expiry or overwrite a current preview", () => {
    const events = collectPendingInterruptEvents({
      values: {
        projectionSnapshots: [{ toolCallId: "other-share", expiresAt: 1_900_000_000_000 }],
      },
      tasks: [{ interrupts: [{
        value: {
          type: "prove_it_challenge",
          tools: [
            {
              id: "share-missing",
              name: "share_memory",
              args: {},
              shareMemoryPreview: { projection: { mode: "project" } },
            },
            {
              id: "share-current",
              name: "share_memory",
              args: {},
              shareMemoryPreview: { projection: { mode: "project", expiresAt: 1234 } },
            },
          ],
        },
      }] }],
    }, "t", "l");
    const tools = (events[0] as {
      tools: Array<{ shareMemoryPreview?: { projection?: { expiresAt?: number } } }>;
    }).tools;

    expect(tools[0]?.shareMemoryPreview?.projection?.expiresAt).toBeUndefined();
    expect(tools[1]?.shareMemoryPreview?.projection?.expiresAt).toBe(1234);
  });

  test("multiple tasks each with interrupts → all events surfaced, order preserved", () => {
    const state = {
      tasks: [
        {
          interrupts: [
            {
              value: {
                type: "identity_challenge",
                challengeId: "c1",
                expiresAt: "2026-04-21T12:00:00Z",
              },
            },
          ],
        },
        {
          interrupts: [
            {
              value: {
                type: "approval_ask",
                tools: [],
                reason: "",
                allowedVerbs: ["once", "deny"],
              },
            },
          ],
        },
      ],
    };

    const events = collectPendingInterruptEvents(state, "t", "l");
    expect(events.map((e) => e.type)).toEqual([
      "identity.challenge",
      "approval.ask",
    ]);
  });

  test("unknown interrupt type → filtered out (forward-compatible with future interrupt shapes)", () => {
    const state = {
      tasks: [
        {
          interrupts: [
            { value: { type: "totally_new_thing", some: "payload" } },
            {
              value: {
                type: "approval_ask",
                tools: [],
                reason: "",
                allowedVerbs: ["once", "deny"],
              },
            },
          ],
        },
      ],
    };

    const events = collectPendingInterruptEvents(state, "t", "l");
    expect(events.map((e) => e.type)).toEqual(["approval.ask"]);
  });
});

// ---------------------------------------------------------------------------
// `emitChainedInterrupts` — behavior when called after a resume
// stream drains. Mocks the graph's `getState()` to return a synthetic
// state with interrupts.
// ---------------------------------------------------------------------------

/**
 * Build a minimal graph stub that satisfies the part of
 * `emitChainedInterrupts` that actually matters: `.getState({ configurable })`
 * → state with tasks + interrupts. Everything else is type-only.
 */
function makeGraphStub(getStateReturn: unknown): GraphLikeForInterruptScan {
  return {
    getState: () => Promise.resolve(getStateReturn),
  };
}

/**
 * A StreamEventProcessor that captures emitted events + flush calls
 * for assertions.
 */
function makeCapturingProcessor(): StreamEventProcessor & {
  captured: ServerEvent[];
  processCount: number;
  flushCount: number;
} {
  const captured: ServerEvent[] = [];
  let processCount = 0;
  let flushCount = 0;
  return {
    captured,
    get processCount() {
      return processCount;
    },
    get flushCount() {
      return flushCount;
    },
    process() {
      processCount++;
    },
    flush() {
      flushCount++;
    },
    emit(event) {
      captured.push(event);
    },
  };
}

describe("emitChainedInterrupts — D084 resume-path scan", () => {
  test("no chained interrupts → processor.emit is never called", async () => {
    const graph = makeGraphStub({ tasks: [] });
    const processor = makeCapturingProcessor();

    await emitChainedInterrupts(graph, "t-empty", "l-empty", processor, "test");

    expect(processor.captured).toEqual([]);
  });

  test("one chained approval_ask → emits one approval.ask event with the right threadId/laneKey", async () => {
    const graph = makeGraphStub({
      tasks: [
        {
          interrupts: [
            {
              value: {
                type: "approval_ask",
                tools: [{ name: "run_shell", args: { command: "rm -f x" } }],
                reason: "destructive tool",
                reasonCode: "destructive-tool",
                allowedVerbs: ["once", "deny"],
              },
            },
          ],
        },
      ],
    });
    const processor = makeCapturingProcessor();

    await emitChainedInterrupts(
      graph,
      "thread-42",
      "lane-alpha",
      processor,
      "resume-approval-ask",
    );

    expect(processor.captured).toHaveLength(1);
    const event = processor.captured[0]!;
    expect(event.type).toBe("approval.ask");
    const asApprovalAsk = event as ServerEvent & {
      threadId: string;
      laneKey: string;
      tools: Array<{ name: string }>;
    };
    expect(asApprovalAsk.threadId).toBe("thread-42");
    expect(asApprovalAsk.laneKey).toBe("lane-alpha");
    expect(asApprovalAsk.tools[0]!.name).toBe("run_shell");
  });

  test("chained prove_it_challenge → emits one prove_it.challenge event (resume-approval flow)", async () => {
    const graph = makeGraphStub({
      tasks: [
        {
          interrupts: [
            {
              value: {
                type: "prove_it_challenge",
                tools: [{ name: "run_shell", args: {}, id: "tc_chain" }],
              },
            },
          ],
        },
      ],
    });
    const processor = makeCapturingProcessor();

    await emitChainedInterrupts(graph, "t", "l", processor, "resume-approval");

    expect(processor.captured).toHaveLength(1);
    expect(processor.captured[0]!.type).toBe("prove_it.challenge");
  });

  test("processor without emit() → warns and skips without throwing (backwards-compatible fallback)", async () => {
    const graph = makeGraphStub({
      tasks: [
        {
          interrupts: [
            {
              value: {
                type: "approval_ask",
                tools: [],
                reason: "",
                allowedVerbs: ["once", "deny"],
              },
            },
          ],
        },
      ],
    });
    // Deliberately construct a pre-D084 processor: no `emit`.
    const legacyProcessor: StreamEventProcessor = {
      process() {},
      flush() {},
    };

    // Invariant: helper completes without throwing even when the
    // processor has no `emit` method. Assigning the result is the
    // easiest way to both await it and express "must not throw".
    const legacyResult = await emitChainedInterrupts(
      graph,
      "t",
      "l",
      legacyProcessor,
      "legacy",
    );
    expect(legacyResult).toBeUndefined();
  });

  test("graph.getState rejecting → caught, scan emits nothing, resume flow survives", async () => {
    const graph: GraphLikeForInterruptScan = {
      getState: () =>
        Promise.reject(new Error("simulated checkpointer failure")),
    };
    const processor = makeCapturingProcessor();

    const result = await emitChainedInterrupts(
      graph,
      "t",
      "l",
      processor,
      "test",
    );
    expect(result).toBeUndefined();
    expect(processor.captured).toEqual([]);
  });

  test("resume-identity caller — chained approval_ask after identity verification surfaces via shared helper", async () => {
    // D084 follow-up — verify the shared helper handles the
    // resume-identity call site identically to resume-approval /
    // resume-approval-ask. The real-world trigger: guest sends first
    // message → identity_challenge interrupt fires → user submits
    // PIN → `resumeGraphWithIdentity` runs → graph reaches a
    // destructive tool on the next step → graph re-interrupts with
    // `approval_ask`. Without `emitChainedInterrupts` in the
    // resume-identity flush sequence (or without an `emit` method on
    // the processor), the dock never surfaces and the session stalls.
    const graph = makeGraphStub({
      tasks: [
        {
          interrupts: [
            {
              value: {
                type: "approval_ask",
                tools: [{ name: "run_shell", args: { command: "brew install jq" } }],
                reason: "destructive tool after identity verification",
                reasonCode: "destructive-tool",
                allowedVerbs: ["once", "room", "always", "deny"],
              },
            },
          ],
        },
      ],
    });
    const processor = makeCapturingProcessor();

    await emitChainedInterrupts(
      graph,
      "thread-identity-chain",
      "lane-room-alpha",
      processor,
      "resume-identity",
    );

    expect(processor.captured).toHaveLength(1);
    const event = processor.captured[0]!;
    expect(event.type).toBe("approval.ask");
    const asApprovalAsk = event as ServerEvent & {
      threadId: string;
      laneKey: string;
    };
    expect(asApprovalAsk.threadId).toBe("thread-identity-chain");
    expect(asApprovalAsk.laneKey).toBe("lane-room-alpha");
  });

  test("two chained interrupts in separate tasks → both surfaced in task order", async () => {
    const graph = makeGraphStub({
      tasks: [
        {
          interrupts: [
            {
              value: {
                type: "approval_ask",
                tools: [{ name: "first", args: {} }],
                reason: "first tool",
                allowedVerbs: ["once", "deny"],
              },
            },
          ],
        },
        {
          interrupts: [
            {
              value: {
                type: "approval_ask",
                tools: [{ name: "second", args: {} }],
                reason: "second tool",
                allowedVerbs: ["once", "deny"],
              },
            },
          ],
        },
      ],
    });
    const processor = makeCapturingProcessor();

    await emitChainedInterrupts(graph, "t", "l", processor, "test");

    expect(processor.captured).toHaveLength(2);
    const first = processor.captured[0] as ServerEvent & {
      tools: Array<{ name: string }>;
    };
    const second = processor.captured[1] as ServerEvent & {
      tools: Array<{ name: string }>;
    };
    expect(first.tools[0]!.name).toBe("first");
    expect(second.tools[0]!.name).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// Smoke: `interruptValueToServerEvent` still lives at its new home and
// behaves identically to the runtime's pre-relocation contract. A
// separate regression test suite lives in the runtime package
// (`packages/runtime/tests/unit/interrupt-to-server-event.test.ts`);
// this adds one assertion here so the agent package owns a minimal
// safety net in case the runtime's import path ever drifts.
// ---------------------------------------------------------------------------

describe("interruptValueToServerEvent — smoke after D084 relocation", () => {
  test("host_choice maps to requester-private host.choice", () => {
    expect(interruptValueToServerEvent({
      type: "host_choice",
      choiceId: "choice-1",
      toolCallId: "tool-1",
      toolName: "run_shell",
      options: [
        { selector: "a", label: "Mac A" },
        { selector: "b", label: "Mac B" },
      ],
      userId: "user-1",
    }, "thread-1", "room:one")).toEqual({
      type: "host.choice",
      choiceId: "choice-1",
      threadId: "thread-1",
      laneKey: "room:one",
      toolCallId: "tool-1",
      toolName: "run_shell",
      options: [
        { selector: "a", label: "Mac A" },
        { selector: "b", label: "Mac B" },
      ],
      userId: "user-1",
    });
  });
  test("approval_ask with defaults → approval.ask with default allowedVerbs", () => {
    const ev = interruptValueToServerEvent(
      { type: "approval_ask", tools: [] },
      "t",
      "l",
    );
    expect(ev?.type).toBe("approval.ask");
    expect(
      (ev as ServerEvent & { allowedVerbs: string[] })?.allowedVerbs,
    ).toEqual(["once", "room", "always", "deny"]);
  });

  test("connected website attention is requester-private and strips provider fields", () => {
    const value = {
      type: "connected_web_action_attention",
      toolCallId: "tool-connected-web",
      userId: "user-1",
      intervention: {
        kind: "authentication_required",
        mode: "reconnect",
        reason: "mfa",
        account: {
          id: "account-1",
          label: "Example",
          service: "Example",
          origin: "https://example.com",
          profileId: "must-not-leak",
        },
        liveViewUrl: "https://live.browser-use.com/private",
      },
    };

    expect(interruptValueToServerEvent(value, "thread-1", "room:one")).toEqual({
      type: "connected_web.action_attention",
      threadId: "thread-1",
      laneKey: "room:one",
      toolCallId: "tool-connected-web",
      userId: "user-1",
      intervention: {
        kind: "authentication_required",
        mode: "reconnect",
        reason: "mfa",
        account: {
          id: "account-1",
          label: "Example",
          service: "Example",
          origin: "https://example.com",
        },
      },
    });
    expect(interruptValueToServerEvent({ ...value, userId: undefined }, "thread-1", "room:one")).toBeNull();
  });
});

test("resume lifecycle observes the actual post-checkpoint once, including unmapped interrupts and read failure", async () => {
  const observed: unknown[] = [];
  const processor: StreamEventProcessor = { process() {}, flush() {}, async finishResume(state) { observed.push(state); } };
  const completed = { tasks: [] };
  const awaiting = { tasks: [{ interrupts: [{ value: { type: "future_interrupt" } }] }] };
  for (const checkpoint of [completed, awaiting, undefined]) {
    await emitChainedInterrupts({ getState: async () => checkpoint }, "fork", "parent", processor, "test");
  }
  await emitChainedInterrupts({ getState: async () => { throw new Error("offline"); } }, "fork", "parent", processor, "test");
  expect(observed).toEqual([completed, awaiting, undefined, undefined]);
});
