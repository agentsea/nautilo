import { describe, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ProtectedMessageStructuralProjectionV2, ServerEvent } from "@nautilo/types";
import { reconcileCanonicalHumanMessage } from "./message-new-reconciliation";
import { readPendingFullHumanMessage, reconcileVerifiedFullHumanMessage, takePendingFullHumanEvents } from "./full-human-message-reconciliation";
import { reconcileRoomHistoryShadowPayloads, type RoomHistoryShadowReadAdapter } from "./session-rehydrate";
import type { RoomHistoryShadowReadResponseV1 } from "@nautilo/api-client/browser";

const projection: ProtectedMessageStructuralProjectionV2 = {
  messageId: "42", sessionId: "session", roomId: "room", namespaceId: "namespace",
  sourceUserId: "sender", role: "user", createdAt: "2026-09-07T07:38:01.000Z",
  editRevision: 0, replyToMessageId: "41",
};
const receive = (messages: readonly ThreadMessageLike[], viewer = "recipient") =>
  reconcileVerifiedFullHumanMessage(messages, projection, "opened on device", "turn:full", viewer);

describe("Full Human realtime insertion", () => {
  test("inserts a remote verified message without a plaintext message.new", () => {
    expect(receive([])).toMatchObject([{
      id: "42", role: "user", content: [{ type: "text", text: "opened on device" }],
      metadata: { custom: { sourceUserId: "sender", logicalMessageKey: "turn:full",
        sentAt: projection.createdAt,
        humanMessageVerification: "verified", editRevision: 0, replyToMessageId: 41 } },
    }]);
  });

  test("duplicate encrypted events and subsequent history retain one message", () => {
    const live = receive(receive([]));
    const history = reconcileCanonicalHumanMessage(live, {
      messageId: "42", sourceUserId: "sender", content: "opened on device",
      logicalMessageKey: "turn:full", editRevision: 0,
    }, "recipient");
    expect(receive(history)).toHaveLength(1);
    expect(receive(history)[0]?.content).toEqual([{ type: "text", text: "opened on device" }]);
  });

  test("a preloaded history row is updated, not appended", () => {
    const loaded = reconcileCanonicalHumanMessage([], {
      messageId: "42", sourceUserId: "sender", content: "opened on device", editRevision: 0,
    }, "recipient");
    expect(receive(loaded)).toHaveLength(1);
  });

  test("reconciles the sender's optimistic bubble but never another user's draft", () => {
    const optimistic: ThreadMessageLike = { id: "user-local", role: "user",
      content: [{ type: "text", text: "opened on device" }] };
    expect(receive([optimistic], "sender")).toHaveLength(1);
    expect(receive([optimistic], "sender")[0]?.id).toBe("42");
    expect(receive([optimistic], "recipient")).toHaveLength(2);
  });

  test("a delayed original event cannot overwrite an edited message", () => {
    const edited = reconcileVerifiedFullHumanMessage([], { ...projection, editRevision: 2 },
      "newer edit", "turn:full", "recipient");
    expect(receive(edited)).toBe(edited);
  });

  test("missing sender identity and non-Human projections are not invented", () => {
    const empty: readonly ThreadMessageLike[] = [];
    const { sourceUserId: _sourceUserId, ...withoutSender } = projection;
    expect(reconcileVerifiedFullHumanMessage(empty, withoutSender,
      "opened", "turn:full", "recipient")).toBe(empty);
    expect(reconcileVerifiedFullHumanMessage(empty, { ...projection, role: "assistant" },
      "opened", "turn:full", "recipient")).toBe(empty);
  });
});

