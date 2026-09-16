import { describe, expect, test } from "bun:test";
import type {
  ProtectedMessageRealtimeEventV2,
  ServerEvent,
} from "@nautilo/types";

import {
  applyThreadSummaryEvent,
  applyStreamEvent,
  chatItemPresentationKey,
  fromHistoryMessages,
  makeOptimisticUserItem,
  reconcileLatestHistoryItems,
  reconcilePersistedHumanMessage,
  type ChatItem,
  type MessageItem,
} from "./messages";

function apply(items: ChatItem[], event: ServerEvent): ChatItem[] {
  return applyStreamEvent(items, event);
}

describe("mobile chat item presentation identity", () => {
  test("preserves canonical retained attachment identity through history projection", () => {
    const [message] = fromHistoryMessages([{
      id: "42", role: "human", content: "", createdAt: "2026-08-27T00:00:00.000Z",
      attachments: [{ attachmentId: "attachment-1", filename: "photo.png", mimeType: "image/png", sizeBytes: 42 }],
    }], (ref) => ({ kind: "retained", ...ref, uri: `https://server.test/${ref.attachmentId}`, headers: { Authorization: "Bearer synthetic" } }));
    expect(message).toMatchObject({ kind: "message", attachments: [{
      kind: "retained", attachmentId: "attachment-1", filename: "photo.png", mimeType: "image/png", sizeBytes: 42,
    }] });
  });

  test("retains the available realtime tool result and its truncation receipt", () => {
    const started = apply([], {
      type: "tool.start",
      laneKey: "room:00000000-0000-4000-8000-000000000001",
      toolCallId: "tool-1",
      toolName: "run_shell",
    } as ServerEvent);
    const completed = apply(started, {
      type: "tool.end",
      laneKey: "room:00000000-0000-4000-8000-000000000001",
      toolCallId: "tool-1",
      toolName: "run_shell",
      duration: 25,
      status: "success",
      result: "available bytes",
      resultTruncated: true,
    } as ServerEvent);

    expect(completed[0]).toMatchObject({
      kind: "tool",
      status: "success",
      result: "available bytes",
      resultTruncated: true,
    });
  });

  test("hydrates persisted tool disclosure from content, not its compact display line", () => {
    const persistedResult = "first.txt\nsecond.txt\nthird.txt";
    const [tool] = fromHistoryMessages([{
      id: "42",
      role: "tool",
      content: persistedResult,
      displayContent: "⚙ file [success]",
      toolName: "file",
      createdAt: "2026-08-27T00:00:00.000Z",
    }]);

    expect(tool).toMatchObject({
      kind: "tool",
      toolName: "file",
      status: "success",
      result: persistedResult,
    });
  });

  test("hydrates persisted tool failure state and legacy name from its compact display line", () => {
    const [failed, legacy] = fromHistoryMessages([
      {
        id: "42",
        role: "tool",
        content: "Error: permission denied",
        displayContent: "⚙ file [error]",
        toolName: "file",
        createdAt: "2026-08-27T00:00:00.000Z",
      },
      {
        id: "43",
        role: "tool",
        content: "done",
        displayContent: "⚙ run_shell [success 18ms]",
        toolName: null,
        createdAt: "2026-08-27T00:01:00.000Z",
      },
    ]);

    expect(failed).toMatchObject({
      kind: "tool",
      toolName: "file",
      status: "error",
      result: "Error: permission denied",
    });
    expect(legacy).toMatchObject({
      kind: "tool",
      toolName: "run_shell",
      status: "success",
      result: "done",
    });
  });

  test("removes a realtime-deleted message idempotently", () => {
    const items: ChatItem[] = [
      { kind: "message", id: "8", role: "user", text: "remove", createdAt: "2026-08-15T00:00:00Z" },
      { kind: "message", id: "9", role: "assistant", text: "keep", createdAt: "2026-08-15T00:01:00Z" },
    ];
    const event = {
      type: "message.deleted",
      laneKey: "room:00000000-0000-4000-8000-000000000001",
      messageId: 8,
    } as ServerEvent;
    const deleted = apply(items, event);
    expect(deleted.map((item) => item.kind === "message" ? item.id : item.toolCallId)).toEqual(["9"]);
    expect(apply(deleted, event)).toBe(deleted);
  });

  test("keeps an optimistic Human row mounted when its server id arrives", () => {
    const optimistic = makeOptimisticUserItem(
      "opt-1",
      "Voice transcript",
      "2026-08-13T00:00:00.000Z",
    );
    expect(chatItemPresentationKey(optimistic)).toBe("msg:opt-1");

    const acknowledged = optimistic.kind === "message"
      ? { ...optimistic, id: "42", status: "sent" as const }
      : optimistic;
    expect(chatItemPresentationKey(acknowledged)).toBe("msg:opt-1");
  });

  test("merges reconnect history without dropping mounted or in-flight rows", () => {
    const mounted: ChatItem[] = [
      {
        kind: "message",
        id: "1",
        role: "assistant",
        text: "Older page",
        createdAt: "2026-08-13T00:00:00.000Z",
      },
      {
        kind: "message",
        id: "42",
        role: "user",
        text: "Voice transcript",
        createdAt: "2026-08-13T00:01:00.000Z",
        status: "sent",
        presentationKey: "opt-1",
      },
      makeOptimisticUserItem(
        "opt-2",
        "Still sending",
        "2026-08-13T00:02:00.000Z",
      ),
    ];
    const canonical = fromHistoryMessages([
      {
        id: "42",
        role: "user",
        content: "Voice transcript",
        createdAt: "2026-08-13T00:01:00.000Z",
      },
      {
        id: "43",
        role: "ai",
        content: "New catch-up",
        createdAt: "2026-08-13T00:03:00.000Z",
      },
    ]);

    const reconciled = reconcileLatestHistoryItems(mounted, canonical);
    expect(reconciled.map((item) => item.kind === "message" ? item.id : item.toolCallId)).toEqual([
      "1",
      "42",
      "opt-2",
      "43",
    ]);
    expect(chatItemPresentationKey(reconciled[1])).toBe("msg:opt-1");
    expect(reconciled[2]).toMatchObject({ id: "opt-2", status: "pending" });
  });

  test("keeps assistant phases in one Tool-using turn uniquely keyed", () => {
    const laneKey = "room:00000000-0000-4000-8000-000000000001";
    const turnId = "a940caeb-166d-4636-a971-0fbe66ce0e2b";
    let items: ChatItem[] = [];

    items = apply(items, {
      type: "message.tokens",
      laneKey,
      turnId,
      content: "I’ll check that.",
    } as ServerEvent);
    items = apply(items, {
      type: "message.new",
      laneKey,
      messageId: "101",
      role: "ai",
      content: "I’ll check that.",
    } as ServerEvent);
    items = apply(items, {
      type: "message.tokens",
      laneKey,
      turnId,
      content: "The command succeeded.",
    } as ServerEvent);

    const keys = items.map(chatItemPresentationKey);
    expect(keys).toEqual([
      `msg:streaming:${turnId}`,
      `msg:streaming:${turnId}:1`,
    ]);
    expect(new Set(keys).size).toBe(items.length);
  });

  test("reconciles a streamed background Task reply into one durable bubble", () => {
    const laneKey = "room:00000000-0000-4000-8000-000000000001";
    const turnId = "task-run-1";
    const assistantMessageKey = `assistant:${turnId}:0`;
    let items: ChatItem[] = [];

    for (const content of ["Artifact ", "received."]) {
      items = apply(items, {
        type: "message.tokens",
        laneKey,
        turnId,
        assistantMessageKey,
        authorAgentId: "agent-nova",
        content,
        chunkSequence: items.length + 1,
        done: false,
      });
    }
    items = apply(items, {
      type: "message.tokens",
      laneKey,
      turnId,
      assistantMessageKey,
      authorAgentId: "agent-nova",
      content: "",
      chunkSequence: 3,
      done: true,
    });
    items = apply(items, {
      type: "message.new",
      laneKey,
      messageId: "501",
      role: "ai",
      content: "Artifact received.",
      authorAgentId: "agent-nova",
      assistantMessageKey,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "message",
      id: "501",
      role: "assistant",
      text: "Artifact received.",
      authorAgentId: "agent-nova",
      status: "sent",
    });
  });
});

