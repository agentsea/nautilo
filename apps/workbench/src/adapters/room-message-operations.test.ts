import { describe, expect, mock, test } from "bun:test";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
  type LiveShadowEncryptionTransitionPolicy,
} from "@nautilo/lattice-bridge";
import { createRoomMessageOperations } from "./room-message-operations";
import type { ServerEvent } from "@nautilo/types";

const modes: readonly LiveShadowEncryptionTransitionPolicy[] = [
  { mode: "plaintext_only", shadowBehavior: "fallback" },
  { mode: "shadow_encryption", shadowBehavior: "fallback" },
  { mode: "shadow_encryption", shadowBehavior: "strict" },
  { mode: "encrypted_only", shadowBehavior: "strict" },
];

function fixture(policy: LiveShadowEncryptionTransitionPolicy, hasDevice = true) {
  const revalidate = mock(async () => {});
  const owner = bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({ policy, revalidationToken: 1 }), revalidate,
  } });
  const ordinarySend = mock(async () => ({ messageId: 1, jobId: null }));
  const protectedSend = mock(async () => ({ messageId: 2, jobId: null }));
  const getOlderRoomMessages = mock(async () => ({
    messages: [{ id: "1", role: "user", content: "ordinary", createdAt: "2026-09-08T00:00:00Z" }],
    pageInfo: { hasMoreBefore: false, oldestCursor: null },
  }));
  const getRoomMessagesAround = mock(async () => ({
    messages: [], target: { messageId: "1", createdAt: "2026-09-08T00:00:00Z" },
    includedToolCallCompanion: false, hasOlder: false, hasNewer: false,
  }));
  const operations = createRoomMessageOperations({
    owner, api: { getOlderRoomMessages }, around: { getRoomMessagesAround }, ordinarySend,
    ...(hasDevice ? { protectedSend } : {}),
  });
  return { operations, ordinarySend, protectedSend, getOlderRoomMessages, getRoomMessagesAround, revalidate };
}

