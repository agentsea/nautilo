import { describe, expect, test } from "bun:test";

import {
  deriveAgentRuntimeObjectSignerPublicV1,
} from "../../src/agent-runtime/object-signer-v1.ts";
import type { AgentRuntimeGenerationV2 } from "../../src/agent-runtime/types.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  verifyAgentLiveShadowStreamTerminalV1,
} from "../../src/message/live-shadow-stream-v1.ts";
import {
  decodeAgentLiveShadowStreamStartV2,
  encodeAgentLiveShadowStreamStartV2,
  openAgentLiveShadowStreamFrameV2,
  prepareAgentLiveShadowStreamStartV2,
  sealAgentLiveShadowStreamFrameV2,
  verifyAgentLiveShadowStreamStartV2,
  type AgentLiveShadowStreamStartV2,
} from "../../src/message/live-shadow-stream-v2.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

function runtime(): AgentRuntimeGenerationV2 {
  return {
    agentId: agentId("agent_m290_stream"),
    keyClass: "runtime",
    generation: agentRuntimeGeneration(8),
    key: new Uint8Array(32).fill(0x41),
  };
}

function fixture(crypto: LatticeCrypto) {
  const runtimeValue = runtime();
  const signer = deriveAgentRuntimeObjectSignerPublicV1(crypto, runtimeValue);
  const envelope = Uint8Array.of(1, 2, 3, 4);
  const created = prepareAgentLiveShadowStreamStartV2(crypto, {
    operationId: "operation_m290_stream",
    policyRevision: 13,
    sessionId: "11111111-1111-4111-8111-111111111290",
    roomId: "22222222-2222-4222-8222-222222222290",
    messageId: 290,
    revision: 0,
    createdAt: unixTimestamp(10_000),
    cryptoObjectId: objectId("message_live_shadow_stream_m290"),
    authorAgentId: runtimeValue.agentId,
    assistantMessageKey: "assistant_message_m290",
    transcriptOrdinal: 2,
    streamId: "stream_m290",
    namespaceId: namespaceId("namespace_room_m290"),
    namespaceAccessRevision: 3,
    namespaceKeyGeneration: 4,
    namespaceHeadDigest: new Uint8Array(32).fill(0x11),
    namespacePublicationDigest: new Uint8Array(32).fill(0x12),
    namespacePublicationSetDigest: new Uint8Array(32).fill(0x13),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(0x14),
    agentAuthorizationRevision: authorizationRevision(7),
    runtime: runtimeValue,
    runtimeSigner: signer.principal,
    hostAuthorizationRevision: authorizationRevision(8),
    namespaceEnvelopeBytes: envelope,
    namespaceEnvelopeDigest: crypto.hash(envelope),
    firstChunkSequence: 1,
    issuedAt: unixTimestamp(10_100),
    deadlineAt: unixTimestamp(40_100),
  });
  return { created, signer };
}

describe("M290 Agent live Shadow stream start V2", () => {
  test("pins and verifies a Domain-free current Namespace generation start", () => {
    const crypto = new LatticeCrypto(seededRng(290_030));
    const { created, signer } = fixture(crypto);
    expect(decodeAgentLiveShadowStreamStartV2(created.bytes)).toEqual(
      created.start,
    );
    expect(Buffer.from(created.startDigest).toString("hex")).toBe(
      "53f3100c8c5faf2db59f457c79936475936ca5fd97c49b1fdc237dcd4c9c5ff2",
    );
    expect(verifyAgentLiveShadowStreamStartV2(crypto, {
      startBytes: created.bytes,
      now: unixTimestamp(10_101),
      resolveSigner: () => signer.publicKey,
    })).toEqual(created.start);
    expect(Object.hasOwn(created.start, "domainId")).toBe(false);
    expect(Object.hasOwn(created.start, "namespaceBindingHash")).toBe(false);
  });

  test("seals and opens the unchanged chained frame contract under V2 authority", () => {
    const crypto = new LatticeCrypto(seededRng(290_031));
    const { created } = fixture(crypto);
    const objectDek = new Uint8Array(32).fill(0x55);
    const text = new TextEncoder().encode("device-wrapped stream");
    const finalPayloadDigest = crypto.hash(
      new TextEncoder().encode("canonical assistant payload"),
    );
    const sealed = sealAgentLiveShadowStreamFrameV2(crypto, {
      startBytes: created.bytes,
      objectDek,
      chunkSequence: 1,
      previousFrameHash: new Uint8Array(32),
      ordinaryChunk: text,
      done: true,
      totalChunkCount: 1,
      streamedTextDigest: crypto.hash(text),
      finalPayloadDigest,
      reserveNonce: () => true,
    });
    const opened = openAgentLiveShadowStreamFrameV2(crypto, {
      startBytes: created.bytes,
      frameBytes: sealed.bytes,
      objectDek,
      expectedSequence: 1,
      expectedPreviousFrameHash: new Uint8Array(32),
      accumulatedPlaintextBytes: 0,
    });
    expect(opened.plaintext).toEqual(text);
    expect(verifyAgentLiveShadowStreamTerminalV1(crypto, {
      terminalFrameBytes: sealed.bytes,
      orderedPlaintext: text,
      expectedFinalPayloadDigest: finalPayloadDigest,
    }).done).toBe(true);
  });

  test("rejects Namespace authority substitution, expiry, and V1 start use", () => {
    const crypto = new LatticeCrypto(seededRng(290_032));
    const { created, signer } = fixture(crypto);
    const changed = encodeAgentLiveShadowStreamStartV2({
      ...created.start,
      namespaceHeadDigest: new Uint8Array(32).fill(0x91),
    });
    expect(() => verifyAgentLiveShadowStreamStartV2(crypto, {
      startBytes: changed,
      now: unixTimestamp(10_101),
      resolveSigner: () => signer.publicKey,
    })).toThrow(/signature/i);
    expect(() => verifyAgentLiveShadowStreamStartV2(crypto, {
      startBytes: created.bytes,
      now: unixTimestamp(40_100),
      resolveSigner: () => signer.publicKey,
    })).toThrow(/not currently valid/i);
    expect(() => encodeAgentLiveShadowStreamStartV2({
      ...created.start,
      formatVersion: 1,
    } as unknown as AgentLiveShadowStreamStartV2)).toThrow(/shape/i);
    expect(() => decodeAgentLiveShadowStreamStartV2(
      new Uint8Array([...created.bytes, 0]),
    )).toThrow();
  });
});
