import { describe, expect, test } from "bun:test";
import type { ServerEvent, ThreadDetailResponse } from "@nautilo/types";
import {
  initialThreadRoomControllerState,
  threadRoomReducer,
} from "../thread-room-controller";
import { shouldRouteEventToThreadRoom } from "../../../../adapters/runtime-contexts";
import {
  MESSAGE_ATTACHMENTS_METADATA_KEY,
  restoreSessionMessages,
} from "../../../../adapters/session-rehydrate";

const detail: ThreadDetailResponse = {
  parentRoomId: "parent-a",
  subthreadRoomId: "child-a",
  anchor: { id: "42", role: "user", content: "root", createdAt: "2026-01-01T00:00:00.000Z" },
  summary: { replyCount: 0, lastReplyAt: null, summaryRevision: 0 },
};

function ready() {
  return threadRoomReducer(
    threadRoomReducer(initialThreadRoomControllerState, {
      type: "open", roomId: "child-a", visible: true, connected: true,
    }),
    { type: "hydrated", roomId: "child-a", detail, messages: [], runtimeMessages: [], activeJobIds: [] },
  );
}

describe("threadRoomReducer", () => {
  const reactionSeed = () => ({
    ...ready(),
    runtimeMessages: [{
      id: "42", role: "user" as const, content: [{ type: "text" as const, text: "child" }],
      metadata: { custom: { reactions: [{ emoji: "👍", count: 1, actorIds: ["agent-a"] }] } },
    }],
  });

  test("opens only after canonical detail and history hydrate", () => {
    const opening = threadRoomReducer(initialThreadRoomControllerState, {
      type: "open", roomId: "child-a", visible: true, connected: true,
    });
    expect(opening.phase).toBe("hydrating");
    expect(opening.detail).toBeNull();

    const hydrated = threadRoomReducer(opening, {
      type: "hydrated", roomId: "child-a", detail, messages: [], runtimeMessages: [], activeJobIds: ["job-a"],
    });
    expect(hydrated.phase).toBe("ready");
    expect(hydrated.anchor?.id).toBe("42");
    expect(hydrated.activeJobIds).toEqual(["job-a"]);
  });

  test("merges target-centered history without replacing live child objects", () => {
    const live = { id: "99", role: "assistant" as const, content: [{ type: "text" as const, text: "streaming" }] };
    const seeded = { ...ready(), runtimeMessages: [live] };
    const merged = threadRoomReducer(seeded, {
      type: "history.aroundMerged",
      roomId: "child-a",
      messages: [{ id: "41", role: "user", content: "older", createdAt: "2026-01-01T00:00:00.000Z" }],
      runtimeMessages: [{ id: "41", role: "user", content: [{ type: "text", text: "older" }] }],
    });
    expect(merged.runtimeMessages.map((message) => message.id)).toEqual(["41", "99"]);
    expect(merged.runtimeMessages[1]).toBe(live);

    expect(threadRoomReducer(merged, {
      type: "history.aroundMerged",
      roomId: "child-b",
      messages: [],
      runtimeMessages: [],
    })).toBe(merged);
  });

  test("switch and close clear transient state without issuing a stop action", () => {
    const state = threadRoomReducer(ready(), { type: "stop.started" });
    const switched = threadRoomReducer(state, {
      type: "open", roomId: "child-b", visible: true, connected: true,
    });
    expect(switched.roomId).toBe("child-b");
    expect(switched.stopping).toBe(false);
    expect(switched.messages).toEqual([]);
    expect(threadRoomReducer(switched, { type: "close" })).toEqual(initialThreadRoomControllerState);
  });

  test("restores a retryable draft when an optimistic send fails", () => {
    const started = threadRoomReducer(ready(), {
      type: "send.started", requestId: "request-1", content: "hello", createdAt: "2026-01-01T00:00:00.000Z",
    });
    const failed = threadRoomReducer(started, { type: "send.failed", requestId: "request-1", error: "offline" });
    expect(failed.draft).toBe("hello");
    expect(failed.send).toMatchObject({ status: "error", retryableDraft: "hello", error: "offline" });
    expect(failed.messages).toEqual([]);
  });

  test("projects a quoted optimistic child reply immediately", () => {
    const started = threadRoomReducer(ready(), {
      type: "send.started",
      requestId: "request-quote",
      content: "quoted child reply",
      createdAt: "2026-01-01T00:00:00.000Z",
      replyToMessageId: 42,
    });
    expect(started.messages).toEqual([
      expect.objectContaining({ replyToMessageId: 42, optimisticRequestId: "request-quote" }),
    ]);
    expect(started.runtimeMessages[0]?.metadata).toMatchObject({
      custom: { replyToMessageId: 42, optimisticRequestId: "request-quote" },
    });
  });

  test("reconciles a persisted echo with the earliest matching optimistic message", () => {
    const started = threadRoomReducer(ready(), {
      type: "send.started", requestId: "request-1", content: "same", createdAt: "2026-01-01T00:00:00.000Z",
    });
    const echoed = threadRoomReducer(started, {
      type: "event.received",
      event: {
        type: "message.new",
        laneKey: "room:child-a",
        messageId: "77",
        logicalMessageKey: "turn:fp-live",
        editRevision: 0,
        role: "user",
        content: "same",
      },
    });
    expect(echoed.messages).toEqual([
      expect.objectContaining({
        id: "77",
        content: "same",
        logicalMessageKey: "turn:fp-live",
        editRevision: 0,
      }),
    ]);
    expect(echoed.runtimeMessages[0]?.metadata).toMatchObject({
      custom: {
        logicalMessageKey: "turn:fp-live",
        editRevision: 0,
      },
    });
  });

  test("projects live attachment refs with the same metadata shape as hydration", () => {
    const attachments = [{
      attachmentId: "attachment-1",
      filename: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 42,
    }];
    const live = threadRoomReducer(ready(), {
      type: "event.received",
      event: {
        type: "message.new",
        laneKey: "room:child-a",
        messageId: "attachment-message",
        role: "user",
        content: "See the diagram",
        createdAt: "2026-01-01T00:00:00.000Z",
        attachments,
      },
    });
    const [hydrated] = restoreSessionMessages([{
      id: "attachment-message",
      role: "user",
      content: "See the diagram",
      createdAt: "2026-01-01T00:00:00.000Z",
      attachments,
    }]);

    expect(live.messages[0]?.attachments).toEqual(attachments);
    expect(live.runtimeMessages[0]?.metadata).toEqual(hydrated?.metadata);
  });

  test("ignores attachment refs from an unrelated room", () => {
    const state = ready();
    const unrelated = threadRoomReducer(state, {
      type: "event.received",
      event: {
        type: "message.new",
        laneKey: "room:child-b",
        messageId: "other-attachment",
        role: "user",
        content: "Other room",
        attachments: [{
          attachmentId: "attachment-other",
          filename: "other.png",
          mimeType: "image/png",
          sizeBytes: 24,
        }],
      },
    });

    expect(unrelated).toBe(state);
  });

  test("keeps attachment refs when a duplicate event omits them", () => {
    const attachments = [{
      attachmentId: "attachment-1",
      filename: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 42,
    }];
    const first = threadRoomReducer(ready(), {
      type: "event.received",
      event: {
        type: "message.new",
        laneKey: "room:child-a",
        messageId: "attachment-message",
        role: "user",
        content: "See the diagram",
        attachments,
      },
    });
    const duplicate = threadRoomReducer(first, {
      type: "event.received",
      event: {
        type: "message.new",
        laneKey: "room:child-a",
        messageId: "attachment-message",
        role: "user",
        content: "See the diagram",
      },
    });
    const custom = (duplicate.runtimeMessages[0]?.metadata as {
      custom?: Record<string, unknown>;
    } | undefined)?.custom;

    expect(duplicate.messages).toHaveLength(1);
    expect(duplicate.messages[0]?.attachments).toEqual(attachments);
    expect(custom?.[MESSAGE_ATTACHMENTS_METADATA_KEY]).toEqual(attachments);
  });

  test("applies newer logical message edits and ignores stale revisions", () => {
    const seeded = {
      ...ready(),
      messages: [{
        id: "77",
        logicalMessageKey: "turn:fp-1",
        role: "user",
        content: "before",
        createdAt: "2026-01-01T00:00:00.000Z",
        editRevision: 1,
      }],
      runtimeMessages: [{
        id: "77",
        role: "user" as const,
        content: [{ type: "text" as const, text: "before" }],
        metadata: {
          custom: { logicalMessageKey: "turn:fp-1", editRevision: 1 },
        },
      }],
    };
    const edited = threadRoomReducer(seeded, {
      type: "event.received",
      event: {
        type: "message.updated",
        laneKey: "room:child-a",
        logicalMessageKey: "turn:fp-1",
        content: "after",
        editedAt: "2026-08-01T10:00:00.000Z",
        editRevision: 2,
      },
    });
    expect(edited.messages[0]).toMatchObject({ content: "after", editRevision: 2 });
    expect(edited.runtimeMessages[0]?.content).toEqual([{ type: "text", text: "after" }]);
    const stale = threadRoomReducer(edited, {
      type: "event.received",
      event: {
        type: "message.updated",
        laneKey: "room:child-a",
        logicalMessageKey: "turn:fp-1",
        content: "stale",
        editedAt: "2026-08-01T09:00:00.000Z",
        editRevision: 1,
      },
    });
    expect(stale.messages[0]?.content).toBe("after");
  });

  test("keeps a live child message when the earlier history request hydrates", () => {
    const opening = threadRoomReducer(initialThreadRoomControllerState, {
      type: "open", roomId: "child-a", visible: true, connected: true,
    });
    const live = threadRoomReducer(opening, {
      type: "event.received",
      event: { type: "message.new", laneKey: "room:child-a", messageId: "live-1", role: "user", content: "arrived first" },
    });
    const hydrated = threadRoomReducer(live, {
      type: "hydrated",
      roomId: "child-a",
      detail,
      messages: [{ id: "history-1", role: "user", content: "history", createdAt: "2026-01-01T00:00:00.000Z" }],
      runtimeMessages: [{ id: "history-1", role: "user", content: [{ type: "text", text: "history" }] }],
      activeJobIds: [],
    });
    expect(hydrated.messages.map((message) => message.id)).toEqual(["history-1", "live-1"]);
    expect(hydrated.runtimeMessages.map((message) => message.id)).toEqual(["history-1", "live-1"]);
  });

  test("withholds protected structural notifications until authenticated content arrives", () => {
    const state = ready();
    const afterNotification = threadRoomReducer(state, {
      type: "event.received",
      event: {
        type: "message.new",
        laneKey: "room:child-a",
        messageId: "protected-1",
        role: "user",
        content: null,
      } as unknown as ServerEvent,
    });
    expect(afterNotification).toBe(state);

    const hydrated = threadRoomReducer(state, {
      type: "hydrated",
      roomId: "child-a",
      detail,
      messages: [
        { id: "visible-1", role: "user", content: "authenticated", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "protected-1", role: "user", content: null, createdAt: "2026-01-01T00:00:01.000Z" },
      ] as unknown as Parameters<typeof threadRoomReducer>[1] extends { type: "hydrated"; messages: infer T } ? T : never,
      runtimeMessages: [
        { id: "visible-1", role: "user", content: [{ type: "text", text: "authenticated" }] },
        { id: "protected-1", role: "user", content: null },
      ] as unknown as Parameters<typeof threadRoomReducer>[1] extends { type: "hydrated"; runtimeMessages: infer T } ? T : never,
      activeJobIds: [],
    });
    expect(hydrated.messages.map((message) => message.id)).toEqual(["visible-1"]);
    expect(hydrated.runtimeMessages.map((message) => message.id)).toEqual(["visible-1"]);
  });

  test("reconciles a partial child stream when hydration contains its canonical final row", () => {
    const opening = threadRoomReducer(initialThreadRoomControllerState, {
      type: "open", roomId: "child-a", visible: true, connected: true,
    });
    const streaming = threadRoomReducer(opening, {
      type: "event.received",
      event: {
        type: "message.tokens",
        laneKey: "room:child-a",
        turnId: "turn-1",
        authorAgentId: "agent-1",
        content: "partial",
        done: true,
      },
    });
    const hydrated = threadRoomReducer(streaming, {
      type: "hydrated",
      roomId: "child-a",
      detail,
      messages: [{
        id: "canonical-1",
        role: "assistant",
        content: "partial and final",
        createdAt: "2026-01-01T00:00:00.000Z",
        authorAgentId: "agent-1",
      }],
      runtimeMessages: [{
        id: "canonical-1",
        role: "assistant",
        content: [{ type: "text", text: "partial and final" }],
        metadata: { custom: { authorAgentId: "agent-1" } },
      }],
      activeJobIds: [],
    });
    expect(hydrated.runtimeMessages.map((message) => message.id)).toEqual(["canonical-1"]);
    expect(hydrated.streams).toEqual({});
  });

  test("does not retire an unfinished child stream for an older same-agent prefix", () => {
    const opening = threadRoomReducer(initialThreadRoomControllerState, {
      type: "open", roomId: "child-a", visible: true, connected: true,
    });
    const streaming = threadRoomReducer(opening, {
      type: "event.received",
      event: {
        type: "message.tokens",
        laneKey: "room:child-a",
        turnId: "turn-current",
        authorAgentId: "agent-1",
        content: "I",
        done: false,
      },
    });
    const hydrated = threadRoomReducer(streaming, {
      type: "hydrated",
      roomId: "child-a",
      detail,
      messages: [{
        id: "older",
        role: "assistant",
        content: "I answered earlier",
        createdAt: "2026-01-01T00:00:00.000Z",
        authorAgentId: "agent-1",
      }],
      runtimeMessages: [{
        id: "older",
        role: "assistant",
        content: [{ type: "text", text: "I answered earlier" }],
      }],
      activeJobIds: ["job-current"],
    });
    expect(hydrated.runtimeMessages.map((message) => message.id)).toEqual([
      "older",
      expect.stringMatching(/^stream:/),
    ]);
    expect(Object.keys(hydrated.streams)).toHaveLength(1);
  });

  test("retires an active partial stream when its persisted child reply arrives", () => {
    const streaming = threadRoomReducer(ready(), {
      type: "event.received",
      event: {
        type: "message.tokens", laneKey: "room:child-a", turnId: "turn-a", authorAgentId: "agent-a",
        content: "partial", chunkSequence: 1, done: false,
      },
    });
    const persisted = threadRoomReducer(streaming, {
      type: "event.received",
      event: {
        type: "message.new", laneKey: "room:child-a", messageId: "88", role: "ai", authorAgentId: "agent-a", content: "partial completed",
      },
    });
    expect(persisted.messages).toEqual([expect.objectContaining({ id: "88", content: "partial completed" })]);
    expect(persisted.streams).toEqual({});
  });

  test("keeps tool calls in Assistant UI event order before the final answer", () => {
    const started = threadRoomReducer(ready(), {
      type: "event.received",
      event: {
        type: "tool.start", laneKey: "room:child-a", toolCallId: "search-1",
        toolName: "run_web_search", argsSummary: '{"query":"threads"}', turnId: "turn-a", authorAgentId: "agent-a",
      },
    });
    const ended = threadRoomReducer(started, {
      type: "event.received",
      event: {
        type: "tool.end", laneKey: "room:child-a", toolCallId: "search-1",
        toolName: "run_web_search", status: "success", duration: 10, result: "sources", turnId: "turn-a", authorAgentId: "agent-a",
      },
    });
    const answered = threadRoomReducer(ended, {
      type: "event.received",
      event: {
        type: "message.new", laneKey: "room:child-a", messageId: "answer-1",
        role: "ai", content: "Final answer", authorAgentId: "agent-a",
      },
    });
    expect(answered.runtimeMessages.map((message) => message.id)).toEqual([
      "tool-search-1",
      "answer-1",
    ]);
    expect(answered.runtimeMessages[0]?.content[0]).toMatchObject({
      type: "tool-call",
      result: "sources",
    });
  });

  test("projects live tool args before child transcript and activity state retain them", () => {
    const sessionSecret = "live-child-session-secret";
    const nestedSecret = "live-child-nested-secret";
    const started = threadRoomReducer(ready(), {
      type: "event.received",
      event: {
        type: "tool.start",
        laneKey: "room:child-a",
        toolCallId: "inspect-live-1",
        toolName: "inspect_open_design",
        argsSummary: JSON.stringify({
          sessionToken: sessionSecret,
          cursor: "page:2",
          request: { authorization: nestedSecret, intent: "inspect next page" },
        }),
      },
    });

    expect(started.runtimeMessages[0]?.content[0]).toMatchObject({
      type: "tool-call",
      args: {
        request: { intent: "inspect next page" },
      },
    });
    expect(started.tools["inspect-live-1"]?.argsSummary).toBe(JSON.stringify({
      request: { intent: "inspect next page" },
    }));
    const serialized = JSON.stringify(started);
    expect(serialized).not.toContain(sessionSecret);
    expect(serialized).not.toContain(nestedSecret);

    const ended = threadRoomReducer(started, {
      type: "event.received",
      event: {
        type: "tool.end",
        laneKey: "room:child-a",
        toolCallId: "inspect-live-1",
        toolName: "inspect_open_design",
        status: "success",
        duration: 12,
        result: JSON.stringify({
          total: 2,
          returned: 2,
          completeness: "complete",
          nextCursor: sessionSecret,
          nodes: [{ name: "Ellipse" }, { name: "Connector" }],
        }),
      },
    });
    const endedSerialized = JSON.stringify(ended);
    expect(endedSerialized).toContain("Ellipse");
    expect(endedSerialized).toContain("completeness");
    expect(endedSerialized).not.toContain("nextCursor");
    expect(endedSerialized).not.toContain(sessionSecret);
  });

  test("rejects wrong-room traffic", () => {
    const state = ready();
    const wrongRoom = threadRoomReducer(state, {
      type: "event.received",
      event: { type: "message.tokens", laneKey: "room:child-b", content: "leak", chunkSequence: 1, done: false },
    });
    expect(wrongRoom).toBe(state);
  });

  test("keeps concurrent parent jobs out while retiring a correlated child terminal replay", () => {
    const dispatched = threadRoomReducer(ready(), {
      type: "event.received",
      event: { type: "job.dispatched", laneKey: "room:child-a", jobId: "child-job", virtualJobIds: [] },
    });
    const parentTerminal = threadRoomReducer(dispatched, {
      type: "event.received",
      event: { type: "job.status", laneKey: "room:parent-a", jobId: "parent-job", status: "completed" },
    });
    expect(parentTerminal).toBe(dispatched);

    const childTerminal = threadRoomReducer(parentTerminal, {
      type: "event.received",
      event: { type: "job.status", jobId: "child-job", status: "completed" },
    });
    expect(childTerminal.activeJobIds).toEqual([]);
  });

  test("read state can start only for a ready, visible matching child", () => {
    const hidden = threadRoomReducer(ready(), { type: "visibility.changed", visible: false });
    expect(threadRoomReducer(hidden, { type: "read.started", roomId: "child-a" })).toBe(hidden);
    const marked = threadRoomReducer(ready(), { type: "read.started", roomId: "child-a" });
    expect(marked.read).toEqual({ status: "marking", requestedForRoomId: "child-a" });
  });

  test("keeps hydrated reactions and reconciles optimistic human plus idempotent WS echo", () => {
    const optimistic = threadRoomReducer(reactionSeed(), {
      type: "reaction.optimistic", operationId: "react-1", roomId: "child-a",
      messageId: 42, emoji: "👍", delta: 1, actorId: "viewer-a",
    });
    expect(optimistic.runtimeMessages[0]?.metadata).toMatchObject({
      custom: { reactions: [{ emoji: "👍", count: 2, actorIds: ["agent-a", "viewer-a"] }] },
    });
    const echoed = threadRoomReducer(optimistic, {
      type: "event.received",
      event: { type: "reaction.added", laneKey: "room:child-a", messageId: 42, emoji: "👍", actorId: "viewer-a", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(echoed.runtimeMessages[0]?.metadata).toMatchObject({
      custom: { reactions: [{ emoji: "👍", count: 2, actorIds: ["agent-a", "viewer-a"] }] },
    });
  });

  test("routes child reaction events before the parent active-room gate and applies agent add/remove deltas", () => {
    const registration = { roomId: "child-a", ingestEvent: () => {}, ownsJobId: () => false };
    const agentEvent = {
      type: "reaction.added" as const, laneKey: "room:child-a", messageId: 42,
      emoji: "🎉", actorId: "agent-a", createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(shouldRouteEventToThreadRoom(registration, agentEvent, (lane) => lane.slice("room:".length))).toBe(true);
    const updated = threadRoomReducer(reactionSeed(), { type: "event.received", event: agentEvent });
    expect(updated.runtimeMessages[0]?.metadata).toMatchObject({
      custom: { reactions: expect.arrayContaining([expect.objectContaining({ emoji: "🎉", count: 1, actorIds: ["agent-a"] })]) },
    });
    const removed = threadRoomReducer(updated, {
      type: "event.received",
      event: { type: "reaction.removed", laneKey: "room:child-a", messageId: 42, emoji: "🎉", actorId: "agent-a" },
    });
    const reactions = (removed.runtimeMessages[0]?.metadata as { custom?: { reactions?: { emoji: string }[] } })?.custom?.reactions;
    expect(reactions?.some((reaction) => reaction.emoji === "🎉")).toBe(false);
  });

  test("rolls back only the failed child operation and ignores late failure after a sibling switch", () => {
    const optimistic = threadRoomReducer(reactionSeed(), {
      type: "reaction.optimistic", operationId: "react-1", roomId: "child-a",
      messageId: 42, emoji: "🎉", delta: 1, actorId: "viewer-a",
    });
    const rolledBack = threadRoomReducer(optimistic, {
      type: "reaction.failed", roomId: "child-a", operationId: "react-1",
    });
    expect(rolledBack.runtimeMessages[0]?.metadata).toMatchObject({
      custom: { reactions: [{ emoji: "👍", count: 1, actorIds: ["agent-a"] }] },
    });

    const switched = threadRoomReducer(optimistic, {
      type: "open", roomId: "child-b", visible: true, connected: true,
    });
    expect(threadRoomReducer(switched, {
      type: "reaction.failed", roomId: "child-a", operationId: "react-1",
    })).toBe(switched);
  });

  test("does not admit a parent reaction even when parent and child message ids collide", () => {
    const state = reactionSeed();
    const parent = threadRoomReducer(state, {
      type: "event.received",
      event: { type: "reaction.added", laneKey: "room:parent-a", messageId: 42, emoji: "🔥", actorId: "parent-user", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(parent).toBe(state);
    const child = threadRoomReducer(parent, {
      type: "event.received",
      event: { type: "reaction.added", laneKey: "room:child-a", messageId: 42, emoji: "🔥", actorId: "child-user", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(child.runtimeMessages[0]?.metadata).toMatchObject({
      custom: { reactions: expect.arrayContaining([expect.objectContaining({ emoji: "🔥", actorIds: ["child-user"] })]) },
    });
  });
});


test("parent deletion clears the open thread anchor without losing replies or accepting a late edit", () => {
  const initial = ready();
  const deleted = threadRoomReducer(initial, { type: "event.received", event: { type: "message.deleted", laneKey: "room:parent-a", messageId: 42 } });
  expect(deleted.anchor?.content).toBe("Message removed by moderation");
  expect(deleted.detail?.anchor.content).toBe("Message removed by moderation");
  expect(deleted.messages).toEqual(initial.messages);
  const edited = threadRoomReducer(deleted, { type: "event.received", event: { type: "message.updated", laneKey: "room:parent-a", logicalMessageKey: "row:42", content: "Old content", editRevision: 99, editedAt: new Date().toISOString() } });
  expect(edited.anchor?.content).toBe("Message removed by moderation");
});
