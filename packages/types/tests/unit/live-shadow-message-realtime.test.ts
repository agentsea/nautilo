import { describe, expect, test } from "bun:test";

import {
  parseFullEncryptionMessageRealtimeContentEventV2,
  parseLiveShadowMessageRealtimeEventV1,
} from "../../src/live-shadow-message-realtime";
import type { ServerEvent } from "../../src/realtime";

const protectedMessage = {
  dtoVersion: 2 as const,
  projection: {
    messageId: "42",
    sessionId: "10000000-0000-4000-8000-000000000318",
    roomId: "20000000-0000-4000-8000-000000000318",
    namespaceId: "30000000-0000-4000-8000-000000000318",
    role: "assistant" as const,
    createdAt: "2027-01-15T08:00:00.000Z",
    editRevision: 0,
  },
  protectedPayload: {
    status: "encrypted" as const,
    cryptoObjectId: "message:full:v2:42",
    payloadVersion: 2 as const,
    keyClass: "ai" as const,
    encryptedPayloadBytesBase64url: "AQ",
    accessManifestBytesBase64url: "Ag",
    namespaceEnvelopeBytesBase64url: "Aw",
  },
};

const common = {
  wireVersion: 2 as const,
  laneKey: "room:20000000-0000-4000-8000-000000000318",
  operationId: "turn:m318",
  transcriptOrdinal: 2,
};

describe("Full encryption realtime content V2", () => {
  test("accepts protected-only stream and durable content events", () => {
    const events = [
      { ...common, type: "message.shadow_stream_start", streamStartBytesBase64url: "AQ" },
      { ...common, type: "message.shadow_stream_frame", frameBytesBase64url: "Ag", done: false },
      { ...common, type: "message.shadow_durable", policyRevision: 8, protectedMessage, durableEventDigestBase64url: "A".repeat(43) },
      { ...common, type: "message.human_peer_shadow", policyRevision: 8, logicalMessageKey: "message:42", planBytesBase64url: "AQ", requestBytesBase64url: "Ag", protectedMessage, protectedMessageDigestBase64url: "B".repeat(43), senderDeviceSigningPublicKeyBase64url: "Aw", durableEventDigestBase64url: "C".repeat(43) },
      { ...common, type: "message.shared_agent_shadow", policyRevision: 8, logicalMessageKey: "message:42", planBytesBase64url: "AQ", requestBytesBase64url: "Ag", protectedMessage, protectedMessageDigestBase64url: "B".repeat(43), senderDeviceSigningPublicKeyBase64url: "Aw", durableEventDigestBase64url: "C".repeat(43) },
      { ...common, type: "message.shared_agent_stream_start", planBytesBase64url: "AQ", streamStartBytesBase64url: "Ag" },
      { ...common, type: "message.shared_agent_stream_frame", frameBytesBase64url: "Ag", done: true },
      { ...common, type: "message.shared_agent_output_shadow", policyRevision: 8, planBytesBase64url: "AQ", protectedMessage, durableEventDigestBase64url: "D".repeat(43) },
    ];
    for (const event of events) {
      const parsed = parseFullEncryptionMessageRealtimeContentEventV2(event);
      const serverEvent: ServerEvent = parsed;
      expect(serverEvent.wireVersion).toBe(2);
      expect(parsed as unknown)
        .toEqual(event);
    }
  });

  test("rejects ordinary fields instead of stripping them", () => {
    expect(() => parseFullEncryptionMessageRealtimeContentEventV2({
      ...common,
      type: "message.shadow_stream_frame",
      ordinaryChunk: "plaintext",
      frameBytesBase64url: "Ag",
      done: false,
    })).toThrow();
    expect(() => parseFullEncryptionMessageRealtimeContentEventV2({
      ...common,
      type: "message.shadow_durable",
      policyRevision: 8,
      ordinaryPayloadBytesBase64url: "cGxhaW50ZXh0",
      protectedMessage,
      durableEventDigestBase64url: "A".repeat(43),
    })).toThrow();
  });

  test("rejects malformed versions and numeric bounds while V1 remains unchanged", () => {
    const full = {
      ...common,
      type: "message.shadow_durable",
      policyRevision: 8,
      protectedMessage,
      durableEventDigestBase64url: "A".repeat(43),
    };
    for (const malformed of [
      { ...full, wireVersion: 1 },
      { ...full, policyRevision: 0 },
      { ...full, transcriptOrdinal: 0 },
      { ...full, transcriptOrdinal: 1.5 },
    ]) {
      expect(() => parseFullEncryptionMessageRealtimeContentEventV2(malformed))
        .toThrow();
    }
    const shadow = {
      ...full,
      wireVersion: 1 as const,
      ordinaryPayloadBytesBase64url: "cGxhaW50ZXh0",
    };
    expect(parseLiveShadowMessageRealtimeEventV1(shadow) as unknown)
      .toEqual(shadow);
  });
});
