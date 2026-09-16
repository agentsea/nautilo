import { describe, expect, test } from "bun:test";

import {
  decodeProtectedMessageRealtimeEventV2,
  encodeProtectedMessageRealtimeEventV2,
  isProtectedMessageRealtimeEventV2,
  parseProtectedMessageRealtimeEventV2,
  type ProtectedMessageDtoV2,
  type ProtectedMessageRealtimeEventV2,
  type ServerEvent,
} from "../../src/index.ts";

const ROOM_ID = "1ed80d8a-2bd2-4936-a587-1d0242788973";

function message(
  overrides: Partial<ProtectedMessageDtoV2["projection"]> = {},
): ProtectedMessageDtoV2 {
  return {
    dtoVersion: 2,
    projection: {
      messageId: "42",
      logicalMessageKey: "turn-01",
      sessionId: "cba3922d-53fc-4933-be03-7ac3a56cffd1",
      roomId: ROOM_ID,
      namespaceId: "c72d63f4-061d-41eb-8ed4-67ccbdbd49ea",
      role: "assistant",
      createdAt: "2026-08-03T10:20:30.000Z",
      editedAt: null,
      editRevision: 0,
      replyToMessageId: null,
      subthreadRoomId: null,
      authorAgentId: "e645a07e-745c-48f3-883e-938153c4390a",
      ...overrides,
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
  };
}

describe("protected message realtime wire v2", () => {
  test("extends ServerEvent without weakening the legacy plaintext event contract", () => {
    const legacy: ServerEvent = {
      type: "message.new",
      laneKey: `room:${ROOM_ID}`,
      messageId: "42",
      role: "ai",
      content: "legacy content remains required on the legacy variant",
    };
    expect(legacy.content).toBe(
      "legacy content remains required on the legacy variant",
    );
    expect(isProtectedMessageRealtimeEventV2(legacy)).toBe(false);
  });

  test("suppresses protected token content and round-trips canonically", () => {
    const event: ProtectedMessageRealtimeEventV2 = {
      wireVersion: 2,
      type: "message.tokens",
      protection: "protected",
      laneKey: `room:${ROOM_ID}`,
      streaming: "suppressed",
      done: true,
      turnId: "turn-01",
      authorAgentId: "e645a07e-745c-48f3-883e-938153c4390a",
    };

    const wire = encodeProtectedMessageRealtimeEventV2(event);
    const serverEvent: ServerEvent = event;
    expect(isProtectedMessageRealtimeEventV2(serverEvent)).toBe(true);
    expect(serverEvent.protection).toBe("protected");
    expect(wire).not.toContain("content");
    expect(decodeProtectedMessageRealtimeEventV2(wire)).toEqual(event);
    expect(() =>
      parseProtectedMessageRealtimeEventV2({
        ...event,
        content: "plaintext must never cross this event",
      })
    ).toThrow();
    expect(() =>
      parseProtectedMessageRealtimeEventV2({
        ...event,
        done: false,
      })
    ).toThrow();
  });

  test.each([
    {
      wireVersion: 2 as const,
      type: "message.new" as const,
      protection: "protected" as const,
      laneKey: `room:${ROOM_ID}`,
      message: message(),
    },
    {
      wireVersion: 2 as const,
      type: "message.updated" as const,
      protection: "protected" as const,
      laneKey: `room:${ROOM_ID}`,
      logicalMessageKey: "turn-01",
      editRevision: 2,
      message: message({
        editedAt: "2026-08-03T10:21:30.000Z",
        editRevision: 2,
      }),
    },
  ])("round-trips a strict protected $type event", (event) => {
    const serverEvent: ServerEvent = event;
    const wire = encodeProtectedMessageRealtimeEventV2(event);
    expect(serverEvent.protection).toBe("protected");
    expect(decodeProtectedMessageRealtimeEventV2(wire)).toEqual(event);
    expect(() =>
      parseProtectedMessageRealtimeEventV2({
        ...event,
        content: "plaintext must never cross this event",
      })
    ).toThrow();
  });

  test("binds the lane, logical key, and revision to the protected DTO", () => {
    const created = {
      wireVersion: 2,
      type: "message.new",
      protection: "protected",
      laneKey: `room:${ROOM_ID}`,
      message: message(),
    } as const;
    expect(() =>
      parseProtectedMessageRealtimeEventV2({
        ...created,
        laneKey: "room:00000000-0000-0000-0000-000000000000",
      })
    ).toThrow(/lane/i);

    const updated = {
      wireVersion: 2,
      type: "message.updated",
      protection: "protected",
      laneKey: `room:${ROOM_ID}`,
      logicalMessageKey: "turn-01",
      editRevision: 2,
      message: message({
        editedAt: "2026-08-03T10:21:30.000Z",
        editRevision: 2,
      }),
    } as const;
    expect(() =>
      parseProtectedMessageRealtimeEventV2({
        ...updated,
        logicalMessageKey: "turn-other",
      })
    ).toThrow(/logical/i);
    expect(() =>
      parseProtectedMessageRealtimeEventV2({
        ...updated,
        editRevision: 3,
      })
    ).toThrow(/revision/i);
    expect(() =>
      parseProtectedMessageRealtimeEventV2({
        ...updated,
        message: message({ editedAt: null, editRevision: 2 }),
      })
    ).toThrow(/edited/i);
  });

  test("rejects unknown versions, fields, noncanonical JSON, and huge wire input", () => {
    const event = {
      wireVersion: 2,
      type: "message.new",
      protection: "protected",
      laneKey: `room:${ROOM_ID}`,
      message: message(),
    } as const;
    expect(() =>
      parseProtectedMessageRealtimeEventV2({
        ...event,
        wireVersion: 3,
      })
    ).toThrow();
    expect(() =>
      parseProtectedMessageRealtimeEventV2({
        ...event,
        extra: true,
      })
    ).toThrow();

    const canonical = encodeProtectedMessageRealtimeEventV2(event);
    expect(() =>
      decodeProtectedMessageRealtimeEventV2(
        canonical.replace(`"wireVersion":2`, `"wireVersion":2, `),
      )
    ).toThrow();
    expect(() =>
      decodeProtectedMessageRealtimeEventV2(" ".repeat(4_400_000))
    ).toThrow(/bounds/i);
  });
});
