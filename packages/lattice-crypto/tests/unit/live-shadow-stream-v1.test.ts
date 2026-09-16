import { describe, expect, test } from "bun:test";

import {
  deriveAgentRuntimeObjectSignerPublicV1,
} from "../../src/agent-runtime/object-signer-v1.ts";
import type { AgentRuntimeGenerationV2 } from "../../src/agent-runtime/types.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  AGENT_LIVE_SHADOW_STREAM_MAX_FRAME_PLAINTEXT_BYTES_V1,
  AGENT_LIVE_SHADOW_STREAM_MAX_FRAMES_V1,
  AGENT_LIVE_SHADOW_STREAM_MAX_PLAINTEXT_BYTES_V1,
  agentLiveShadowStreamStartSigningBytesV1,
  decodeAgentLiveShadowStreamFrameV1,
  decodeAgentLiveShadowStreamStartV1,
  encodeAgentLiveShadowStreamFrameV1,
  encodeAgentLiveShadowStreamStartV1,
  openAgentLiveShadowStreamFrameV1,
  prepareAgentLiveShadowStreamStartV1,
  sealAgentLiveShadowStreamFrameV1,
  verifyAgentLiveShadowStreamStartV1,
  verifyAgentLiveShadowStreamTerminalV1,
  type AgentLiveShadowStreamFrameV1,
  type AgentLiveShadowStreamStartV1,
} from "../../src/message/live-shadow-stream-v1.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

function runtime(): AgentRuntimeGenerationV2 {
  return {
    agentId: agentId("agent_alpha"),
    keyClass: "runtime",
    generation: agentRuntimeGeneration(7),
    key: new Uint8Array(32).fill(0x41),
  };
}

