import { expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { RoomHistoryShadowReadAdapter } from "./session-rehydrate";
import { mergeProtectedMessageUpdate, readProtectedMessageUpdate, type ProtectedMessageUpdate } from "./protected-message-update";

const event: ProtectedMessageUpdate = {
  wireVersion: 2, type: "message.updated", protection: "protected", laneKey: "room:room",
  logicalMessageKey: "logical", editRevision: 2,
  message: {
    dtoVersion: 2,
    projection: {
      messageId: "1", logicalMessageKey: "logical", sessionId: "session", roomId: "room",
      namespaceId: "namespace", role: "user", editRevision: 2,
      createdAt: "2026-09-06T00:00:00.000Z", editedAt: "2026-09-06T00:01:00.000Z",
    },
    protectedPayload: { status: "pending", reason: "shadow_pending" },
  },
};

test("exact protected edit delegates to the history reader and never supplies ordinary content", async () => {
  const reader: RoomHistoryShadowReadAdapter = {
    createIntent: () => ({ requestVersion: 1, clientRequestKey: "request" }),
    reconcile: async ({ roomId, messages, requireVerified }) => {
      expect(roomId).toBe("room");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe("Encrypted history is unavailable on this device.");
      expect(requireVerified).toBe(true);
      return messages.map((message) => ({ ...message, content: "decrypted edit" }));
    },
  };
  const updated = await readProtectedMessageUpdate({
    event, reader, loadSidecar: async () => ({ status: "ready" }) as never,
  });
  expect(updated.content).toBe("decrypted edit");
  await expect(readProtectedMessageUpdate({
    event, reader, loadSidecar: async () => ({ status: "disabled" }) as never,
  })).rejects.toThrow("unavailable");
  await expect(readProtectedMessageUpdate({
    event, reader: { ...reader, reconcile: async ({ messages }) => messages.map((message) => ({ ...message, editRevision: 3 })) },
    loadSidecar: async () => ({ status: "ready" }) as never,
  })).rejects.toThrow("coordinates changed");
  await expect(readProtectedMessageUpdate({
    event,
    reader: { ...reader, reconcile: async ({ messages }) => messages },
    loadSidecar: async () => ({ status: "ready" }) as never,
  })).rejects.toThrow("coordinates changed");
});

test("edit refresh changes only older logical siblings, retaining other rows and metadata", () => {
  const old: ThreadMessageLike = {
    id: "7", role: "user", content: "old",
    metadata: { custom: { logicalMessageKey: "logical", editRevision: 1, reactions: ["heart"] } },
  };
  const stream: ThreadMessageLike = { id: "stream", role: "assistant", content: "streaming" };
  const updated = { id: "1", role: "user", logicalMessageKey: "logical", editRevision: 2, content: "new" };
  const result = mergeProtectedMessageUpdate([old, stream], updated);
  expect(result[0]?.content).toEqual([{ type: "text", text: "new" }]);
  expect(result[0]?.id).toBe("7");
  expect(result[0]?.metadata?.custom?.reactions).toEqual(["heart"]);
  expect(result[1]).toBe(stream);
  expect(mergeProtectedMessageUpdate(result, { ...updated, content: "stale replay" })).toBe(result);
  expect(mergeProtectedMessageUpdate(result, { ...updated, logicalMessageKey: "other", editRevision: 3 })).toBe(result);
});
