import { describe, expect, test } from "bun:test";
import {
  PROTECTED_MESSAGE_DTO_VERSION_V2,
  PROTECTED_MESSAGE_MAX_NAMESPACE_ENVELOPE_BYTES_V2,
  decodeProtectedMessageDtoV2,
  encodeProtectedMessageDtoV2,
  parseProtectedMessageDtoV2,
  type ProtectedMessageDtoV2,
} from "../../src/index.ts";

function projection() {
  return {
    messageId: "42",
    logicalMessageKey: "turn-01",
    sessionId: "cba3922d-53fc-4933-be03-7ac3a56cffd1",
    roomId: "1ed80d8a-2bd2-4936-a587-1d0242788973",
    namespaceId: "c72d63f4-061d-41eb-8ed4-67ccbdbd49ea",
    role: "assistant" as const,
    createdAt: "2026-08-03T10:20:30.000Z",
    editedAt: null,
    editRevision: 0,
    replyToMessageId: null,
    subthreadRoomId: null,
    replyCount: 0,
    lastReplyAt: null,
    summaryRevision: 0,
    deliveredAt: null,
    readAt: null,
    authorAgentId: "e645a07e-745c-48f3-883e-938153c4390a",
  };
}

function encryptedDto(): ProtectedMessageDtoV2 {
  return {
    dtoVersion: PROTECTED_MESSAGE_DTO_VERSION_V2,
    projection: projection(),
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

describe("protected message browser wire DTO", () => {
  test("round-trips a strict versioned encrypted outcome canonically", () => {
    const dto = encryptedDto();
    const wire = encodeProtectedMessageDtoV2(dto);

    expect(wire).toStartWith(`{"dtoVersion":2,"projection":`);
    expect(decodeProtectedMessageDtoV2(wire)).toEqual(dto);
  });

  test.each([
    {
      dtoVersion: 2 as const,
      projection: projection(),
      protectedPayload: {
        status: "pending" as const,
        reason: "shadow_pending" as const,
      },
    },
    {
      dtoVersion: 2 as const,
      projection: projection(),
      protectedPayload: {
        status: "unavailable" as const,
        reason: "missing_grant" as const,
        cryptoObjectId: "message-object-42",
      },
    },
    {
      dtoVersion: 2 as const,
      projection: projection(),
      protectedPayload: {
        status: "unavailable" as const,
        reason: "corrupt" as const,
        cryptoObjectId: "message-object-42",
      },
    },
  ])("accepts the $protectedPayload.status outcome", (dto) => {
    expect(parseProtectedMessageDtoV2(dto)).toEqual(dto);
  });

  test("rejects plaintext, unknown fields, unsupported versions, and padded base64", () => {
    const withPlaintext = {
      ...encryptedDto(),
      projection: { ...projection(), content: "must not cross the wire" },
    };
    expect(() => parseProtectedMessageDtoV2(withPlaintext)).toThrow();
    expect(() =>
      parseProtectedMessageDtoV2({ ...encryptedDto(), extra: true })
    ).toThrow();
    expect(() =>
      parseProtectedMessageDtoV2({ ...encryptedDto(), dtoVersion: 3 })
    ).toThrow();
    expect(() =>
      parseProtectedMessageDtoV2({
        ...encryptedDto(),
        protectedPayload: {
          ...encryptedDto().protectedPayload,
          encryptedPayloadBytesBase64url: "AQIDBA==",
        },
      })
    ).toThrow();
    expect(() =>
      parseProtectedMessageDtoV2({
        ...encryptedDto(),
        protectedPayload: {
          ...encryptedDto().protectedPayload,
          encryptedPayloadBytesBase64url: "AB",
        },
      })
    ).toThrow(/canonically encoded/i);
  });

  test.each([
    ["messageId", "01"],
    ["replyToMessageId", "0"],
    ["sessionId", "not-a-session-uuid"],
    ["roomId", "1ED80D8A-2BD2-4936-A587-1D0242788973"],
    ["namespaceId", "not-a-namespace-uuid"],
    ["subthreadRoomId", "not-a-room-uuid"],
    ["sourceUserId", "not-a-user-uuid"],
    ["authorAgentId", "not-an-agent-uuid"],
  ] as const)("rejects a noncanonical %s identity", (field, value) => {
    expect(() =>
      parseProtectedMessageDtoV2({
        ...encryptedDto(),
        projection: {
          ...projection(),
          [field]: value,
        },
      })
    ).toThrow();
  });

  test.each([
    ["2147483647", true],
    ["2147483648", false],
  ] as const)("bounds serial identity %s", (messageId, accepted) => {
    const parse = () =>
      parseProtectedMessageDtoV2({
        ...encryptedDto(),
        projection: { ...projection(), messageId },
      });
    if (accepted) {
      expect(parse().projection.messageId).toBe(messageId);
    } else {
      expect(parse).toThrow();
    }
  });

  test("rejects a huge decimal identity before numeric conversion", () => {
    expect(() =>
      parseProtectedMessageDtoV2({
        ...encryptedDto(),
        projection: {
          ...projection(),
          messageId: "9".repeat(100_000),
        },
      })
    ).toThrow();
  });

  test("keeps the namespace-envelope DTO limit aligned with storage", () => {
    expect(PROTECTED_MESSAGE_MAX_NAMESPACE_ENVELOPE_BYTES_V2).toBe(1_048_576);
    const oversizedEnvelopeBytes = new Uint8Array(
      PROTECTED_MESSAGE_MAX_NAMESPACE_ENVELOPE_BYTES_V2 + 1,
    );
    const oversizedEnvelope = Buffer.from(oversizedEnvelopeBytes)
      .toString("base64url");

    expect(() =>
      parseProtectedMessageDtoV2({
        ...encryptedDto(),
        protectedPayload: {
          ...encryptedDto().protectedPayload,
          namespaceEnvelopeBytesBase64url: oversizedEnvelope,
        },
      })
    ).toThrow(/wire limit/i);
  });

  test("rejects non-canonical JSON and duplicate keys at the byte codec", () => {
    const canonical = encodeProtectedMessageDtoV2(encryptedDto());
    expect(() =>
      decodeProtectedMessageDtoV2(canonical.replace(
        `"dtoVersion":2`,
        `"dtoVersion":2, "dtoVersion":2`,
      ))
    ).toThrow(/canonical/i);
  });

  test.each([
    "stale_grant",
    "unauthorized",
    "removed",
    "unsupported_version",
    "corrupt",
    "lost_key_material",
  ] as const)("keeps %s as a typed fail-closed outcome", (reason) => {
    const dto: ProtectedMessageDtoV2 = {
      dtoVersion: 2,
      projection: projection(),
      protectedPayload: {
        status: "unavailable",
        reason,
        cryptoObjectId: "message-object-42",
      },
    };
    expect(decodeProtectedMessageDtoV2(
      encodeProtectedMessageDtoV2(dto),
    )).toEqual(dto);
  });
});
