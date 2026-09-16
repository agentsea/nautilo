import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeHumanLiveShadowClientVerificationV1,
  encodeHumanLiveShadowClientVerificationV1,
  humanLiveShadowClientVerificationDigestV1,
  humanLiveShadowClientVerificationSigningBytesV1,
  prepareHumanLiveShadowClientVerificationV1,
  verifyHumanLiveShadowClientVerificationV1,
  type HumanLiveShadowClientVerificationV1,
} from "../../src/message/live-shadow-client-verification-v1.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const ROOM = "22222222-2222-4222-8222-222222222222";

function verificationFixture() {
  const crypto = new LatticeCrypto(seededRng(0x282_45));
  const keys = crypto.generateSigningKeyPair();
  const created = prepareHumanLiveShadowClientVerificationV1(crypto, {
    subjectHumanId: humanId("human_alpha"),
    operationId: "operation_alpha",
    policyRevision: 12,
    sessionId: SESSION,
    roomId: ROOM,
    status: "matched",
    transcript: [
      {
        transcriptOrdinal: 1,
        messageId: 90,
        revision: 0,
        authorRole: "human",
        cryptoObjectId: objectId("message:live-shadow:v1:human"),
        ordinaryPayloadDigest: new Uint8Array(32).fill(0x11),
        protectedDtoDigest: new Uint8Array(32).fill(0x12),
      },
      {
        transcriptOrdinal: 2,
        messageId: 91,
        revision: 0,
        authorRole: "assistant",
        cryptoObjectId: objectId("message:live-shadow:v1:assistant"),
        ordinaryPayloadDigest: new Uint8Array(32).fill(0x21),
        protectedDtoDigest: new Uint8Array(32).fill(0x22),
      },
    ],
    streamTerminals: [{
      transcriptOrdinal: 2,
      streamId: "stream_alpha",
      streamStartDigest: new Uint8Array(32).fill(0x31),
      terminalFrameDigest: new Uint8Array(32).fill(0x32),
      streamedTextDigest: new Uint8Array(32).fill(0x33),
      finalPayloadDigest: new Uint8Array(32).fill(0x34),
    }],
    closedStage: "browser_open",
    reason: "none",
    issuedAt: unixTimestamp(20_000),
    deadlineAt: unixTimestamp(50_000),
    committerDeviceId: cryptoDeviceId("device_alpha"),
    hostAuthorizationRevision: authorizationRevision(7),
    committerSigningPublicKey: keys.publicKey,
    committerSigningPrivateKey: keys.privateKey,
  });
  return { crypto, keys, created };
}

function encodeChanged(
  value: HumanLiveShadowClientVerificationV1,
  changes: Record<string, unknown>,
): Uint8Array {
  return encodeHumanLiveShadowClientVerificationV1({
    ...value,
    ...changes,
  } as HumanLiveShadowClientVerificationV1);
}

