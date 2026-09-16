import { describe, expect, test } from "bun:test";
import type {
  ProtectedMessageDtoV2,
  ProtectedMessageRealtimeEventV2,
} from "@nautilo/types";

import {
  hydrateProtectedRoomMessagesV2,
  PROTECTED_WORKBENCH_MAX_HYDRATION_ROWS_V2,
  reconcileProtectedRoomEventV2,
  type AuthorizedClientMessageDecryptPortV2,
  type ProtectedRoomMessageStateV2,
} from "./protected-message-hydration";

const ROOM_ID = "1ed80d8a-2bd2-4936-a587-1d0242788973";
const OTHER_ROOM_ID = "00000000-0000-0000-0000-000000000001";
const SESSION_ID = "cba3922d-53fc-4933-be03-7ac3a56cffd1";
const NAMESPACE_ID = "c72d63f4-061d-41eb-8ed4-67ccbdbd49ea";
const OTHER_NAMESPACE_ID = "00000000-0000-0000-0000-000000000002";

function encryptedMessage(
  overrides: Partial<ProtectedMessageDtoV2["projection"]> = {},
  encryptedPayloadBytesBase64url = "AQIDBA",
): ProtectedMessageDtoV2 {
  return {
    dtoVersion: 2,
    projection: {
      messageId: "42",
      logicalMessageKey: "turn-01",
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      role: "assistant",
      createdAt: "2026-08-03T10:20:30.000Z",
      editedAt: null,
      editRevision: 0,
      ...overrides,
    },
    protectedPayload: {
      status: "encrypted",
      cryptoObjectId: "message-object-42",
      payloadVersion: 2,
      keyClass: "ai",
      encryptedPayloadBytesBase64url,
      accessManifestBytesBase64url: "BQYHCA",
      namespaceEnvelopeBytesBase64url: "CQoLDA",
    },
  };
}

function decrypting(
  contentByObject: Readonly<Record<string, string>> = {
    "message-object-42": "decrypted assistant text",
  },
): AuthorizedClientMessageDecryptPortV2 {
  return {
    open: (message) => ({
      status: "opened",
      payloadVersion: 2,
      role: message.projection.role,
      content: contentByObject[message.protectedPayload.cryptoObjectId] ?? "",
    }),
  };
}

function event(
  message: ProtectedMessageDtoV2,
  type: "message.new" | "message.updated" = "message.new",
): ProtectedMessageRealtimeEventV2 {
  if (type === "message.updated") {
    return {
      wireVersion: 2,
      type,
      protection: "protected",
      laneKey: `room:${ROOM_ID}`,
      logicalMessageKey: message.projection.logicalMessageKey!,
      editRevision: message.projection.editRevision,
      message,
    };
  }
  return {
    wireVersion: 2,
    type,
    protection: "protected",
    laneKey: `room:${ROOM_ID}`,
    message,
  };
}

