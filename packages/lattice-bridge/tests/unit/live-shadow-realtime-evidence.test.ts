import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  fullEncryptionDurableEventDigestV2,
  liveShadowDurableEventDigestV1,
} from
  "../../src/message/live-shadow-realtime-evidence.ts";

const crypto = new LatticeCrypto();
const protectedMessage = {
  dtoVersion: 2 as const,
  projection: {
    messageId: "42",
    sessionId: "10000000-0000-4000-8000-000000000282",
    roomId: "20000000-0000-4000-8000-000000000282",
    namespaceId: "30000000-0000-4000-8000-000000000282",
    role: "assistant" as const,
    createdAt: "2027-01-15T08:00:00.000Z",
    editRevision: 0,
    authorAgentId: "40000000-0000-4000-8000-000000000282",
  },
  protectedPayload: {
    status: "pending" as const,
    reason: "shadow_pending" as const,
  },
};

describe("live Shadow durable realtime evidence", () => {
  test("binds every causal coordinate and both complete siblings", () => {
    const base = {
      operationId: "turn:m282",
      policyRevision: 5,
      transcriptOrdinal: 2,
      ordinaryPayloadBytes: new TextEncoder().encode("ordinary"),
      protectedMessage,
    };
    const digest = liveShadowDurableEventDigestV1(crypto, base);
    expect(digest).toHaveLength(32);
    for (const substituted of [
      { ...base, operationId: "turn:m282:other" },
      { ...base, policyRevision: 6 },
      { ...base, transcriptOrdinal: 3 },
      { ...base, ordinaryPayloadBytes: new TextEncoder().encode("changed") },
      {
        ...base,
        protectedMessage: {
          ...protectedMessage,
          projection: { ...protectedMessage.projection, messageId: "43" },
        },
      },
    ]) {
      const changed = liveShadowDurableEventDigestV1(crypto, substituted);
      expect(changed).not.toEqual(digest);
      changed.fill(0);
    }
    digest.fill(0);
    base.ordinaryPayloadBytes.fill(0);
  });
});

describe("Full encryption durable realtime evidence", () => {
  test("binds coordinates and the complete protected DTO without ordinary bytes", () => {
    const encryptedMessage = {
      ...protectedMessage,
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
    const base = {
      operationId: "turn:m318",
      policyRevision: 8,
      transcriptOrdinal: 2,
      protectedMessage: encryptedMessage,
    };
    const digest = fullEncryptionDurableEventDigestV2(crypto, base);
    expect(digest).toHaveLength(32);
    for (const substituted of [
      { ...base, operationId: "turn:m318:other" },
      { ...base, policyRevision: 9 },
      { ...base, transcriptOrdinal: 3 },
      {
        ...base,
        protectedMessage: {
          ...encryptedMessage,
          projection: { ...encryptedMessage.projection, messageId: "43" },
        },
      },
      {
        ...base,
        protectedMessage: {
          ...encryptedMessage,
          protectedPayload: {
            ...encryptedMessage.protectedPayload,
            encryptedPayloadBytesBase64url: "BA",
          },
        },
      },
    ]) {
      const changed = fullEncryptionDurableEventDigestV2(crypto, substituted);
      expect(changed).not.toEqual(digest);
      changed.fill(0);
    }
    expect(fullEncryptionDurableEventDigestV2(crypto, base)).not.toEqual(
      liveShadowDurableEventDigestV1(crypto, {
        ...base,
        ordinaryPayloadBytes: new TextEncoder().encode("ordinary"),
      }),
    );
    digest.fill(0);
  });

  test("rejects malformed numeric coordinates", () => {
    for (const changes of [
      { policyRevision: -1 },
      { policyRevision: 0x1_0000_0000 },
      { transcriptOrdinal: Number.NaN },
      { transcriptOrdinal: 1.5 },
    ]) {
      expect(() => fullEncryptionDurableEventDigestV2(crypto, {
        operationId: "turn:m318",
        policyRevision: 8,
        transcriptOrdinal: 2,
        protectedMessage,
        ...changes,
      })).toThrow(RangeError);
    }
  });
});