describe("M282 Human live Shadow client verification V1", () => {
  test("signs and verifies ordered content-free parity evidence", () => {
    const crypto = new LatticeCrypto(seededRng(2824));
    const keys = crypto.generateSigningKeyPair();
    const created = prepareHumanLiveShadowClientVerificationV1(crypto, {
      subjectHumanId: humanId("human_alpha"),
      operationId: "operation_alpha",
      policyRevision: 12,
      sessionId: "11111111-1111-4111-8111-111111111111",
      roomId: "22222222-2222-4222-8222-222222222222",
      status: "matched",
      transcript: [
        {
          transcriptOrdinal: 1,
          messageId: 90,
          revision: 0,
          authorRole: "human",
          cryptoObjectId: objectId("message:live-shadow:v1:human"),
          ordinaryPayloadDigest: new Uint8Array(32).fill(0x11),
          protectedDtoDigest: new Uint8Array(32).fill(0x12),
        },
        {
          transcriptOrdinal: 2,
          messageId: 91,
          revision: 0,
          authorRole: "assistant",
          cryptoObjectId: objectId("message:live-shadow:v1:assistant"),
          ordinaryPayloadDigest: new Uint8Array(32).fill(0x21),
          protectedDtoDigest: new Uint8Array(32).fill(0x22),
        },
      ],
      streamTerminals: [{
        transcriptOrdinal: 2,
        streamId: "stream_alpha",
        streamStartDigest: new Uint8Array(32).fill(0x31),
        terminalFrameDigest: new Uint8Array(32).fill(0x32),
        streamedTextDigest: new Uint8Array(32).fill(0x33),
        finalPayloadDigest: new Uint8Array(32).fill(0x34),
      }],
      closedStage: "browser_open",
      reason: "none",
      issuedAt: unixTimestamp(20_000),
      deadlineAt: unixTimestamp(50_000),
      committerDeviceId: cryptoDeviceId("device_alpha"),
      hostAuthorizationRevision: authorizationRevision(7),
      committerSigningPublicKey: keys.publicKey,
      committerSigningPrivateKey: keys.privateKey,
    });

    expect(decodeHumanLiveShadowClientVerificationV1(created.bytes)).toEqual(created.verification);
    expect(verifyHumanLiveShadowClientVerificationV1(crypto, {
      verificationBytes: created.bytes,
      now: unixTimestamp(20_001),
      resolveCurrentAuthority: () => keys.publicKey,
    })).toEqual(created.verification);
  });

  test("rejects unordered, contradictory, substituted, and noncanonical evidence", () => {
    const crypto = new LatticeCrypto(seededRng(2825));
    const keys = crypto.generateSigningKeyPair();
    const common = {
      subjectHumanId: humanId("human_alpha"), operationId: "operation_alpha", policyRevision: 1,
      sessionId: "11111111-1111-4111-8111-111111111111", roomId: "22222222-2222-4222-8222-222222222222",
      streamTerminals: [], closedStage: "browser_open" as const,
      issuedAt: unixTimestamp(20_000), deadlineAt: unixTimestamp(50_000),
      committerDeviceId: cryptoDeviceId("device_alpha"), hostAuthorizationRevision: authorizationRevision(1),
      committerSigningPublicKey: keys.publicKey, committerSigningPrivateKey: keys.privateKey,
    };
    const entry = (ordinal: number) => ({
      transcriptOrdinal: ordinal, messageId: 90 + ordinal, revision: 0 as const,
      authorRole: "human" as const, cryptoObjectId: objectId(`message:live-shadow:v1:${ordinal}`),
      ordinaryPayloadDigest: new Uint8Array(32).fill(ordinal),
      protectedDtoDigest: new Uint8Array(32).fill(ordinal + 1),
    });
    expect(() => prepareHumanLiveShadowClientVerificationV1(crypto, {
      ...common, status: "matched", reason: "none", transcript: [entry(2), entry(1)],
    })).toThrow("strictly ordered");
    expect(() => prepareHumanLiveShadowClientVerificationV1(crypto, {
      ...common, status: "matched", reason: "parity_mismatch", transcript: [entry(1)],
    })).toThrow("status and reason disagree");
    const created = prepareHumanLiveShadowClientVerificationV1(crypto, {
      ...common, status: "failed", reason: "parity_mismatch", transcript: [entry(1)],
    });
    const changed = created.bytes.slice();
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    expect(() => verifyHumanLiveShadowClientVerificationV1(crypto, {
      verificationBytes: changed, now: unixTimestamp(20_001), resolveCurrentAuthority: () => keys.publicKey,
    })).toThrow("signature is invalid");
    expect(() => decodeHumanLiveShadowClientVerificationV1(created.bytes.slice(0, -1))).toThrow();
    expect(() => decodeHumanLiveShadowClientVerificationV1(Uint8Array.from([...created.bytes, 0]))).toThrow();
  });

  test("rejects every malformed top-level coordinate and boundary", () => {
    const { created } = verificationFixture();
    const value = created.verification;
    const invalid: readonly [string, unknown][] = [
      ["formatVersion", 2],
      ["purpose", "message.wrong"],
      ["subjectHumanId", ""],
      ["operationId", ""],
      ["policyRevision", 0],
      ["policyRevision", 1.5],
      ["sessionId", `${SESSION}x`],
      ["roomId", ROOM.slice(0, -1)],
      ["status", "unknown"],
      ["closedStage", "unknown"],
      ["reason", "unknown"],
      ["issuedAt", -1],
      ["deadlineAt", value.issuedAt],
      ["deadlineAt", unixTimestamp(value.issuedAt + 30_001)],
      ["committerDeviceId", ""],
      ["hostAuthorizationRevision", -1],
      ["signature", new Uint8Array(63)],
    ];
    for (const [field, replacement] of invalid) {
      expect(() => encodeChanged(value, { [field]: replacement }), field)
        .toThrow();
    }
    expect(() => encodeHumanLiveShadowClientVerificationV1({
      ...value,
      extra: true,
    } as HumanLiveShadowClientVerificationV1)).toThrow("invalid field set");
    const { signature: _signature, ...missing } = value;
    expect(() => encodeHumanLiveShadowClientVerificationV1(
      missing as HumanLiveShadowClientVerificationV1,
    )).toThrow("invalid field set");
    expect(() => encodeHumanLiveShadowClientVerificationV1(null as never))
      .toThrow("must be an object");
  });

  test("validates every transcript and stream-terminal field exactly", () => {
    const { created } = verificationFixture();
    const value = created.verification;
    const transcript = value.transcript[0]!;
    const badTranscript: readonly Record<string, unknown>[] = [
      { transcriptOrdinal: 0 },
      { messageId: 0 },
      { messageId: 2_147_483_648 },
      { revision: 1 },
      { authorRole: "system" },
      { cryptoObjectId: "" },
      { ordinaryPayloadDigest: new Uint8Array(31) },
      { protectedDtoDigest: new Uint8Array(33) },
    ];
    for (const replacement of badTranscript) {
      expect(() => encodeChanged(value, {
        transcript: [{ ...transcript, ...replacement }],
      })).toThrow();
    }
    expect(() => encodeChanged(value, { transcript: [] })).toThrow("count is invalid");
    expect(() => encodeChanged(value, { transcript: "not-an-array" })).toThrow("count is invalid");
    expect(() => encodeChanged(value, { transcript: [transcript, transcript] })).toThrow("strictly ordered");
    expect(() => encodeChanged(value, { transcript: [null] })).toThrow("must be an object");
    expect(() => encodeChanged(value, { transcript: [[transcript]] })).toThrow("must be an object");
    expect(() => encodeChanged(value, {
      transcript: [{ ...transcript, extra: true }],
    })).toThrow("invalid field set");
    expect(() => encodeChanged(value, {
      transcript: Array.from({ length: 257 }, (_, index) => ({
        ...transcript,
        transcriptOrdinal: index + 1,
        messageId: index + 1,
      })),
    })).toThrow("count is invalid");

    const terminal = value.streamTerminals[0]!;
    const badTerminal: readonly Record<string, unknown>[] = [
      { transcriptOrdinal: 0 },
      { streamId: "" },
      { streamStartDigest: new Uint8Array(31) },
      { terminalFrameDigest: new Uint8Array(33) },
      { streamedTextDigest: new Uint8Array(31) },
      { finalPayloadDigest: new Uint8Array(33) },
    ];
    for (const replacement of badTerminal) {
      expect(() => encodeChanged(value, {
        streamTerminals: [{ ...terminal, ...replacement }],
      })).toThrow();
    }
    expect(() => encodeChanged(value, { streamTerminals: "not-an-array" })).toThrow("count is invalid");
    expect(() => encodeChanged(value, { streamTerminals: [terminal, terminal] })).toThrow("strictly ordered");
    expect(() => encodeChanged(value, { streamTerminals: [null] })).toThrow("must be an object");
    expect(() => encodeChanged(value, { streamTerminals: [[terminal]] })).toThrow("must be an object");
    expect(() => encodeChanged(value, {
      streamTerminals: [{ ...terminal, extra: true }],
    })).toThrow("invalid field set");
    expect(() => encodeChanged(value, {
      streamTerminals: Array.from({ length: 257 }, (_, index) => ({
        ...terminal,
        transcriptOrdinal: index + 1,
      })),
    })).toThrow("count is invalid");
  });

  test("binds every signed coordinate and verifies exact current authority", () => {
    const { crypto, keys, created } = verificationFixture();
    const value = created.verification;
    const entry = value.transcript[0]!;
    const terminal = value.streamTerminals[0]!;
    const coherentSubstitutions: readonly Record<string, unknown>[] = [
      { subjectHumanId: humanId("human_beta") },
      { operationId: "operation_beta" },
      { policyRevision: 13 },
      { sessionId: "33333333-3333-4333-8333-333333333333" },
      { roomId: "44444444-4444-4444-8444-444444444444" },
      { closedStage: "durable_transcript" },
      { issuedAt: unixTimestamp(20_001), deadlineAt: unixTimestamp(50_000) },
      { committerDeviceId: cryptoDeviceId("device_beta") },
      { hostAuthorizationRevision: authorizationRevision(8) },
      { transcript: [{ ...entry, transcriptOrdinal: 3 }] },
      { transcript: [{ ...entry, messageId: 92 }] },
      { transcript: [{ ...entry, authorRole: "tool" }] },
      { transcript: [{ ...entry, cryptoObjectId: objectId("message:live-shadow:v1:beta") }] },
      { transcript: [{ ...entry, ordinaryPayloadDigest: new Uint8Array(32).fill(0x41) }] },
      { transcript: [{ ...entry, protectedDtoDigest: new Uint8Array(32).fill(0x42) }] },
      { streamTerminals: [{ ...terminal, transcriptOrdinal: 3 }] },
      { streamTerminals: [{ ...terminal, streamId: "stream_beta" }] },
      { streamTerminals: [{ ...terminal, streamStartDigest: new Uint8Array(32).fill(0x51) }] },
      { streamTerminals: [{ ...terminal, terminalFrameDigest: new Uint8Array(32).fill(0x52) }] },
      { streamTerminals: [{ ...terminal, streamedTextDigest: new Uint8Array(32).fill(0x53) }] },
      { streamTerminals: [{ ...terminal, finalPayloadDigest: new Uint8Array(32).fill(0x54) }] },
    ];
    for (const substitution of coherentSubstitutions) {
      const bytes = encodeChanged(value, substitution);
      expect(bytes).not.toEqual(created.bytes);
      expect(() => verifyHumanLiveShadowClientVerificationV1(crypto, {
        verificationBytes: bytes,
        now: unixTimestamp(20_002),
        resolveCurrentAuthority: () => keys.publicKey,
      })).toThrow("signature is invalid");
    }
    let authorityContext: unknown;
    expect(verifyHumanLiveShadowClientVerificationV1(crypto, {
      verificationBytes: created.bytes,
      now: value.issuedAt,
      resolveCurrentAuthority: (context) => {
        authorityContext = context;
        return keys.publicKey;
      },
    })).toEqual(value);
    expect(authorityContext).toEqual({
      purpose: "human-live-shadow-client-verification",
      subjectHumanId: value.subjectHumanId,
      operationId: value.operationId,
      committerDeviceId: value.committerDeviceId,
      hostAuthorizationRevision: value.hostAuthorizationRevision,
    });
    for (const now of [unixTimestamp(value.issuedAt - 1), value.deadlineAt]) {
      expect(() => verifyHumanLiveShadowClientVerificationV1(crypto, {
        verificationBytes: created.bytes,
        now,
        resolveCurrentAuthority: () => keys.publicKey,
      })).toThrow("not currently valid");
    }
    expect(() => verifyHumanLiveShadowClientVerificationV1(crypto, {
      verificationBytes: created.bytes,
      now: value.issuedAt,
      resolveCurrentAuthority: () => null,
    })).toThrow("authority is unavailable");
    expect(() => verifyHumanLiveShadowClientVerificationV1(crypto, {
      verificationBytes: created.bytes,
      now: value.issuedAt,
      resolveCurrentAuthority: () => new Uint8Array(31),
    })).toThrow("public key is invalid");
    const otherKeys = crypto.generateSigningKeyPair();
    expect(() => verifyHumanLiveShadowClientVerificationV1(crypto, {
      verificationBytes: created.bytes,
      now: value.issuedAt,
      resolveCurrentAuthority: () => otherKeys.publicKey,
    })).toThrow("signature is invalid");
    expect(humanLiveShadowClientVerificationDigestV1(crypto, created.bytes))
      .toEqual(created.verificationDigest);
    const { signature: _signature, ...unsigned } = value;
    expect(humanLiveShadowClientVerificationSigningBytesV1(unsigned).length)
      .toBeGreaterThan(0);
  });

  test("rejects invalid or mismatched signing key material", () => {
    const { crypto, keys, created } = verificationFixture();
    const { formatVersion: _version, purpose: _purpose, signature: _signature, ...unsigned } = created.verification;
    expect(() => prepareHumanLiveShadowClientVerificationV1(crypto, {
      ...unsigned,
      committerSigningPublicKey: new Uint8Array(31),
      committerSigningPrivateKey: keys.privateKey,
    })).toThrow("public key length");
    expect(() => prepareHumanLiveShadowClientVerificationV1(crypto, {
      ...unsigned,
      committerSigningPublicKey: keys.publicKey,
      committerSigningPrivateKey: new Uint8Array(31),
    })).toThrow("private key length");
    const other = crypto.generateSigningKeyPair();
    expect(() => prepareHumanLiveShadowClientVerificationV1(crypto, {
      ...unsigned,
      committerSigningPublicKey: other.publicKey,
      committerSigningPrivateKey: keys.privateKey,
    })).toThrow("do not match");
  });
});