describe("protected Workbench message hydration", () => {
  test("decrypts locally through the injected browser port", async () => {
    const calls: string[] = [];
    const result = await hydrateProtectedRoomMessagesV2({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: [encryptedMessage()],
      decrypt: {
        open: (message) => {
          calls.push(message.protectedPayload.cryptoObjectId);
          return {
            status: "opened",
            payloadVersion: 2,
            role: "assistant",
            content: "locally opened",
          };
        },
      },
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready");
    expect(calls).toEqual(["message-object-42"]);
    expect(result.state.messages[0]?.content).toEqual({
      kind: "opened",
      text: "locally opened",
    });
  });

  test.each([
    [
      { status: "pending", reason: "shadow_pending" },
      { kind: "placeholder", placeholder: "pending", reason: "shadow_pending" },
    ],
    [
      { status: "pending", reason: "backfill_pending" },
      {
        kind: "placeholder",
        placeholder: "pending",
        reason: "backfill_pending",
      },
    ],
    [
      { status: "unavailable", reason: "missing_grant" },
      { kind: "placeholder", placeholder: "locked", reason: "missing_grant" },
    ],
    [
      { status: "unavailable", reason: "stale_grant" },
      { kind: "placeholder", placeholder: "locked", reason: "stale_grant" },
    ],
    [
      { status: "unavailable", reason: "unauthorized" },
      { kind: "placeholder", placeholder: "locked", reason: "unauthorized" },
    ],
    [
      { status: "unavailable", reason: "removed" },
      { kind: "placeholder", placeholder: "locked", reason: "removed" },
    ],
    [
      { status: "unavailable", reason: "unsupported_version" },
      {
        kind: "placeholder",
        placeholder: "unsupported",
        reason: "unsupported_version",
      },
    ],
    [
      { status: "unavailable", reason: "corrupt" },
      { kind: "placeholder", placeholder: "corrupt", reason: "corrupt" },
    ],
    [
      { status: "unavailable", reason: "lost_key_material" },
      {
        kind: "placeholder",
        placeholder: "lost-key",
        reason: "lost_key_material",
      },
    ],
  ] as const)("renders a typed fail-closed placeholder for %j", async (
    protectedPayload,
    expected,
  ) => {
    const dto = {
      ...encryptedMessage(),
      protectedPayload,
    } as ProtectedMessageDtoV2;
    const result = await hydrateProtectedRoomMessagesV2({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: [dto],
      decrypt: { open: () => {
        throw new Error("unavailable rows must not enter decryption");
      } },
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.state.messages[0]?.content).toEqual(expected);
  });

  test("turns decrypt rejection and malformed output into corrupt placeholders", async () => {
    const thrown = await hydrateProtectedRoomMessagesV2({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: [encryptedMessage()],
      decrypt: { open: () => Promise.reject(new Error("authentication failed")) },
    });
    expect(thrown.status).toBe("ready");
    if (thrown.status !== "ready") throw new Error("expected ready");
    expect(thrown.state.messages[0]?.content).toEqual({
      kind: "placeholder",
      placeholder: "corrupt",
      reason: "corrupt",
    });

    const malformed = await hydrateProtectedRoomMessagesV2({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: [encryptedMessage()],
      decrypt: { open: () => ({
        status: "opened",
        payloadVersion: 2,
        role: "assistant",
        content: "plaintext",
        serverFallback: "forbidden",
      }) },
    });
    expect(malformed.status).toBe("ready");
    if (malformed.status !== "ready") throw new Error("expected ready");
    expect(malformed.state.messages[0]?.content).toEqual({
      kind: "placeholder",
      placeholder: "corrupt",
      reason: "corrupt",
    });

    const substitutedRole = await hydrateProtectedRoomMessagesV2({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: [encryptedMessage()],
      decrypt: { open: () => ({
        status: "opened",
        payloadVersion: 2,
        role: "user",
        content: "wrong principal projection",
      }) },
    });
    expect(substitutedRole.status).toBe("ready");
    if (substitutedRole.status !== "ready") throw new Error("expected ready");
    expect(substitutedRole.state.messages[0]?.content).toEqual({
      kind: "placeholder",
      placeholder: "corrupt",
      reason: "corrupt",
    });
  });

  test("fails closed for malformed, wrong-Room, or wrong-Namespace history", async () => {
    for (const message of [
      { ...encryptedMessage(), plaintext: "forbidden fallback" },
      encryptedMessage({ roomId: OTHER_ROOM_ID }),
      encryptedMessage({ namespaceId: OTHER_NAMESPACE_ID }),
      encryptedMessage({ editRevision: 2, editedAt: null }),
    ]) {
      const result = await hydrateProtectedRoomMessagesV2({
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        messages: [message],
        decrypt: decrypting(),
      });
      expect(result).toEqual({ status: "rejected", reason: "corrupt" });
      expect(JSON.stringify(result)).not.toContain("forbidden fallback");
    }
  });

  test("deduplicates catch-up rows and keeps only the highest revision", async () => {
    const old = encryptedMessage();
    const revised = encryptedMessage(
      { editedAt: "2026-08-03T10:21:30.000Z", editRevision: 2 },
      "ERITFA",
    );
    const result = await hydrateProtectedRoomMessagesV2({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: [revised, old, revised],
      decrypt: decrypting({ "message-object-42": "latest" }),
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.state.messages).toHaveLength(1);
    expect(result.state.messages[0]?.editRevision).toBe(2);
    expect(result.state.messages[0]?.content).toEqual({
      kind: "opened",
      text: "latest",
    });
  });

  test("rejects conflicting rows at the same identity and revision", async () => {
    const result = await hydrateProtectedRoomMessagesV2({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: [encryptedMessage(), encryptedMessage({}, "ERITFA")],
      decrypt: decrypting(),
    });
    expect(result).toEqual({ status: "rejected", reason: "corrupt" });
  });

  test("rejects one physical message id claimed by different logical turns", async () => {
    const result = await hydrateProtectedRoomMessagesV2({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: [
        encryptedMessage(),
        encryptedMessage({ logicalMessageKey: "turn-substituted" }),
      ],
      decrypt: decrypting(),
    });
    expect(result).toEqual({ status: "rejected", reason: "corrupt" });
  });

  test("rejects an unbounded hydration batch before attempting decryption", async () => {
    let opened = false;
    const result = await hydrateProtectedRoomMessagesV2({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: Array.from(
        { length: PROTECTED_WORKBENCH_MAX_HYDRATION_ROWS_V2 + 1 },
        () => encryptedMessage(),
      ),
      decrypt: { open: () => {
        opened = true;
        return {
          status: "opened",
          payloadVersion: 2,
          role: "assistant",
          content: "must not open",
        };
      } },
    });
    expect(result).toEqual({ status: "rejected", reason: "corrupt" });
    expect(opened).toBe(false);
  });
});

describe("protected Workbench realtime reconciliation", () => {
  async function state(): Promise<ProtectedRoomMessageStateV2> {
    const result = await hydrateProtectedRoomMessagesV2({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: [encryptedMessage()],
      decrypt: decrypting(),
    });
    if (result.status !== "ready") throw new Error("expected ready");
    return result.state;
  }

  test("suppressed tokens are a strict no-op and cannot create content", async () => {
    const initial: ProtectedRoomMessageStateV2 = {
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: [],
    };
    const result = await reconcileProtectedRoomEventV2({
      state: initial,
      event: {
        wireVersion: 2,
        type: "message.tokens",
        protection: "protected",
        laneKey: `room:${ROOM_ID}`,
        streaming: "suppressed",
        done: true,
        turnId: "turn-01",
      },
      decrypt: decrypting(),
    });
    expect(result).toEqual({ status: "ignored", state: initial });
  });

  test("applies a newer edit, ignores duplicate and out-of-order revisions, and survives reconnect catch-up", async () => {
    const initial = await state();
    const revised = encryptedMessage(
      { editedAt: "2026-08-03T10:21:30.000Z", editRevision: 2 },
      "ERITFA",
    );
    const applied = await reconcileProtectedRoomEventV2({
      state: initial,
      event: event(revised, "message.updated"),
      decrypt: decrypting({ "message-object-42": "edited locally" }),
    });
    expect(applied.status).toBe("applied");
    expect(applied.state.messages[0]?.editRevision).toBe(2);

    const duplicate = await reconcileProtectedRoomEventV2({
      state: applied.state,
      event: event(revised, "message.updated"),
      decrypt: { open: () => {
        throw new Error("dedupe must happen before decrypt");
      } },
    });
    expect(duplicate).toEqual({ status: "ignored", state: applied.state });

    const stale = await reconcileProtectedRoomEventV2({
      state: applied.state,
      event: event(encryptedMessage(), "message.new"),
      decrypt: decrypting(),
    });
    expect(stale).toEqual({ status: "ignored", state: applied.state });

    const caughtUp = await hydrateProtectedRoomMessagesV2({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      messages: [encryptedMessage(), revised],
      decrypt: decrypting({ "message-object-42": "edited locally" }),
    });
    expect(caughtUp.status).toBe("ready");
    if (caughtUp.status !== "ready") throw new Error("expected ready");
    expect(caughtUp.state.messages).toEqual(applied.state.messages);
  });

  test("rejects malformed and coordinate tampering without mutation", async () => {
    const initial = await state();
    const revised = encryptedMessage({
      editedAt: "2026-08-03T10:21:30.000Z",
      editRevision: 2,
    });
    const valid = event(revised, "message.updated");
    const attempts: unknown[] = [
      { ...valid, plaintext: "forbidden" },
      { ...valid, laneKey: `room:${OTHER_ROOM_ID}` },
      { ...valid, logicalMessageKey: "turn-tampered" },
      { ...valid, editRevision: 3 },
      event({
        ...revised,
        projection: { ...revised.projection, sessionId: OTHER_ROOM_ID },
      }, "message.updated"),
      event({
        ...revised,
        projection: {
          ...revised.projection,
          authorAgentId: "00000000-0000-0000-0000-000000000003",
        },
      }, "message.updated"),
    ];

    for (const candidate of attempts) {
      const result = await reconcileProtectedRoomEventV2({
        state: initial,
        event: candidate,
        decrypt: decrypting(),
      });
      expect(result).toEqual({
        status: "rejected",
        reason: "corrupt",
        state: initial,
      });
      expect(JSON.stringify(result)).not.toContain("forbidden");
    }
  });

  test("never falls back to plaintext when local opening is unavailable", async () => {
    const initial = await state();
    const revised = encryptedMessage({
      editedAt: "2026-08-03T10:21:30.000Z",
      editRevision: 2,
    });
    const result = await reconcileProtectedRoomEventV2({
      state: initial,
      event: event(revised, "message.updated"),
      decrypt: { open: () => ({
        status: "unavailable",
        reason: "missing_grant",
      }) },
    });
    expect(result.status).toBe("applied");
    expect(result.state.messages[0]?.content).toEqual({
      kind: "placeholder",
      placeholder: "locked",
      reason: "missing_grant",
    });
    expect(JSON.stringify(result)).not.toContain("decrypted assistant text");
  });
});
