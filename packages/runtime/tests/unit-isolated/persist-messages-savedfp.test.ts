/**
 * Unit tests for `persistMessages`'s in-memory dedup discipline,
 * with `appendTranscriptMessages` mocked so failures and successes
 * can be asserted deterministically without a DB.
 *
 * CONTRACTS pinned by these tests:
 *
 *   1. On a successful `appendTranscriptMessages`, every fingerprint
 *      from the batch is added to `savedFingerprints` so subsequent
 *      calls in the same turn skip them. Pre-fix behavior added
 *      fingerprints unconditionally during the filter pass; that
 *      poisoned the set on DB failures and prevented retry.
 *
 *   2. On a FAILED `appendTranscriptMessages` (any thrown error —
 *      e.g. btree size, FK, type), `savedFingerprints` MUST NOT have
 *      grown. The next persist call in the same turn gets a fresh
 *      attempt at the same messages.
 *
 *   3. A failure emits exactly one `session.persistence_failed`
 *      event whose `droppedCount` matches the batch size and whose
 *      `errorCode` is mapped from the underlying exception.
 *
 *   4. A persist call that the in-memory filter reduces to zero new
 *      messages MUST NOT touch the DB at all (no
 *      appendTranscriptMessages call, no event emit).
 *
 * These tests were written to fail against the pre-fix implementation
 * (poisoned dedup set on failure) and to pass after the fix.
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ServerEvent } from "@nautilo/types";
import * as realNautiloAgent from "@nautilo/agent";
import * as realNautiloDb from "@nautilo/db";
import {
  _resetForegroundTurnLifecycleObserverForTests,
  installForegroundTurnLifecycleObserver,
} from "../../src/foreground-turn-lifecycle";
import {
  _resetDurableToolResultLifecycleObserverForTests,
  installDurableToolResultLifecycleObserver,
  type DurableToolResultLifecycleEvent,
} from "../../src/durable-tool-result-lifecycle";

type AppendArgs = [
  threadId: string,
  ownerId: string,
  personaId: string,
  messages: ReadonlyArray<unknown>,
  options: Record<string, unknown>,
];

const appendCalls: AppendArgs[] = [];
let appendBehavior: () => Promise<{
  failedIndices: number[];
  insertedCount: number;
  insertedRows: Array<{
    id: string;
    role: string;
    content: string | null;
    fingerprint: string | null;
    replyToMessageId?: number | null;
  }>;
  rootSummary?: {
    parentRoomId: string;
    anchorMessageId: number;
    replyCount: number;
    lastReplyAt: Date | null;
    revision: number;
  };
}> = async () => ({ failedIndices: [], insertedCount: 1, insertedRows: [] });

mock.module("@nautilo/agent", () => ({
  appendTranscriptMessages: async (...args: AppendArgs) => {
    appendCalls.push(args);
    return await appendBehavior();
  },
  computeMessageFingerprint: (msg: { _getType?: () => string; content?: unknown }, opts?: { humanTurnId?: string }) => {
    // Cheap deterministic fingerprint that doesn't pull in the real
    // sha256 hashing — purely for set-membership behavior.
    const t =
      typeof msg._getType === "function"
        ? msg._getType()
        : "ai";
    const c = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    const turn = opts?.humanTurnId ? `:${opts.humanTurnId}` : "";
    return `mockfp:${t}:${c}${turn}`;
  },
}));

// D391 — capture stampTurnIdOnAttachments calls (real @nautilo/db spread so
// every other db export still resolves; only the stamp is intercepted).
const stampCalls: Array<{ attachmentIds: readonly string[]; turnId: string }> = [];
const projectionSteps: string[] = [];
let stampBehavior = async (input: { attachmentIds: readonly string[]; turnId: string }) => {
  stampCalls.push(input);
  projectionSteps.push("stamp");
};
let retainedRows: Awaited<ReturnType<typeof realNautiloDb.getAttachmentsForTurns>> = [];
const attachmentQueryCalls: string[][] = [];
mock.module("@nautilo/db", () => ({
  ...realNautiloDb,
  stampTurnIdOnAttachments: async (input: { attachmentIds: readonly string[]; turnId: string }) => {
    await stampBehavior(input);
  },
  getRoomNamespaceId: async () => "namespace:room-1",
  getAttachmentsForTurns: async (turnIds: readonly string[]) => {
    attachmentQueryCalls.push([...turnIds]);
    projectionSteps.push("query");
    return retainedRows;
  },
}));

const { persistMessages } = await import("../../src/executors/persist-messages");

function makeBus() {
  const emitted: ServerEvent[] = [];
  return {
    emitted,
    bus: { emit: (e: ServerEvent) => { emitted.push(e); } },
  };
}

// Bun's `mock.module` is process-global. When this file runs in the
// same worker as DB-touching integration tests, the mocked
// @nautilo/agent leaks and integration assertions then read from a
// fake store with no real rows. Restore the real module after this
// suite finishes so a single `bun test tests` invocation works.
afterAll(() => {
  mock.module("@nautilo/agent", () => realNautiloAgent);
  mock.module("@nautilo/db", () => realNautiloDb);
});

afterEach(() => {
  _resetForegroundTurnLifecycleObserverForTests();
  _resetDurableToolResultLifecycleObserverForTests();
});

describe("persistMessages — D391 turn_id stamp", () => {
  beforeEach(() => {
    appendCalls.length = 0;
    stampCalls.length = 0;
    projectionSteps.length = 0;
    attachmentQueryCalls.length = 0;
    retainedRows = [];
    stampBehavior = async (input) => {
      stampCalls.push(input);
      projectionSteps.push("stamp");
    };
    appendBehavior = async () => ({
      failedIndices: [],
      insertedCount: 1,
      insertedRows: [{
        id: "1",
        role: "user",
        content: "hello",
        fingerprint: "mockfp:human:hello:turn-xyz",
        replyToMessageId: null,
      }],
    });
  });

  test("internal website input is retained for audit but never emitted as a Human message", async () => {
    const { bus, emitted } = makeBus();
    const metadata = { originatedBy: "connected_web_operation", operationId: "op-1", controlEpoch: 1 };
    await persistMessages("t1", "owner-1", [new HumanMessage("internal checkpoint")], new Set(), {
      eventBus: bus, laneKey: "room:r1", metadata, suppressUserMessageEvents: true,
    });
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]![4]["metadata"]).toEqual(metadata);
    expect(emitted.some(e => e.type === "message.new")).toBe(false);
  });

  test("tool-only supervision metadata reaches storage without becoming whole-batch metadata", async () => {
    const { bus, emitted } = makeBus();
    const internalToolMetadata = { originatedBy: "connected_web_operation", operationId: "op-1", controlEpoch: 1 };
    const call = new AIMessage({ content: "Inspecting", tool_calls: [{ id: "tc1", name: "manage_connected_web_operation", args: { operation: "inspect" } }] });
    const result = new ToolMessage({ content: "done", tool_call_id: "tc1", name: "manage_connected_web_operation" });
    const final = new AIMessage("Useful answer");
    appendBehavior = async () => ({
      failedIndices: [], insertedCount: 3,
      insertedRows: [
        { id: "1", role: "assistant", content: "Inspecting", fingerprint: "mockfp:ai:Inspecting" },
        { id: "2", role: "tool", content: "done", fingerprint: "mockfp:tool:done" },
        { id: "3", role: "assistant", content: "Useful answer", fingerprint: "mockfp:ai:Useful answer" },
      ],
    });
    await persistMessages("t1", "owner-1", [call, result, final], new Set(), { eventBus: bus, laneKey: "room:r1", internalToolMetadata });
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]![3]).toHaveLength(3);
    expect(appendCalls[0]![4]["internalToolMetadata"]).toEqual(internalToolMetadata);
    expect(appendCalls[0]![4]["metadata"]).toBeUndefined();
    expect(emitted.flatMap(e => e.type === "message.new" && "content" in e ? [e.content] : [])).toEqual(["Useful answer"]);
  });

  test("stamps turn_id (= human fingerprint) on the retained attachments", async () => {
    const saved = new Set<string>();
    const { bus } = makeBus();
    await persistMessages("t1", "owner-1", [new HumanMessage("hello")], saved, {
      eventBus: bus,
      humanTurnId: "turn-xyz",
      retainedAttachmentIds: ["att-1", "att-2"],
    });
    expect(stampCalls.length).toBe(1);
    expect(stampCalls[0]!.attachmentIds).toEqual(["att-1", "att-2"]);
    // turn_id == the human row's fingerprint (mock fp shape: human:content:turn)
    expect(stampCalls[0]!.turnId).toBe("mockfp:human:hello:turn-xyz");
  });

  test("publishes exact retained Room descriptors after linkage and history hydration", async () => {
    const humanFp = "mockfp:human:hello:turn-xyz";
    const common = {
      uploaderActorId: "actor:sender",
      status: "retained" as const,
      storageUri: "file:///tmp/attachment",
      claimedMime: null,
      createdAt: new Date("2026-09-22T08:00:00.000Z"),
      expiresAt: null,
      resolvedAt: new Date("2026-09-22T08:00:00.000Z"),
      deletedAt: null,
    };
    retainedRows = [
      {
        ...common,
        id: "att-1",
        namespaceId: "namespace:room-1",
        filename: "screen.png",
        mimeType: "image/png",
        sizeBytes: 73,
        turnId: humanFp,
      },
      {
        ...common,
        id: "att-1",
        namespaceId: "namespace:foreign",
        filename: "foreign.png",
        mimeType: "image/png",
        sizeBytes: 99,
        turnId: humanFp,
      },
      {
        ...common,
        id: "att-1",
        namespaceId: "namespace:room-1",
        filename: "other-turn.png",
        mimeType: "image/png",
        sizeBytes: 101,
        turnId: "mockfp:human:other",
      },
      {
        ...common,
        id: "att-unselected",
        namespaceId: "namespace:room-1",
        filename: "unselected.png",
        mimeType: "image/png",
        sizeBytes: 55,
        turnId: humanFp,
      },
    ];
    const emitted: ServerEvent[] = [];
    const bus = { emit: (event: ServerEvent) => {
      if (event.type === "message.new") projectionSteps.push("emit");
      emitted.push(event);
    } };

    await persistMessages("t1", "owner-1", [new HumanMessage("hello")], new Set(), {
      eventBus: bus,
      humanTurnId: "turn-xyz",
      roomId: "room-1",
      laneKey: "room:room-1",
      retainedAttachmentIds: ["att-1"],
    });

    expect(projectionSteps).toEqual(["stamp", "query", "emit"]);
    expect(attachmentQueryCalls).toEqual([[humanFp]]);
    expect(emitted.find((event) => event.type === "message.new")).toMatchObject({
      type: "message.new",
      attachments: [{
        attachmentId: "att-1",
        filename: "screen.png",
        mimeType: "image/png",
        sizeBytes: 73,
      }],
    });
  });

  test("suppressed Human events still link retained attachments without publishing", async () => {
    const { bus, emitted } = makeBus();
    await persistMessages("t1", "owner-1", [new HumanMessage("hidden")], new Set(), {
      eventBus: bus,
      humanTurnId: "turn-hidden",
      retainedAttachmentIds: ["att-hidden"],
      suppressUserMessageEvents: true,
    });

    expect(stampCalls).toEqual([{
      attachmentIds: ["att-hidden"],
      turnId: "mockfp:human:hidden:turn-hidden",
    }]);
    expect(emitted.some((event) => event.type === "message.new")).toBe(false);
  });

  test("linkage failure keeps the persisted turn and emits its attachment-free live row", async () => {
    stampBehavior = async () => {
      projectionSteps.push("stamp");
      throw new Error("link unavailable");
    };
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();

    await persistMessages("t1", "owner-1", [new HumanMessage("hello")], saved, {
      eventBus: bus,
      humanTurnId: "turn-xyz",
      roomId: "room-1",
      laneKey: "room:room-1",
      retainedAttachmentIds: ["att-1"],
    });

    expect(saved).toContain("mockfp:human:hello:turn-xyz");
    const event = emitted.find((candidate) => candidate.type === "message.new");
    expect(event?.type).toBe("message.new");
    expect(event).not.toHaveProperty("attachments");
    expect(emitted.some((candidate) => candidate.type === "session.persistence_failed")).toBe(false);
  });

  test("publishes live edit identity for a newly persisted Human row", async () => {
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();
    await persistMessages("t1", "owner-1", [new HumanMessage("hello")], saved, {
      eventBus: bus,
      humanTurnId: "turn-xyz",
      laneKey: "room:room-1",
    });
    const event = emitted.find(
      (candidate) =>
        candidate.type === "message.new"
        && "messageId" in candidate
        && candidate.messageId === "1",
    );
    expect(event?.type).toBe("message.new");
    if (
      event?.type !== "message.new"
      || !("logicalMessageKey" in event)
    ) {
      throw new Error("legacy message.new missing");
    }
    expect(event.logicalMessageKey).toBe(
      "turn:mockfp:human:hello:turn-xyz",
    );
    expect(event.editRevision).toBe(0);
  });

  test("projects only the closed Advanced video workcard marker onto its live Human event", async () => {
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();
    await persistMessages("t1", "owner-1", [new HumanMessage("machine continuation")], saved, {
      eventBus: bus,
      humanTurnId: "turn-xyz",
      laneKey: "room:room-1",
      metadata: { originatedBy: "advanced_video_workcard", kind: "advanced_video", referenceCount: 2 },
    });
    const event = emitted.find((candidate) => candidate.type === "message.new");
    expect((event as { workcardContinuation?: unknown } | undefined)?.workcardContinuation).toEqual({
      kind: "advanced_video",
      referenceCount: 2,
    });
  });

  test("publishes a valid persisted reply pointer for a newly persisted Human row", async () => {
    appendBehavior = async () => ({
      failedIndices: [],
      insertedCount: 1,
      insertedRows: [{
        id: "1",
        role: "user",
        content: "hello",
        fingerprint: "mockfp:human:hello:turn-xyz",
        replyToMessageId: 7,
      }],
    });
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();
    await persistMessages("t1", "owner-1", [new HumanMessage("hello")], saved, {
      eventBus: bus,
      humanTurnId: "turn-xyz",
      laneKey: "room:room-1",
    });
    const event = emitted.find((candidate) => candidate.type === "message.new");
    expect((event as { replyToMessageId?: number } | undefined)?.replyToMessageId).toBe(7);
  });

  test("omits a non-positive persisted reply pointer from the live Human event", async () => {
    appendBehavior = async () => ({
      failedIndices: [],
      insertedCount: 1,
      insertedRows: [{
        id: "1",
        role: "user",
        content: "hello",
        fingerprint: "mockfp:human:hello:turn-xyz",
        replyToMessageId: 0,
      }],
    });
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();
    await persistMessages("t1", "owner-1", [new HumanMessage("hello")], saved, {
      eventBus: bus,
      laneKey: "room:room-1",
    });
    const event = emitted.find((candidate) => candidate.type === "message.new");
    expect(event).toBeDefined();
    expect((event as { replyToMessageId?: number } | undefined)?.replyToMessageId).toBeUndefined();
  });

  test("no retainedAttachmentIds → no stamp", async () => {
    const saved = new Set<string>();
    const { bus } = makeBus();
    await persistMessages("t1", "owner-1", [new HumanMessage("hi there")], saved, {
      eventBus: bus,
      humanTurnId: "turn-1",
    });
    expect(stampCalls.length).toBe(0);
  });

  test("does not stamp when there is no human row (assistant-only persist)", async () => {
    const saved = new Set<string>();
    const { bus } = makeBus();
    await persistMessages("t1", "owner-1", [new AIMessage("reply")], saved, {
      eventBus: bus,
      humanTurnId: "turn-2",
      retainedAttachmentIds: ["att-9"],
    });
    expect(stampCalls.length).toBe(0);
  });
});

describe("persistMessages — savedFingerprints discipline", () => {
  beforeEach(() => {
    appendCalls.length = 0;
    appendBehavior = async () => ({ failedIndices: [], insertedCount: 1, insertedRows: [] });
  });

  test("D513 partial Human append cancels exact-client eligibility", async () => {
    appendBehavior = async () => ({
      failedIndices: [0],
      insertedCount: 0,
      insertedRows: [],
    });
    const lifecycle: string[] = [];
    installForegroundTurnLifecycleObserver((event) => lifecycle.push(event.kind));
    const { bus } = makeBus();
    await persistMessages("t1", "owner-1", [new HumanMessage("hello")], new Set(), {
      eventBus: bus,
      humanTurnId: "turn-d513",
    });
    expect(lifecycle).toEqual(["human_persist_failed"]);
  });

  test("D513 deduped Human replay cancels exact-client eligibility without an append", async () => {
    const lifecycle: string[] = [];
    installForegroundTurnLifecycleObserver((event) => lifecycle.push(event.kind));
    const { bus } = makeBus();
    const saved = new Set(["mockfp:human:hello:turn-d513"]);
    await persistMessages("t1", "owner-1", [new HumanMessage("hello")], saved, {
      eventBus: bus,
      humanTurnId: "turn-d513",
    });
    expect(appendCalls).toHaveLength(0);
    expect(lifecycle).toEqual(["human_persist_failed"]);
  });

  test("D513 observes only an exactly inserted durable ToolMessage", async () => {
    const tool = new ToolMessage({
      name: "guide_user",
      tool_call_id: "call-1",
      content: '{"version":1,"kind":"guidance"}',
    });
    appendBehavior = async () => ({
      failedIndices: [],
      insertedCount: 1,
      insertedRows: [{
        id: "7",
        role: "tool",
        content: '{"version":1,"kind":"guidance"}',
        fingerprint: "mockfp:tool:{\"version\":1,\"kind\":\"guidance\"}:turn-d513",
        replyToMessageId: null,
      }],
    });
    const observed: DurableToolResultLifecycleEvent[] = [];
    installDurableToolResultLifecycleObserver((event) => observed.push(event));
    const { bus } = makeBus();
    await persistMessages("t1", "owner-1", [tool], new Set(), {
      eventBus: bus,
      humanTurnId: "turn-d513",
      trustedExecutionEntrypoint: "foreground.main",
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      toolName: "guide_user",
      fingerprint: "mockfp:tool:{\"version\":1,\"kind\":\"guidance\"}:turn-d513",
      turnId: "turn-d513",
      trustedExecutionEntrypoint: "foreground.main",
    });
  });

  test("D513 does not observe a replayed or non-inserted ToolMessage", async () => {
    const tool = new ToolMessage({ name: "guide_user", tool_call_id: "call-1", content: "{}" });
    appendBehavior = async () => ({ failedIndices: [], insertedCount: 0, insertedRows: [] });
    const observed: unknown[] = [];
    installDurableToolResultLifecycleObserver((event) => observed.push(event));
    const { bus } = makeBus();
    await persistMessages("t1", "owner-1", [tool], new Set(), {
      eventBus: bus,
      humanTurnId: "turn-d513",
      trustedExecutionEntrypoint: "foreground.main",
    });
    expect(observed).toEqual([]);
  });

  test("D513 observes only the ToolMessage fingerprint the durable append inserted", async () => {
    const guide = new ToolMessage({
      name: "guide_user",
      tool_call_id: "guide-call",
      content: '{"version":1,"kind":"guidance"}',
    });
    const other = new ToolMessage({ name: "other_tool", tool_call_id: "other-call", content: "{}" });
    appendBehavior = async () => ({
      failedIndices: [1],
      insertedCount: 1,
      insertedRows: [{
        id: "8",
        role: "tool",
        content: '{"version":1,"kind":"guidance"}',
        fingerprint: "mockfp:tool:{\"version\":1,\"kind\":\"guidance\"}:turn-d513",
        replyToMessageId: null,
      }],
    });
    const observed: DurableToolResultLifecycleEvent[] = [];
    installDurableToolResultLifecycleObserver((event) => observed.push(event));
    const { bus } = makeBus();
    await persistMessages("t1", "owner-1", [guide, other], new Set(), {
      eventBus: bus,
      humanTurnId: "turn-d513",
      trustedExecutionEntrypoint: "foreground.main",
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.toolName).toBe("guide_user");
  });

  test("success: fingerprints are added to savedFingerprints (subsequent calls skip them)", async () => {
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();

    await persistMessages("t1", "owner-1", [new AIMessage("hello")], saved, { eventBus: bus });

    expect(appendCalls.length).toBe(1);
    expect(appendCalls[0]![3].length).toBe(1);
    expect(saved.size).toBe(1);
    expect(emitted.length).toBe(0);

    // Second call with the same message should now be a no-op at the
    // filter level — no appendTranscriptMessages invocation.
    await persistMessages("t1", "owner-1", [new AIMessage("hello")], saved, { eventBus: bus });
    expect(appendCalls.length).toBe(1);
    expect(saved.size).toBe(1);
  });

  test("stamps the streamed assistant identity on the durable message event", async () => {
    appendBehavior = async () => ({
      failedIndices: [],
      insertedCount: 1,
      insertedRows: [{
        id: "77",
        role: "assistant",
        content: "final answer",
        fingerprint: "fp-77",
      }],
    });
    const { bus, emitted } = makeBus();

    await persistMessages("t1", "owner-1", [new AIMessage("final answer")], new Set(), {
      eventBus: bus,
      laneKey: "room:room-1",
      agentId: "agent-1",
      assistantMessageKey: "assistant:turn-1:0",
    });

    expect(emitted).toContainEqual({
      type: "message.new",
      laneKey: "room:room-1",
      messageId: "77",
      role: "ai",
      content: "final answer",
      authorAgentId: "agent-1",
      assistantMessageKey: "assistant:turn-1:0",
    });
  });

  test("D426: forwards the canonical child Room id to the transactional transcript append", async () => {
    const saved = new Set<string>();
    const { bus } = makeBus();

    await persistMessages(
      "room:child-room-1",
      "owner-1",
      [new AIMessage("threaded Genie reply")],
      saved,
      {
        eventBus: bus,
        roomId: "child-room-1",
        subthreadRoomId: "child-room-1",
      },
    );

    expect(appendCalls.length).toBe(1);
    expect(appendCalls[0]![4]).toMatchObject({
      roomId: "child-room-1",
      subthreadRoomId: "child-room-1",
    });
    expect(saved.size).toBe(1);
  });

  test("D426: publishes one post-commit absolute parent summary snapshot", async () => {
    appendBehavior = async () => ({
      failedIndices: [],
      insertedCount: 1,
      insertedRows: [{
        id: "44",
        role: "assistant",
        content: "counted reply",
        fingerprint: null,
      }],
      rootSummary: {
        parentRoomId: "parent-room-1",
        anchorMessageId: 17,
        replyCount: 2,
        lastReplyAt: new Date("2026-07-22T11:00:00.000Z"),
        revision: 5,
      },
    });
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();

    await persistMessages("room:child-room-1", "owner-1", [new AIMessage("counted reply")], saved, {
      eventBus: bus,
      roomId: "child-room-1",
      subthreadRoomId: "child-room-1",
    });

    expect(emitted).toContainEqual({
      type: "thread.summary.changed",
      laneKey: "room:parent-room-1",
      anchorMessageId: 17,
      replyCount: 2,
      lastReplyAt: "2026-07-22T11:00:00.000Z",
      summaryRevision: 5,
    });
  });

  test("D426: does not publish a summary event when append returns no summary", async () => {
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();

    await persistMessages("room:child-room-1", "owner-1", [new AIMessage("tool only")], saved, {
      eventBus: bus,
      roomId: "child-room-1",
      subthreadRoomId: "child-room-1",
    });

    expect(emitted.some((event) => event.type === "thread.summary.changed")).toBe(false);
  });

  test("M135 P6: transient room-context messages are NEVER persisted (clean transcript)", async () => {
    const saved = new Set<string>();
    const { bus } = makeBus();

    const contextMsg = new HumanMessage({
      content: "[Recent room conversation]\n[2026-06-01T13:00:00Z] Sender (@sender): hi",
      additional_kwargs: { nautilo_transient_context: true },
    });
    const realTurn = new HumanMessage("what is blocking deploy?");

    await persistMessages("t1", "owner-1", [contextMsg, realTurn], saved, { eventBus: bus });

    // Only the real human turn reaches appendTranscriptMessages.
    expect(appendCalls.length).toBe(1);
    const persisted = appendCalls[0]![3] as ReadonlyArray<{ content?: unknown }>;
    expect(persisted.length).toBe(1);
    expect(persisted[0]!.content).toBe("what is blocking deploy?");
  });

  test("failure: savedFingerprints DOES NOT grow, retry sees the same messages as new", async () => {
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();

    appendBehavior = async () => {
      const err: Error & { code?: string } = new Error("simulated FK");
      err.code = "23503";
      throw err;
    };

    await persistMessages("t1", "owner-1", [new AIMessage("a"), new AIMessage("b")], saved, {
      eventBus: bus,
    });

    expect(appendCalls.length).toBe(1);
    expect(saved.size).toBe(0);
    expect(emitted.length).toBe(1);
    const ev = emitted[0]!;
    expect(ev.type).toBe("session.persistence_failed");
    if (ev.type === "session.persistence_failed") {
      expect(ev.droppedCount).toBe(2);
      expect(ev.errorCode).toBe("fk_violation");
    }

    // Retry: same two messages should still be considered new because
    // savedFingerprints stayed empty.
    appendBehavior = async () => ({ failedIndices: [], insertedCount: 2, insertedRows: [] });
    await persistMessages("t1", "owner-1", [new AIMessage("a"), new AIMessage("b")], saved, {
      eventBus: bus,
    });

    expect(appendCalls.length).toBe(2);
    expect(appendCalls[1]![3].length).toBe(2);
    expect(saved.size).toBe(2);
  });

  test("zero new messages: no DB call, no event emitted", async () => {
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();

    await persistMessages("t1", "owner-1", [new AIMessage("seed")], saved, { eventBus: bus });
    expect(appendCalls.length).toBe(1);

    // Same message again — filter reduces to zero new.
    await persistMessages("t1", "owner-1", [new AIMessage("seed")], saved, { eventBus: bus });

    expect(appendCalls.length).toBe(1);
    expect(emitted.length).toBe(0);
    expect(saved.size).toBe(1);
  });

  test("partial new batch: only the not-yet-seen messages are persisted, all of those are added on success", async () => {
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();

    await persistMessages("t1", "owner-1", [new AIMessage("a")], saved, { eventBus: bus });
    expect(appendCalls.length).toBe(1);
    expect(saved.size).toBe(1);

    // Mixed batch: one already-seen, one new.
    await persistMessages(
      "t1",
      "owner-1",
      [new AIMessage("a"), new AIMessage("b")],
      saved,
      { eventBus: bus },
    );

    expect(appendCalls.length).toBe(2);
    expect(appendCalls[1]![3].length).toBe(1); // only "b"
    expect(saved.size).toBe(2);
    expect(emitted.length).toBe(0);
  });

  test("humanTurnId qualifier: same human text on different turns is treated as new", async () => {
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();

    await persistMessages("t1", "owner-1", [new HumanMessage("hi")], saved, {
      eventBus: bus,
      humanTurnId: "turn-1",
    });
    await persistMessages("t1", "owner-1", [new HumanMessage("hi")], saved, {
      eventBus: bus,
      humanTurnId: "turn-2",
    });

    expect(appendCalls.length).toBe(2);
    expect(saved.size).toBe(2);
    expect(emitted.length).toBe(0);
  });

  test("partial failure: only successful indices added to savedFingerprints, failed ones retry-eligible", async () => {
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();

    // Batch of 3; row at index 1 fails, others succeed.
    appendBehavior = async () => ({ failedIndices: [1], insertedCount: 2, insertedRows: [] });

    await persistMessages(
      "t1",
      "owner-1",
      [new AIMessage("a"), new AIMessage("b"), new AIMessage("c")],
      saved,
      { eventBus: bus },
    );

    expect(saved.size).toBe(2); // a + c only

    // Emits a partial-failure event so the UI can surface it.
    expect(emitted.length).toBe(1);
    const ev = emitted[0]!;
    expect(ev.type).toBe("session.persistence_failed");
    if (ev.type === "session.persistence_failed") {
      expect(ev.droppedCount).toBe(1);
      expect(ev.errorCode).toBe("partial");
    }

    // Retry of the same batch: 'a' and 'c' are skipped by in-memory
    // dedup, only 'b' is sent to the DB.
    appendBehavior = async () => ({ failedIndices: [], insertedCount: 1, insertedRows: [] });
    await persistMessages(
      "t1",
      "owner-1",
      [new AIMessage("a"), new AIMessage("b"), new AIMessage("c")],
      saved,
      { eventBus: bus },
    );

    expect(appendCalls.length).toBe(2);
    expect(appendCalls[1]![3].length).toBe(1); // only "b"
    expect(saved.size).toBe(3);
    expect(emitted.length).toBe(1); // no second partial-failure event
  });

  test("failure mid-conversation does not corrupt later successful persists", async () => {
    const saved = new Set<string>();
    const { bus, emitted } = makeBus();

    // First batch fails (e.g. one historical row was oversized).
    appendBehavior = async () => { throw new Error("Failed query: index row size exceeds 2704"); };
    await persistMessages("t1", "owner-1", [new AIMessage("big")], saved, { eventBus: bus });
    expect(saved.size).toBe(0);
    expect(emitted.length).toBe(1);

    // Next batch (the actual new turn) should still go through.
    appendBehavior = async () => ({ failedIndices: [], insertedCount: 1, insertedRows: [] });
    await persistMessages("t1", "owner-1", [new AIMessage("new turn")], saved, { eventBus: bus });

    expect(saved.size).toBe(1);
    expect(emitted.length).toBe(1); // no second failure
  });

  test("does not publish a user event when its ordinary representation is absent", async () => {
    const { bus, emitted } = makeBus();
    appendBehavior = async () => ({
      failedIndices: [],
      insertedCount: 1,
      insertedRows: [{
        id: "protected-user-1",
        role: "user",
        content: null,
        fingerprint: "mockfp:human:protected",
      }],
    });

    await persistMessages(
      "t1",
      "owner-1",
      [new HumanMessage("protected")],
      new Set(),
      { eventBus: bus, laneKey: "room:r1" },
    );

    expect(emitted.some((event) => event.type === "message.new")).toBe(false);
    expect(emitted.some((event) => event.type === "session.persistence_failed"
      && event.errorCode === "unknown")).toBe(true);
  });
});