describe("shared Room data operations", () => {
  const contentEvents: readonly ServerEvent[] = [
    { type: "message.new", laneKey: "room:child", messageId: "1", role: "user", content: "human" },
    { type: "message.new", laneKey: "room:child", messageId: "2", role: "ai", content: "agent" },
    { type: "message.tokens", laneKey: "room:child", content: "chunk", done: false },
    { type: "message.updated", laneKey: "room:child", logicalMessageKey: "logical", content: "edit", editedAt: "2026-09-08T00:00:00Z", editRevision: 1 },
    { type: "tool.start", laneKey: "room:child", toolCallId: "call", toolName: "search_memory", argsSummary: "private query" },
    { type: "tool.end", laneKey: "room:child", toolCallId: "call", toolName: "search_memory", duration: 1, status: "success", result: "private result" },
  ];
  for (const policy of modes) test(`same main/child receive signature in ${policy.mode}/${policy.shadowBehavior}`, async () => {
    const f = fixture(policy);
    const ordinaryAllowed = policy.mode === "plaintext_only"
      || (policy.mode === "shadow_encryption" && policy.shadowBehavior === "fallback");
    for (const event of contentEvents) {
      if (ordinaryAllowed) expect(await f.operations.consumeRealtime(event, false)).toBe(event);
      else await expect(f.operations.consumeRealtime(event, false)).rejects.toThrow("waiting");
      expect(await f.operations.consumeRealtime(event, true)).toBe(event);
    }
  });
  for (const policy of modes) test(`same child/main send signature in ${policy.mode}/${policy.shadowBehavior}`, async () => {
    const f = fixture(policy);
    await f.operations.sendRoomMessage("child-room", { content: "hello" });
    const ordinary = policy.mode === "plaintext_only";
    expect(f.ordinarySend).toHaveBeenCalledTimes(ordinary ? 1 : 0);
    expect(f.protectedSend).toHaveBeenCalledTimes(ordinary ? 0 : 1);
    expect(f.revalidate).toHaveBeenCalled();
  });

  test("Plain reads without opening custody, Fallback retains eligible ordinary data", async () => {
    for (const policy of modes.slice(0, 2)) {
      const f = fixture(policy, false);
      const page = await f.operations.readRoomMessages("child-room");
      expect(page.messages[0]?.content).toBe("ordinary");
      expect(f.getOlderRoomMessages).toHaveBeenCalledTimes(1);
    }
  });

  test("Strict and Full missing custody never call ordinary read/send", async () => {
    for (const policy of modes.slice(2)) {
      const f = fixture(policy, false);
      await expect(f.operations.readRoomMessages("child-room")).rejects.toThrow("waiting");
      await expect(f.operations.sendRoomMessage("child-room", { content: "secret" })).rejects.toThrow("waiting");
      expect(f.getOlderRoomMessages).not.toHaveBeenCalled();
      expect(f.ordinarySend).not.toHaveBeenCalled();
    }
  });

  test("Strict and Full accept an empty Room page with no zero-selection sidecar", async () => {
    for (const policy of modes.slice(2)) {
      const owner = bindEncryptionDataOperationOwner({ policy: {
        resolve: async () => ({ policy, revalidationToken: 1 }),
        revalidate: async () => {},
      } });
      const getOlderRoomMessages = mock(async () => ({
        messages: [],
        pageInfo: { hasMoreBefore: false, oldestCursor: null },
      }));
      const operations = createRoomMessageOperations({
        owner,
        api: { getOlderRoomMessages },
        ordinarySend: mock(async () => ({ messageId: 1, jobId: null })),
        historyReader: {
          createIntent: () => ({ requestVersion: 1, clientRequestKey: "empty-room" }),
          reconcile: () => Promise.reject(new Error("zero rows require no custody read")),
        },
      });

      expect(await operations.readRoomMessages("brand-new-room")).toEqual({
        messages: [],
        pageInfo: { hasMoreBefore: false, oldestCursor: null },
      });
      expect(getOlderRoomMessages).toHaveBeenCalledTimes(1);
      expect(getOlderRoomMessages.mock.calls[0]?.[0]).toMatchObject({
        shadowRead: { requestVersion: 1, clientRequestKey: "empty-room" },
      });
    }
  });

  test("protected history preserves a classified stale verifier result", async () => {
    const policy = modes[2]!;
    const owner = bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy, revalidationToken: 1 }),
      revalidate: async () => {},
    } });
    const operations = createRoomMessageOperations({
      owner,
      api: { getOlderRoomMessages: mock(async () => ({
        messages: [{ id: "1", role: "user", content: "ordinary", createdAt: "2026-09-08T00:00:00Z" }],
        pageInfo: { hasMoreBefore: false, oldestCursor: null },
        shadowEncryption: {
          responseVersion: 1 as const,
          status: "ineligible" as const,
          selectedCount: 1,
          eligibleCount: 0 as const,
        },
      })) },
      ordinarySend: mock(async () => ({ messageId: 1, jobId: null })),
      historyReader: {
        createIntent: () => ({ requestVersion: 1, clientRequestKey: "stale-room" }),
        reconcile: () => Promise.reject(new ClassifiedDataOperationError(
          "stale", "Room history policy revision changed",
        )),
      },
    });

    expect(operations.readRoomMessages("room-a"))
      .rejects.toThrow("Room history policy revision changed");
  });

  test("protected history still rejects malformed or missing sidecars for selected rows", async () => {
    const policy = modes[2]!;
    for (const page of [
      {
        messages: [],
        pageInfo: { hasMoreBefore: false, oldestCursor: null },
        shadowEncryption: { status: "bogus" },
      },
      {
        messages: [{ id: "1", role: "user", content: "ordinary", createdAt: "2026-09-08T00:00:00Z" }],
        pageInfo: { hasMoreBefore: false, oldestCursor: null },
      },
    ]) {
      const owner = bindEncryptionDataOperationOwner({ policy: {
        resolve: async () => ({ policy, revalidationToken: 1 }),
        revalidate: async () => {},
      } });
      const operations = createRoomMessageOperations({
        owner,
        api: { getOlderRoomMessages: mock(async () => page as never) },
        ordinarySend: mock(async () => ({ messageId: 1, jobId: null })),
        historyReader: {
          createIntent: () => ({ requestVersion: 1, clientRequestKey: "invalid-sidecar" }),
          reconcile: ({ messages }) => Promise.resolve(messages),
        },
      });
      expect(operations.readRoomMessages("room-a"))
        .rejects.toThrow("missing or malformed");
    }
  });

  test("unknown protected publication failures never retry the ordinary write", async () => {
    const f = fixture(modes[1]!);
    f.protectedSend.mockRejectedValueOnce(new Error("ambiguous commit"));
    await expect(f.operations.sendRoomMessage("child-room", { content: "hello" })).rejects.toThrow("ambiguous commit");
    expect(f.ordinarySend).not.toHaveBeenCalled();
  });

  test("pagination preserves the exact caller cursor through the bound owner", async () => {
    const f = fixture(modes[0]!);
    await f.operations.readOlderRoomMessages({
      roomId: "room-a", beforeId: "41", beforeCreatedAt: "2026-09-01T00:00:00Z", limit: 25,
    });
    expect(f.getOlderRoomMessages).toHaveBeenCalledWith({
      roomId: "room-a", beforeId: "41", beforeCreatedAt: "2026-09-01T00:00:00Z", limit: 25,
    });
  });

  test("pagination strips an injected raw shadow intent", async () => {
    const f = fixture(modes[0]!);
    await f.operations.readOlderRoomMessages({
      roomId: "room-a", beforeId: "41", beforeCreatedAt: "2026-09-01T00:00:00Z",
      shadowRead: { attacker: true },
    } as never);
    expect(f.getOlderRoomMessages).toHaveBeenCalledWith({
      roomId: "room-a", beforeId: "41", beforeCreatedAt: "2026-09-01T00:00:00Z",
    });
  });

  test("reconnect reloads complete pages to the mounted oldest cursor in chronological page order", async () => {
    const f = fixture(modes[0]!);
    f.getOlderRoomMessages
      .mockResolvedValueOnce({
        messages: [{ id: "3", role: "user", content: "new", createdAt: "2026-09-03T00:00:00Z" }],
        pageInfo: { hasMoreBefore: true, oldestCursor: { id: "3", createdAt: "2026-09-03T00:00:00Z" } },
      })
      .mockResolvedValueOnce({
        messages: [{ id: "2", role: "user", content: "old", createdAt: "2026-09-02T00:00:00Z" }],
        pageInfo: { hasMoreBefore: false, oldestCursor: { id: "2", createdAt: "2026-09-02T00:00:00Z" } },
      });
    const window = await f.operations.readReconnectWindow("room-a", {
      id: "2", createdAt: "2026-09-02T00:00:00Z",
    });
    expect(window.messages.map((message) => message.id)).toEqual(["2", "3"]);
    expect(f.getOlderRoomMessages).toHaveBeenCalledTimes(2);
  });

  test("around-message strips an injected raw shadow intent", async () => {
    const f = fixture(modes[0]!);
    await f.operations.readRoomMessagesAround({
      roomId: "room-a", messageId: "41", shadowRead: { attacker: true },
    } as never);
    expect(f.getRoomMessagesAround).toHaveBeenCalledWith({ roomId: "room-a", messageId: "41" });
  });

  test("reconnect rejects a repeated non-progressing cursor", async () => {
    const f = fixture(modes[0]!);
    f.getOlderRoomMessages.mockResolvedValue({
      messages: [{ id: "3", role: "user", content: "same", createdAt: "2026-09-03T00:00:00Z" }],
      pageInfo: { hasMoreBefore: true, oldestCursor: { id: "3", createdAt: "2026-09-03T00:00:00Z" } },
    });
    await expect(f.operations.readReconnectWindow("room-a", {
      id: "2", createdAt: "2026-09-02T00:00:00Z",
    })).rejects.toThrow("did not advance");
  });

  test("around-message is ordinary in Plain and never falls back without protected custody", async () => {
    const plain = fixture(modes[0]!);
    await plain.operations.readRoomMessagesAround({ roomId: "room-a", messageId: "1" });
    expect(plain.getRoomMessagesAround).toHaveBeenCalledTimes(1);
    const fallback = fixture(modes[1]!);
    await fallback.operations.readRoomMessagesAround({ roomId: "room-a", messageId: "1" });
    expect(fallback.getRoomMessagesAround).toHaveBeenCalledTimes(1);
    for (const policy of modes.slice(2)) {
      const protectedFixture = fixture(policy);
      await expect(protectedFixture.operations.readRoomMessagesAround({ roomId: "room-a", messageId: "1" }))
        .rejects.toThrow("waiting for device encryption access");
      expect(protectedFixture.getRoomMessagesAround).not.toHaveBeenCalled();
    }
  });

  test("Strict around-message sends trusted intent and reconciles the additive sidecar", async () => {
    const policy = modes[2]!;
    const owner = bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy, revalidationToken: 1 }), revalidate: async () => {},
    } });
    const getRoomMessagesAround = mock(async (options: Record<string, unknown>) => ({
      messages: [{ id: "1", role: "user", content: "ordinary", createdAt: "2026-09-08T00:00:00Z" }],
      target: { messageId: "1", createdAt: "2026-09-08T00:00:00Z" }, includedToolCallCompanion: false,
      hasOlder: false, hasNewer: false, shadowEncryption: {
        responseVersion: 1,
        status: "ineligible",
        selectedCount: 1,
        eligibleCount: 0,
      }, options,
    }));
    const operations = createRoomMessageOperations({
      owner,
      api: { getOlderRoomMessages: mock(async () => ({ messages: [], pageInfo: { hasMoreBefore: false, oldestCursor: null } })) },
      around: { getRoomMessagesAround: getRoomMessagesAround as never },
      ordinarySend: mock(async () => ({ messageId: 1, jobId: null })),
      historyReader: {
        createIntent: () => ({ requestVersion: 1, clientRequestKey: "around-read" }),
        reconcile: async ({ messages }) => messages.map((message) => ({ ...message, content: "verified" })),
      },
    });
    const page = await operations.readRoomMessagesAround({ roomId: "room-a", messageId: "1" });
    expect(page.messages[0]?.content).toBe("verified");
    expect(getRoomMessagesAround.mock.calls[0]?.[0]).toMatchObject({
      shadowRead: { requestVersion: 1, clientRequestKey: "around-read" },
    });
  });
});