function startFixture(crypto: LatticeCrypto) {
  const runtimeValue = runtime();
  const signer = deriveAgentRuntimeObjectSignerPublicV1(crypto, runtimeValue);
  const envelope = Uint8Array.of(1, 2, 3, 4);
  const created = prepareAgentLiveShadowStreamStartV1(crypto, {
    operationId: "operation_alpha",
    policyRevision: 12,
    sessionId: "11111111-1111-4111-8111-111111111111",
    roomId: "22222222-2222-4222-8222-222222222222",
    messageId: 91,
    revision: 0,
    createdAt: unixTimestamp(10_000),
    cryptoObjectId: objectId("message:live-shadow:v1:alpha"),
    authorAgentId: agentId("agent_alpha"),
    assistantMessageKey: "assistant_message_alpha",
    transcriptOrdinal: 2,
    streamId: "stream_alpha",
    namespaceId: namespaceId("namespace_alpha"),
    namespaceBindingHash: new Uint8Array(32).fill(0x11),
    namespaceAccessRevision: 3,
    namespaceKeyGeneration: 4,
    bindingRevisionAtWrap: 5,
    domainId: cryptoDomainId("domain_alpha"),
    domainEpoch: domainEpoch(6),
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

describe("M282 Agent live Shadow stream V1", () => {
  test("signs a canonical start and verifies current Runtime authority", () => {
    const crypto = new LatticeCrypto(seededRng(2821));
    const { created, signer } = startFixture(crypto);

    expect(decodeAgentLiveShadowStreamStartV1(created.bytes)).toEqual(created.start);
    expect(
      verifyAgentLiveShadowStreamStartV1(crypto, {
        startBytes: created.bytes,
        now: unixTimestamp(10_101),
        resolveSigner: () => signer.publicKey,
      }),
    ).toEqual(created.start);

    const changed = created.bytes.slice();
    changed[40] = (changed[40] ?? 0) ^ 1;
    expect(() => decodeAgentLiveShadowStreamStartV1(changed)).toThrow();
  });

  test("seals, chains, opens, and terminally verifies ordinary parity", () => {
    const crypto = new LatticeCrypto(seededRng(2822));
    const { created } = startFixture(crypto);
    const dek = new Uint8Array(32).fill(0x55);
    const reserved = new Set<string>();
    const reserveNonce = (nonce: Uint8Array): boolean => {
      const key = Buffer.from(nonce).toString("hex");
      if (reserved.has(key)) return false;
      reserved.add(key);
      return true;
    };
    const firstText = new TextEncoder().encode("Hello ");
    const secondText = new TextEncoder().encode("world");
    const first = sealAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes,
      objectDek: dek,
      chunkSequence: 1,
      previousFrameHash: new Uint8Array(32),
      ordinaryChunk: firstText,
      done: false,
      reserveNonce,
    });
    const allText = new TextEncoder().encode("Hello world");
    const finalPayloadDigest = crypto.hash(new TextEncoder().encode("canonical assistant payload"));
    const second = sealAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes,
      objectDek: dek,
      chunkSequence: 2,
      previousFrameHash: first.frameHash,
      ordinaryChunk: secondText,
      done: true,
      totalChunkCount: 2,
      streamedTextDigest: crypto.hash(allText),
      finalPayloadDigest,
      reserveNonce,
    });

    const openedFirst = openAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes,
      frameBytes: first.bytes,
      objectDek: dek,
      expectedSequence: 1,
      expectedPreviousFrameHash: new Uint8Array(32),
      accumulatedPlaintextBytes: 0,
    });
    expect(new TextDecoder().decode(openedFirst.plaintext)).toBe("Hello ");
    const openedSecond = openAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes,
      frameBytes: second.bytes,
      objectDek: dek,
      expectedSequence: 2,
      expectedPreviousFrameHash: first.frameHash,
      accumulatedPlaintextBytes: openedFirst.accumulatedPlaintextBytes,
    });
    expect(new TextDecoder().decode(openedSecond.plaintext)).toBe("world");
    expect(
      verifyAgentLiveShadowStreamTerminalV1(crypto, {
        terminalFrameBytes: second.bytes,
        orderedPlaintext: allText,
        expectedFinalPayloadDigest: finalPayloadDigest,
      }).done,
    ).toBe(true);
    expect(() => openAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes,
      frameBytes: second.bytes,
      objectDek: dek,
      expectedSequence: 2,
      expectedPreviousFrameHash: new Uint8Array(32),
      accumulatedPlaintextBytes: openedFirst.accumulatedPlaintextBytes,
    })).toThrow("coordinates disagree");
  });

  test("rejects frame truncation, extension, splice, and terminal mismatch", () => {
    const crypto = new LatticeCrypto(seededRng(2823));
    const { created } = startFixture(crypto);
    const dek = new Uint8Array(32).fill(0x33);
    const frame = sealAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes,
      objectDek: dek,
      chunkSequence: 1,
      previousFrameHash: new Uint8Array(32),
      ordinaryChunk: new TextEncoder().encode("done"),
      done: true,
      totalChunkCount: 1,
      streamedTextDigest: crypto.hash(new TextEncoder().encode("done")),
      finalPayloadDigest: new Uint8Array(32).fill(0x77),
      reserveNonce: () => true,
    });
    expect(() => decodeAgentLiveShadowStreamFrameV1(frame.bytes.slice(0, -1))).toThrow();
    expect(() => decodeAgentLiveShadowStreamFrameV1(Uint8Array.from([...frame.bytes, 0]))).toThrow();
    const spliced = frame.bytes.slice();
    spliced[spliced.length - 17] = (spliced[spliced.length - 17] ?? 0) ^ 1;
    expect(() => openAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes,
      frameBytes: spliced,
      objectDek: dek,
      expectedSequence: 1,
      expectedPreviousFrameHash: new Uint8Array(32),
      accumulatedPlaintextBytes: 0,
    })).toThrow();
    expect(() => verifyAgentLiveShadowStreamTerminalV1(crypto, {
      terminalFrameBytes: frame.bytes,
      orderedPlaintext: new TextEncoder().encode("different"),
      expectedFinalPayloadDigest: new Uint8Array(32).fill(0x77),
    })).toThrow("streamed text digest disagrees");
  });

  test("validates every stream-start coordinate and exact field", () => {
    const crypto = new LatticeCrypto(seededRng(2826));
    const { created } = startFixture(crypto);
    const value = created.start;
    const changed = (changes: Record<string, unknown>) =>
      encodeAgentLiveShadowStreamStartV1({ ...value, ...changes } as AgentLiveShadowStreamStartV1);
    const invalid: readonly [string, unknown][] = [
      ["formatVersion", 2], ["purpose", "message.wrong"], ["operationId", ""],
      ["policyRevision", 0], ["policyRevision", 1.5],
      ["sessionId", `${value.sessionId}x`], ["roomId", value.roomId.slice(0, -1)],
      ["messageId", 0], ["messageId", 2_147_483_648], ["revision", 1],
      ["createdAt", -1], ["cryptoObjectId", ""], ["authorAgentId", ""],
      ["assistantMessageKey", ""], ["transcriptOrdinal", 0], ["streamId", ""],
      ["namespaceId", ""], ["namespaceBindingHash", new Uint8Array(31)],
      ["namespaceAccessRevision", -1], ["namespaceKeyGeneration", -1],
      ["bindingRevisionAtWrap", -1], ["domainId", ""], ["domainEpoch", -1],
      ["agentAuthorizationRevision", -1], ["hostAuthorizationRevision", -1],
      ["namespaceEnvelopeBytes", new Uint8Array(1024 * 1024 + 1)],
      ["namespaceEnvelopeDigest", new Uint8Array(31)], ["firstChunkSequence", 2],
      ["issuedAt", -1], ["deadlineAt", value.issuedAt],
      ["deadlineAt", unixTimestamp(value.issuedAt + 30_001)],
      ["signature", new Uint8Array(63)],
    ];
    for (const [field, replacement] of invalid) {
      expect(() => changed({ [field]: replacement }), field).toThrow();
    }
    for (const runtimeSigner of [
      { ...value.runtimeSigner, kind: "wrong" },
      { ...value.runtimeSigner, runtimeGeneration: -1 },
      { ...value.runtimeSigner, signerKeyId: "" },
      { ...value.runtimeSigner, extra: true },
    ]) {
      expect(() => changed({ runtimeSigner })).toThrow();
    }
    expect(() => changed({ extra: true })).toThrow("invalid field set");
    const { signature: _signature, ...missing } = value;
    expect(() => encodeAgentLiveShadowStreamStartV1(missing as AgentLiveShadowStreamStartV1))
      .toThrow("invalid field set");
    expect(() => encodeAgentLiveShadowStreamStartV1(null as never)).toThrow("must be an object");
    expect(() => encodeAgentLiveShadowStreamStartV1([] as never)).toThrow();
    expect(agentLiveShadowStreamStartSigningBytesV1(missing).length).toBeGreaterThan(0);
  });

  test("binds all stream-start fields and exact Runtime signer authority", () => {
    const crypto = new LatticeCrypto(seededRng(2827));
    const { created, signer } = startFixture(crypto);
    const value = created.start;
    const substitutions: readonly Record<string, unknown>[] = [
      { operationId: "operation_beta" }, { policyRevision: 13 },
      { sessionId: "33333333-3333-4333-8333-333333333333" },
      { roomId: "44444444-4444-4444-8444-444444444444" }, { messageId: 92 },
      { createdAt: unixTimestamp(10_001) },
      { cryptoObjectId: objectId("message:live-shadow:v1:beta") },
      { authorAgentId: agentId("agent_beta"), runtimeSigner: { ...value.runtimeSigner, agentId: agentId("agent_beta") } },
      { assistantMessageKey: "assistant_message_beta" }, { transcriptOrdinal: 3 },
      { streamId: "stream_beta" }, { namespaceId: namespaceId("namespace_beta") },
      { namespaceBindingHash: new Uint8Array(32).fill(0x21) },
      { namespaceAccessRevision: 4 }, { namespaceKeyGeneration: 5 },
      { bindingRevisionAtWrap: 6 }, { domainId: cryptoDomainId("domain_beta") },
      { domainEpoch: domainEpoch(7) }, { agentAuthorizationRevision: authorizationRevision(8) },
      { runtimeSigner: { ...value.runtimeSigner, runtimeGeneration: agentRuntimeGeneration(8) } },
      { runtimeSigner: { ...value.runtimeSigner, signerKeyId: `agent_runtime_signer_${"a".repeat(64)}` } },
      { hostAuthorizationRevision: authorizationRevision(9) },
      { namespaceEnvelopeBytes: Uint8Array.of(4, 3, 2, 1) },
      { namespaceEnvelopeDigest: new Uint8Array(32).fill(0x22) },
      { issuedAt: unixTimestamp(10_101), deadlineAt: unixTimestamp(40_100) },
      { deadlineAt: unixTimestamp(40_099) },
    ];
    for (const substitution of substitutions) {
      const bytes = encodeAgentLiveShadowStreamStartV1({ ...value, ...substitution } as AgentLiveShadowStreamStartV1);
      expect(bytes).not.toEqual(created.bytes);
      expect(() => verifyAgentLiveShadowStreamStartV1(crypto, {
        startBytes: bytes,
        now: unixTimestamp(10_102),
        resolveSigner: () => signer.publicKey,
      })).toThrow();
    }
    let context: unknown;
    expect(verifyAgentLiveShadowStreamStartV1(crypto, {
      startBytes: created.bytes,
      now: value.issuedAt,
      resolveSigner: (resolved) => {
        context = resolved;
        return signer.publicKey;
      },
    })).toEqual(value);
    expect(context).toEqual({
      purpose: "agent-live-shadow-stream-start-verify",
      operationId: value.operationId,
      authorAgentId: value.authorAgentId,
      runtimeGeneration: value.runtimeSigner.runtimeGeneration,
      signerKeyId: value.runtimeSigner.signerKeyId,
      hostAuthorizationRevision: value.hostAuthorizationRevision,
    });
    for (const now of [unixTimestamp(value.issuedAt - 1), value.deadlineAt]) {
      expect(() => verifyAgentLiveShadowStreamStartV1(crypto, {
        startBytes: created.bytes, now, resolveSigner: () => signer.publicKey,
      })).toThrow("not currently valid");
    }
    expect(() => verifyAgentLiveShadowStreamStartV1(crypto, {
      startBytes: created.bytes, now: value.issuedAt, resolveSigner: () => null,
    })).toThrow("signer is unavailable");
    expect(() => verifyAgentLiveShadowStreamStartV1(crypto, {
      startBytes: created.bytes, now: value.issuedAt, resolveSigner: () => new Uint8Array(31),
    })).toThrow("public key");
    const changedEnvelope = encodeAgentLiveShadowStreamStartV1({
      ...value,
      namespaceEnvelopeBytes: Uint8Array.of(9, 9, 9, 9),
    });
    expect(() => verifyAgentLiveShadowStreamStartV1(crypto, {
      startBytes: changedEnvelope, now: value.issuedAt, resolveSigner: () => signer.publicKey,
    })).toThrow("envelope digest disagrees");
  });

  test("validates every frame field, terminal shape, and size boundary", () => {
    const crypto = new LatticeCrypto(seededRng(2828));
    const { created } = startFixture(crypto);
    const frame = sealAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes,
      objectDek: new Uint8Array(32).fill(0x61),
      chunkSequence: 1,
      previousFrameHash: new Uint8Array(32),
      ordinaryChunk: new TextEncoder().encode("frame"),
      done: true,
      totalChunkCount: 1,
      streamedTextDigest: crypto.hash(new TextEncoder().encode("frame")),
      finalPayloadDigest: new Uint8Array(32).fill(0x62),
      reserveNonce: () => true,
    }).frame;
    const changed = (changes: Record<string, unknown>) =>
      encodeAgentLiveShadowStreamFrameV1({ ...frame, ...changes } as AgentLiveShadowStreamFrameV1);
    const invalid: readonly [string, unknown][] = [
      ["formatVersion", 2], ["purpose", "message.wrong"],
      ["streamStartDigest", new Uint8Array(31)], ["streamId", ""],
      ["messageId", 0], ["messageId", 2_147_483_648], ["revision", 1],
      ["cryptoObjectId", ""], ["transcriptOrdinal", 0], ["chunkSequence", 0],
      ["chunkSequence", AGENT_LIVE_SHADOW_STREAM_MAX_FRAMES_V1 + 1],
      ["plaintextLength", -1],
      ["plaintextLength", AGENT_LIVE_SHADOW_STREAM_MAX_FRAME_PLAINTEXT_BYTES_V1 + 1],
      ["previousFrameHash", new Uint8Array(31)],
      ["ordinaryChunk", new Uint8Array(AGENT_LIVE_SHADOW_STREAM_MAX_FRAME_PLAINTEXT_BYTES_V1 + 1)],
      ["nonce", new Uint8Array(23)],
      ["ciphertext", new Uint8Array(frame.ciphertext.length + 1)],
      ["tag", new Uint8Array(15)], ["totalChunkCount", 0],
      ["totalChunkCount", AGENT_LIVE_SHADOW_STREAM_MAX_FRAMES_V1 + 1],
      ["streamedTextDigest", new Uint8Array(31)], ["finalPayloadDigest", new Uint8Array(31)],
    ];
    for (const [field, replacement] of invalid) {
      expect(() => changed({ [field]: replacement }), field).toThrow();
    }
    for (const incoherent of [
      { done: true, totalChunkCount: null },
      { done: true, streamedTextDigest: null },
      { done: true, finalPayloadDigest: null },
      { done: false },
      { done: false, totalChunkCount: null },
      { done: false, streamedTextDigest: null },
      { done: false, finalPayloadDigest: null },
    ]) expect(() => changed(incoherent)).toThrow("terminal fields are incoherent");
    expect(() => changed({ extra: true })).toThrow("invalid field set");
    const { tag: _tag, ...missing } = frame;
    expect(() => encodeAgentLiveShadowStreamFrameV1(missing as AgentLiveShadowStreamFrameV1))
      .toThrow("invalid field set");
    expect(() => encodeAgentLiveShadowStreamFrameV1(null as never)).toThrow("must be an object");
    expect(() => encodeAgentLiveShadowStreamFrameV1([] as never)).toThrow("must be an object");
  });

  test("fails closed for nonce exhaustion, coordinate drift, plaintext limits, and terminal mismatch", () => {
    const crypto = new LatticeCrypto(seededRng(2829));
    const { created } = startFixture(crypto);
    const dek = new Uint8Array(32).fill(0x71);
    const plaintext = new TextEncoder().encode("frame");
    expect(() => sealAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes, objectDek: dek, chunkSequence: 1,
      previousFrameHash: new Uint8Array(32), ordinaryChunk: plaintext,
      done: false, reserveNonce: () => false,
    })).toThrow("nonce collision limit exceeded");
    expect(() => sealAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes, objectDek: dek, chunkSequence: 1,
      previousFrameHash: new Uint8Array(32), ordinaryChunk: plaintext,
      done: true, totalChunkCount: 2, streamedTextDigest: crypto.hash(plaintext),
      finalPayloadDigest: new Uint8Array(32), reserveNonce: () => true,
    })).toThrow("frame count disagrees");
    expect(() => sealAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes, objectDek: new Uint8Array(31), chunkSequence: 1,
      previousFrameHash: new Uint8Array(32), ordinaryChunk: plaintext,
      done: false, reserveNonce: () => true,
    })).toThrow("object DEK");
    const sealed = sealAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes, objectDek: dek, chunkSequence: 1,
      previousFrameHash: new Uint8Array(32), ordinaryChunk: plaintext,
      done: true, totalChunkCount: 1, streamedTextDigest: crypto.hash(plaintext),
      finalPayloadDigest: new Uint8Array(32).fill(0x72), reserveNonce: () => true,
    });
    const coordinateInputs = [
      { expectedSequence: 2 },
      { expectedPreviousFrameHash: new Uint8Array(32).fill(1) },
    ];
    for (const replacement of coordinateInputs) {
      expect(() => openAgentLiveShadowStreamFrameV1(crypto, {
        startBytes: created.bytes, frameBytes: sealed.bytes, objectDek: dek,
        expectedSequence: 1, expectedPreviousFrameHash: new Uint8Array(32),
        accumulatedPlaintextBytes: 0, ...replacement,
      })).toThrow("coordinates disagree");
    }
    expect(() => openAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes, frameBytes: sealed.bytes, objectDek: dek,
      expectedSequence: 1, expectedPreviousFrameHash: new Uint8Array(32),
      accumulatedPlaintextBytes: AGENT_LIVE_SHADOW_STREAM_MAX_PLAINTEXT_BYTES_V1,
    })).toThrow("plaintext limit");
    expect(() => openAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes, frameBytes: sealed.bytes, objectDek: new Uint8Array(32).fill(0x73),
      expectedSequence: 1, expectedPreviousFrameHash: new Uint8Array(32),
      accumulatedPlaintextBytes: 0,
    })).toThrow("plaintext parity failed");
    expect(() => verifyAgentLiveShadowStreamTerminalV1(crypto, {
      terminalFrameBytes: sealed.bytes, orderedPlaintext: plaintext,
      expectedFinalPayloadDigest: new Uint8Array(32).fill(0x74),
    })).toThrow("final payload digest disagrees");
    const nonterminal = sealAgentLiveShadowStreamFrameV1(crypto, {
      startBytes: created.bytes, objectDek: dek, chunkSequence: 1,
      previousFrameHash: new Uint8Array(32), ordinaryChunk: plaintext,
      done: false, reserveNonce: () => true,
    });
    expect(() => verifyAgentLiveShadowStreamTerminalV1(crypto, {
      terminalFrameBytes: nonterminal.bytes, orderedPlaintext: plaintext,
      expectedFinalPayloadDigest: new Uint8Array(32),
    })).toThrow("terminal frame is incomplete");
  });
});
