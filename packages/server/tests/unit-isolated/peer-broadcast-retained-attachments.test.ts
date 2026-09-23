import { describe, expect, mock, test } from "bun:test";
import * as actualAgent from "@nautilo/agent";
import * as actualDb from "@nautilo/db";
import * as actualRuntime from "@nautilo/runtime";

const calls: string[] = [];
const emitted: unknown[] = [];
const attachmentId = "44444444-4444-4444-8444-444444444444";
const namespaceId = "22222222-2222-4222-8222-222222222222";
const fingerprint = "turn:retained-png";
let failHydration = false;
let includeRootSummary = false;
let persistenceCount = 0;
let appendOptions: Parameters<typeof actualAgent.appendTranscriptMessages>[4];

mock.module("@nautilo/agent", () => ({
  ...actualAgent,
  appendTranscriptMessages: mock(async (...args: Parameters<typeof actualAgent.appendTranscriptMessages>) => {
    appendOptions = args[4];
    persistenceCount += 1;
    return {
      failedIndices: [],
      insertedCount: 1,
      insertedRows: [{
        id: "42",
        role: "user",
        content: "screenshot",
        fingerprint,
        createdAt: "2026-09-22T08:00:00.000Z",
        replyToMessageId: null,
      }],
      ...(includeRootSummary ? {
        rootSummary: {
          parentRoomId: "room:parent",
          anchorMessageId: 7,
          replyCount: 3,
          lastReplyAt: new Date("2026-09-22T08:00:00.000Z"),
          revision: 4,
        },
      } : {}),
    };
  }),
  buildForegroundUserHumanMessage: mock(() => ({})),
  getDefaultModel: mock(() => ({ id: "model:test" })),
}));

mock.module("@nautilo/db", () => ({
  ...actualDb,
  db: {
    insert: () => ({
      values: () => ({ onConflictDoNothing: async () => undefined }),
    }),
  },
  getSessionMessageFingerprintById: mock(async () => {
    calls.push("fingerprint");
    return fingerprint;
  }),
  stampTurnIdOnAttachments: mock(async (args: {
    attachmentIds: readonly string[];
    turnId: string;
  }) => {
    calls.push(`stamp:${args.attachmentIds.join(",")}:${args.turnId}`);
  }),
  getAttachmentsForTurns: mock(async (turnIds: readonly string[]) => {
    calls.push(`history:${turnIds.join(",")}`);
    if (failHydration) throw new Error("injected hydration failure");
    const common = {
      uploaderActorId: "actor:sender",
      status: "retained",
      storageUri: "file:///tmp/attachment",
      claimedMime: null,
      turnId: fingerprint,
      createdAt: new Date("2026-09-22T08:00:00.000Z"),
      expiresAt: null,
      resolvedAt: new Date("2026-09-22T08:00:00.000Z"),
      deletedAt: null,
    };
    return [
      {
        ...common,
        id: attachmentId,
        namespaceId,
        filename: "screen.png",
        mimeType: "image/png",
        sizeBytes: 73,
      },
      {
        ...common,
        id: "55555555-5555-4555-8555-555555555555",
        namespaceId,
        filename: "other.png",
        mimeType: "image/png",
        sizeBytes: 12,
      },
      {
        ...common,
        id: attachmentId,
        namespaceId: "33333333-3333-4333-8333-333333333333",
        filename: "foreign.png",
        mimeType: "image/png",
        sizeBytes: 99,
      },
    ];
  }),
}));

mock.module("@nautilo/runtime", () => ({
  ...actualRuntime,
  eventBus: {
    emit: (event: unknown) => {
      calls.push("emit");
      emitted.push(event);
    },
  },
}));

const { peerBroadcastHumanMessage } = await import(
  "../../src/messaging/peer-broadcast"
);

describe("ordinary Human peer attachment delivery", () => {
  test.each([false, true])("preserves retained image delivery with room-wide mention intent %s", async (mentionEveryone) => {
    calls.length = 0;
    emitted.length = 0;
    failHydration = false;
    includeRootSummary = false;
    persistenceCount = 0;

    await peerBroadcastHumanMessage({
      room: {
        id: "room:peer",
        graphThreadId: "thread:peer",
        kind: "group",
        members: [
          { kind: "user", userId: "user:sender" },
          { kind: "user", userId: "user:peer" },
        ],
      } as never,
      senderUserId: "user:sender",
      mentionEveryone,
      content: "screenshot",
      attachmentTextBlocks: [],
      multimodalImages: [],
      attachmentStatuses: [
        {
          id: attachmentId,
          filename: "screen.png",
          decision: "accept",
          kind: "image",
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          filename: "other.png",
          decision: "reject",
          kind: "image",
        },
      ],
      canonicalRoomNamespaceId: namespaceId,
    });

    expect(calls).toEqual([
      "fingerprint",
      `stamp:${attachmentId}:${fingerprint}`,
      `history:${fingerprint}`,
      "emit",
    ]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "message.new",
      laneKey: "room:room:peer",
      messageId: "42",
      attachments: [{
        attachmentId,
        filename: "screen.png",
        mimeType: "image/png",
        sizeBytes: 73,
      }],
    });
    expect(persistenceCount).toBe(1);
    expect(appendOptions?.notificationContext?.mentionEveryone).toBe(mentionEveryone || undefined);
  });

  test("still publishes the durable message and root summary when attachment hydration fails", async () => {
    calls.length = 0;
    emitted.length = 0;
    failHydration = true;
    includeRootSummary = true;
    persistenceCount = 0;

    const result = await peerBroadcastHumanMessage({
      room: {
        id: "room:peer",
        graphThreadId: "thread:peer",
        kind: "subthread",
        members: [
          { kind: "user", userId: "user:sender" },
          { kind: "user", userId: "user:peer" },
        ],
      } as never,
      senderUserId: "user:sender",
      content: "screenshot",
      attachmentTextBlocks: [],
      multimodalImages: [],
      attachmentStatuses: [{
        id: attachmentId,
        filename: "screen.png",
        decision: "accept",
        kind: "image",
      }],
      canonicalRoomNamespaceId: namespaceId,
    });

    expect(persistenceCount).toBe(1);
    expect(calls).toEqual([
      "fingerprint",
      `stamp:${attachmentId}:${fingerprint}`,
      `history:${fingerprint}`,
      "emit",
      "emit",
    ]);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      type: "message.new",
      laneKey: "room:room:peer",
      messageId: "42",
    });
    expect(emitted[0]).not.toHaveProperty("attachments");
    expect(emitted[1]).toEqual({
      type: "thread.summary.changed",
      laneKey: "room:room:parent",
      anchorMessageId: 7,
      replyCount: 3,
      lastReplyAt: "2026-09-22T08:00:00.000Z",
      summaryRevision: 4,
    });
    expect(result).toMatchObject({
      messageId: 42,
      attachments: [{ id: attachmentId, decision: "accept" }],
      coalesced: true,
      rootSummary: { parentRoomId: "room:parent", revision: 4 },
    });
  });
});