describe("mobile message edit projections", () => {
  test("projects authoritative history metadata and preserves distinct raw Human prose", () => {
    const [message] = fromHistoryMessages([{
      id: "42",
      role: "user",
      content: "Raw editable prose",
      displayContent: "Projected display prose",
      logicalMessageKey: "human:turn:42",
      editRevision: 3,
      editedAt: "2026-09-09T08:30:00.000Z",
      createdAt: "2026-09-09T08:00:00.000Z",
    }]);

    expect(message).toMatchObject({
      kind: "message",
      text: "Projected display prose",
      editContent: "Raw editable prose",
      logicalMessageKey: "human:turn:42",
      editRevision: 3,
      editedAt: "2026-09-09T08:30:00.000Z",
    });
  });

  test("projects only editing coordinates present on message.new", () => {
    const projected = apply([], {
      type: "message.new",
      laneKey: "room:00000000-0000-4000-8000-000000000001",
      messageId: "42",
      logicalMessageKey: "human:turn:42",
      editRevision: 0,
      role: "user",
      content: "Hello",
      sourceUserId: "human-1",
    });
    const unknown = apply([], {
      type: "message.new",
      laneKey: "room:00000000-0000-4000-8000-000000000001",
      messageId: "43",
      role: "user",
      content: "Legacy",
      sourceUserId: "human-1",
    });

    expect(projected[0]).toMatchObject({
      logicalMessageKey: "human:turn:42",
      editRevision: 0,
    });
    expect(projected[0]).not.toHaveProperty("editedAt");
    expect(unknown[0]).not.toHaveProperty("logicalMessageKey");
    expect(unknown[0]).not.toHaveProperty("editRevision");
    expect(unknown[0]).not.toHaveProperty("editedAt");
  });

  test("applies a newer edit to every logical projection and ignores repeats and stale events", () => {
    const attachment = { kind: "local" as const, uri: "file:///photo.png" };
    const items: ChatItem[] = [
      {
        kind: "message",
        id: "42",
        presentationKey: "mounted-42",
        role: "user",
        text: "Before",
        createdAt: "2026-09-09T08:00:00.000Z",
        logicalMessageKey: "human:turn:42",
        editRevision: 1,
        attachments: [attachment],
        reactions: [{ emoji: "👍", count: 2, mine: true }],
      },
      {
        kind: "message",
        id: "84",
        role: "user",
        text: "Before (thread projection)",
        createdAt: "2026-09-09T08:00:00.000Z",
        logicalMessageKey: "human:turn:42",
        editRevision: 0,
      },
    ];
    const event = {
      type: "message.updated" as const,
      laneKey: "room:00000000-0000-4000-8000-000000000001",
      logicalMessageKey: "human:turn:42",
      content: "After",
      editRevision: 2,
      editedAt: "2026-09-09T08:40:00.000Z",
    };

    const updated = apply(items, event);
    expect(updated).toHaveLength(2);
    expect(updated[0]).toMatchObject({
      id: "42",
      presentationKey: "mounted-42",
      text: "After",
      editRevision: 2,
      editedAt: "2026-09-09T08:40:00.000Z",
      attachments: [attachment],
      reactions: [{ emoji: "👍", count: 2, mine: true }],
    });
    expect(updated[1]).toMatchObject({ id: "84", text: "After", editRevision: 2 });
    expect(apply(updated, event)).toBe(updated);
    expect(apply(updated, { ...event, content: "Stale", editRevision: 1 })).toBe(updated);
  });

  test("does not let a stale message.new upsert undo a newer edit", () => {
    const current: ChatItem[] = [{
      kind: "message",
      id: "42",
      role: "user",
      text: "Newer",
      createdAt: "2026-09-09T08:00:00.000Z",
      logicalMessageKey: "human:turn:42",
      editRevision: 2,
      editedAt: "2026-09-09T08:40:00.000Z",
      reactions: [{ emoji: "✅", count: 1 }],
    }];
    const reconciled = apply(current, {
      type: "message.new",
      laneKey: "room:00000000-0000-4000-8000-000000000001",
      messageId: "42",
      logicalMessageKey: "human:turn:42",
      editRevision: 0,
      role: "user",
      content: "Original",
      sourceUserId: "human-1",
    });

    expect(reconciled[0]).toMatchObject({
      text: "Newer",
      editRevision: 2,
      editedAt: "2026-09-09T08:40:00.000Z",
      reactions: [{ emoji: "✅", count: 1 }],
    });
  });

  test("does not let stale reconnect history downgrade a newer realtime revision", () => {
    const current: ChatItem[] = [{
      kind: "message",
      id: "42",
      presentationKey: "mounted-42",
      role: "user",
      text: "Realtime edit",
      createdAt: "2026-09-09T08:00:00.000Z",
      logicalMessageKey: "human:turn:42",
      editRevision: 4,
      editedAt: "2026-09-09T08:45:00.000Z",
    }];
    const staleHistory = fromHistoryMessages([{
      id: "42",
      role: "user",
      content: "Earlier edit",
      logicalMessageKey: "human:turn:42",
      editRevision: 3,
      editedAt: "2026-09-09T08:40:00.000Z",
      createdAt: "2026-09-09T08:00:00.000Z",
    }]);

    expect(reconcileLatestHistoryItems(current, staleHistory)[0]).toMatchObject({
      presentationKey: "mounted-42",
      text: "Realtime edit",
      editRevision: 4,
      editedAt: "2026-09-09T08:45:00.000Z",
    });
  });

  test("confirms an exact persisted Human without resurrecting a vanished row", () => {
    const local = makeOptimisticUserItem(
      "42",
      "Hello",
      "2026-09-09T08:00:00.000Z",
      [{ uri: "file:///photo.png" }],
    );
    const incoming: MessageItem = {
      kind: "message",
      id: "42",
      role: "user",
      text: "Hello",
      createdAt: "2026-09-09T08:00:00.000Z",
      status: "sent",
      logicalMessageKey: "human:turn:42",
      editRevision: 0,
    };

    const confirmed = reconcilePersistedHumanMessage([local], incoming);
    expect(confirmed[0]).toMatchObject({
      id: "42",
      presentationKey: "42",
      status: "sent",
      logicalMessageKey: "human:turn:42",
      editRevision: 0,
      attachments: [{ kind: "local", uri: "file:///photo.png" }],
    });
    expect(confirmed[0]).not.toHaveProperty("clientId");
    expect(reconcilePersistedHumanMessage([], incoming)).toEqual([]);

    const newerMounted: MessageItem = {
      ...incoming,
      text: "Newer realtime edit",
      editRevision: 2,
      editedAt: "2026-09-09T08:45:00.000Z",
      presentationKey: "mounted-42",
      reactions: [{ emoji: "✅", count: 1 }],
    };
    const staleConfirmation = reconcilePersistedHumanMessage(
      [newerMounted],
      { ...incoming, text: "Original", editRevision: 0 },
    );
    expect(staleConfirmation[0]).toMatchObject({
      presentationKey: "mounted-42",
      text: "Newer realtime edit",
      editRevision: 2,
      editedAt: "2026-09-09T08:45:00.000Z",
      reactions: [{ emoji: "✅", count: 1 }],
    });
  });
});