type HumanEvent = Extract<ServerEvent, { type: "message.human_peer_shadow" | "message.shared_agent_shadow" }>;
function pendingEvent(key: string, keyClass: "human" | "ai", namespaceId = "namespace"): HumanEvent {
  return {
    type: keyClass === "human" ? "message.human_peer_shadow" : "message.shared_agent_shadow",
    wireVersion: 2, laneKey: "room:room", operationId: key, policyRevision: 1,
    transcriptOrdinal: 1, logicalMessageKey: key, planBytesBase64url: "AA",
    requestBytesBase64url: "AA", protectedMessageDigestBase64url: "AA",
    senderDeviceSigningPublicKeyBase64url: "AA", durableEventDigestBase64url: "AA",
    protectedMessage: { dtoVersion: 2, projection: { ...projection, namespaceId },
      protectedPayload: { status: "encrypted", cryptoObjectId: key, payloadVersion: 2,
        keyClass, encryptedPayloadBytesBase64url: "AA", accessManifestBytesBase64url: "AA",
        namespaceEnvelopeBytesBase64url: "AA" } },
  };
}

test("key delivery drains only matching Full events and never twice", () => {
  const human = pendingEvent("human", "human");
  const ai = pendingEvent("ai", "ai");
  const other = pendingEvent("other", "human", "other-namespace");
  const pending = new Map([human, ai, other].map(event => [event.logicalMessageKey, event]));
  expect(takePendingFullHumanEvents(pending, { namespaceId: "namespace", keyClass: "human" })).toEqual([human]);
  expect(takePendingFullHumanEvents(pending, { namespaceId: "namespace", keyClass: "human" })).toEqual([]);
  expect([...pending.values()]).toEqual([ai, other]);
  expect(takePendingFullHumanEvents(pending, { namespaceId: "namespace", keyClass: "ai" })).toEqual([ai]);
});

describe("delayed Full receive uses current durable history, not expired live authorization", () => {
  const event = pendingEvent("human", "human");
  const coordinate = { sessionId: projection.sessionId, messageId: 42,
    editRevision: 0, role: "user", logicalMessageKey: "human" };
  // Crypto evidence is interpreted by the real reader, not this selection adapter.
  const sidecar = { status: "ready", selectedCoordinates: [coordinate],
    records: [{ coordinate, representationMode: "protected-only" }] } as RoomHistoryShadowReadResponseV1;
  const reader: RoomHistoryShadowReadAdapter = {
    createIntent: () => ({ requestVersion: 1, clientRequestKey: "read-now" }),
    reconcile: async ({ messages, requireVerified }) => {
      expect(requireVerified).toBe(true);
      expect(messages[0]?.content).toBe("");
      return reconcileRoomHistoryShadowPayloads(messages, [{ messageId: "42", editRevision: 0,
        status: "verified", payload: { role: "user", content: "durably opened" } }], { requireVerified });
    },
  };
  test("opens the exact saved encrypted message after send-request expiry", async () => {
    // No live receive/send request is called: the event's old createdAt is irrelevant.
    expect(await readPendingFullHumanMessage({ event, reader, loadSidecar: async () => sidecar }))
      .toMatchObject({ id: "42", role: "user", content: "durably opened", sourceUserId: "sender" });
  });
  test("rejects unavailable, ordinary, and wrong-coordinate sidecars", async () => {
    for (const value of [
      { status: "unavailable" },
      { ...sidecar, records: [{ coordinate, representationMode: "shadow" }] },
      { ...sidecar, selectedCoordinates: [{ ...coordinate, messageId: 43 }] },
    ]) {
      await expect(readPendingFullHumanMessage({ event, reader,
        loadSidecar: async () => value as RoomHistoryShadowReadResponseV1 })).rejects.toThrow();
    }
  });
  test("requires a verified result; strict placeholders are not successful opens", () => {
    const messages = [{ id: "42", role: "user", content: "", editRevision: 0 }];
    const verified = { messageId: "42", editRevision: 0, status: "verified" as const,
      payload: { role: "user" as const, content: "opened" } };
    for (const results of [[], [{ messageId: "42", editRevision: 0, status: "fallback" as const }],
      [verified, verified], [{ ...verified, messageId: "43" }],
      [{ ...verified, editRevision: 1 }],
      [{ ...verified, payload: { role: "assistant" as const, content: "wrong role" } }]]) {
      expect(() => reconcileRoomHistoryShadowPayloads(messages, results,
        { strict: true, requireVerified: true })).toThrow("Protected history verification unavailable");
    }
  });
});