describe("mobile canonical thread summaries", () => {
  test("hydrates the visible reply count from parent history", () => {
    const [message] = fromHistoryMessages([{
      id: "42",
      role: "user",
      content: "Parent",
      createdAt: "2026-08-04T00:00:00.000Z",
      replyCount: 3,
      summaryRevision: 7,
    }]);
    expect(message).toMatchObject({ kind: "message", replyCount: 3, summaryRevision: 7 });
  });

  test("applies only a newer absolute summary revision", () => {
    const items: ChatItem[] = [{
      kind: "message",
      id: "42",
      role: "user",
      text: "Parent",
      createdAt: "2026-08-04T00:00:00.000Z",
      replyCount: 2,
      summaryRevision: 4,
    }];
    const updated = applyThreadSummaryEvent(items, {
      anchorMessageId: 42,
      replyCount: 3,
      summaryRevision: 5,
    });
    expect(updated[0]).toMatchObject({ replyCount: 3, summaryRevision: 5 });
    expect(applyThreadSummaryEvent(updated, {
      anchorMessageId: 42,
      replyCount: 1,
      summaryRevision: 4,
    })).toBe(updated);
  });
});

describe("mobile protected-message compatibility boundary", () => {
  test("leaves chat state unchanged for unsupported protected events", () => {
    const items: ChatItem[] = [
      {
        kind: "message",
        id: "existing",
        role: "user",
        text: "Existing plaintext message",
        createdAt: "2026-08-04T00:00:00.000Z",
        status: "sent",
      },
    ];
    const protectedEvent: ProtectedMessageRealtimeEventV2 = {
      wireVersion: 2,
      type: "message.new",
      protection: "protected",
      laneKey: "room:00000000-0000-4000-8000-000000000001",
      message: {
        dtoVersion: 2,
        projection: {
          messageId: "42",
          logicalMessageKey: "turn-01",
          sessionId: "00000000-0000-4000-8000-000000000002",
          roomId: "00000000-0000-4000-8000-000000000001",
          namespaceId: "00000000-0000-4000-8000-000000000003",
          role: "assistant",
          createdAt: "2026-08-04T00:00:00.000Z",
          editedAt: null,
          editRevision: 0,
        },
        protectedPayload: {
          status: "encrypted",
          cryptoObjectId: "message-object-42",
          payloadVersion: 2,
          keyClass: "ai",
          encryptedPayloadBytesBase64url: "AQIDBA",
          accessManifestBytesBase64url: "BQYHCA",
          namespaceEnvelopeBytesBase64url: "CQoLDA",
        },
      },
    };

    expect(applyStreamEvent(items, protectedEvent)).toBe(items);
  });
});
