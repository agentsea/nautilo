import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeHumanHistoryReadAcknowledgementV1,
  encodeHumanHistoryReadAcknowledgementV1,
  humanHistoryReadAcknowledgementSigningBytesV1,
  humanHistoryReadResultSetDigestV1,
  humanHistoryReadSelectedCoordinateDigestV1,
  prepareHumanHistoryReadAcknowledgementV1,
  verifyHumanHistoryReadAcknowledgementV1,
  type HumanHistoryReadAcknowledgementV1,
  type HumanHistoryReadResultCountsV1,
} from "../../src/message/history-read-acknowledgement-v1.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const ROOM = "22222222-2222-4222-8222-222222222222";
const OTHER_ROOM = "33333333-3333-4333-8333-333333333333";

const COUNTS: HumanHistoryReadResultCountsV1 = {
  verified: 2,
  clientCryptoUnavailable: 0,
  clientCustodyUnavailable: 0,
  currentReadAuthorityUnavailable: 0,
  retainedKeyMaterialUnavailable: 1,
  signerEvidenceUnavailable: 0,
  liveShadowLifecycleUnavailable: 0,
  integrityFailure: 0,
  parityMismatch: 0,
};

function fixture() {
  const crypto = new LatticeCrypto(seededRng(275_22));
  const keys = crypto.generateSigningKeyPair();
  const orderedResultSetDigest = humanHistoryReadResultSetDigestV1(crypto, [
    {
      coordinateDigest: new Uint8Array(32).fill(0x21),
      outcome: "verified",
      reason: "none",
    },
    {
      coordinateDigest: new Uint8Array(32).fill(0x22),
      outcome: "unavailable",
      reason: "retained_key_material_unavailable",
    },
    {
      coordinateDigest: new Uint8Array(32).fill(0x23),
      outcome: "verified",
      reason: "none",
    },
  ]);
  const created = prepareHumanHistoryReadAcknowledgementV1(crypto, {
    operationId: "history_read_operation_alpha",
    clientRequestKey: "room_page_request_alpha",
    policyRevision: 19,
    subjectHumanId: humanId("human_alpha"),
    readerDeviceId: cryptoDeviceId("browser_device_alpha"),
    readerDeviceSigningKeyGeneration: 4,
    hostAuthorizationRevision: authorizationRevision(8),
    roomId: ROOM,
    selectedCoordinateDigest: new Uint8Array(32).fill(0x11),
    eligibleCount: 3,
    resultCounts: COUNTS,
    orderedResultSetDigest,
    issuedAt: unixTimestamp(50_000),
    deadlineAt: unixTimestamp(80_000),
    readerSigningPublicKey: keys.publicKey,
    readerSigningPrivateKey: keys.privateKey,
  });
  return { crypto, keys, created };
}

function changedBytes(
  value: HumanHistoryReadAcknowledgementV1,
  change: Record<string, unknown>,
): Uint8Array {
  return encodeHumanHistoryReadAcknowledgementV1({
    ...value,
    ...change,
  } as HumanHistoryReadAcknowledgementV1);
}

describe("M275 Human history-read acknowledgement V1", () => {
  test("round-trips strict canonical content-free bytes and verifies planned authority", () => {
    const { crypto, keys, created } = fixture();
    expect(encodeHumanHistoryReadAcknowledgementV1(created.acknowledgement))
      .toEqual(created.bytes);
    expect(decodeHumanHistoryReadAcknowledgementV1(created.bytes))
      .toEqual(created.acknowledgement);
    expect(created.bytes.length).toBe(466);
    expect(Buffer.from(crypto.hash(created.bytes)).toString("hex")).toBe(
      "701409cf79b34fd9180f84ec01abbb477e4f19bbd2744548d9fd4fc2fd7e7474",
    );
    const { signature: _signature, ...unsigned } = created.acknowledgement;
    expect(humanHistoryReadAcknowledgementSigningBytesV1(unsigned).length)
      .toBeGreaterThan(0);

    let resolved: unknown;
    const verified = verifyHumanHistoryReadAcknowledgementV1(crypto, {
      acknowledgementBytes: created.bytes,
      now: unixTimestamp(60_000),
      resolvePlannedAuthority: (context) => {
        resolved = context;
        return keys.publicKey;
      },
    });
    expect(verified.resultCounts).toEqual(COUNTS);
    expect(resolved).toEqual({
      purpose: "human-history-read-acknowledgement",
      subjectHumanId: "human_alpha",
      operationId: "history_read_operation_alpha",
      readerDeviceId: "browser_device_alpha",
      readerDeviceSigningKeyGeneration: 4,
      hostAuthorizationRevision: 8,
    });
    const ascii = new TextDecoder().decode(created.bytes);
    for (const forbidden of [
      "message text",
      "tool arguments",
      "ciphertext",
      "room name",
      "display name",
    ]) expect(ascii).not.toContain(forbidden);
  });

  test("binds every mutable acknowledgement field to the signature", () => {
    const { crypto, keys, created } = fixture();
    const original = created.acknowledgement;
    const mutations: readonly Record<string, unknown>[] = [
      { operationId: "history_read_operation_beta" },
      { clientRequestKey: "room_page_request_beta" },
      { policyRevision: 20 },
      { subjectHumanId: humanId("human_beta") },
      { readerDeviceId: cryptoDeviceId("browser_device_beta") },
      { readerDeviceSigningKeyGeneration: 5 },
      { hostAuthorizationRevision: authorizationRevision(9) },
      { roomId: OTHER_ROOM },
      { selectedCoordinateDigest: new Uint8Array(32).fill(0x12) },
      {
        resultCounts: {
          ...COUNTS,
          verified: 1,
          parityMismatch: 1,
        },
      },
      { orderedResultSetDigest: new Uint8Array(32).fill(0x31) },
      { issuedAt: unixTimestamp(49_999) },
      { deadlineAt: unixTimestamp(80_001) },
    ];
    for (const mutation of mutations) {
      const bytes = changedBytes(original, mutation);
      expect(() => verifyHumanHistoryReadAcknowledgementV1(crypto, {
        acknowledgementBytes: bytes,
        now: unixTimestamp(60_000),
        resolvePlannedAuthority: () => keys.publicKey,
      })).toThrow("signature is invalid");
    }
  });

  test("rejects count non-closure, unknown fields, invalid reason pairs, and expiry", () => {
    const { crypto, keys, created } = fixture();
    expect(() => changedBytes(created.acknowledgement, {
      resultCounts: { ...COUNTS, verified: 1 },
    })).toThrow("do not close");
    expect(() => encodeHumanHistoryReadAcknowledgementV1({
      ...created.acknowledgement,
      unexpected: "field",
    } as never)).toThrow("invalid field set");
    expect(() => humanHistoryReadResultSetDigestV1(crypto, [{
      coordinateDigest: new Uint8Array(32),
      outcome: "verified",
      reason: "parity_mismatch",
    }])).toThrow("outcome and reason disagree");
    expect(() => verifyHumanHistoryReadAcknowledgementV1(crypto, {
      acknowledgementBytes: created.bytes,
      now: unixTimestamp(80_000),
      resolvePlannedAuthority: () => keys.publicKey,
    })).toThrow("not currently valid");
  });

  test("ordered result-set digest changes with order, coordinate, or result", () => {
    const crypto = new LatticeCrypto(seededRng(275_23));
    const first = {
      coordinateDigest: new Uint8Array(32).fill(1),
      outcome: "verified" as const,
      reason: "none" as const,
    };
    const second = {
      coordinateDigest: new Uint8Array(32).fill(2),
      outcome: "failed" as const,
      reason: "integrity_failure" as const,
    };
    const baseline = humanHistoryReadResultSetDigestV1(crypto, [first, second]);
    expect(humanHistoryReadResultSetDigestV1(crypto, [second, first]))
      .not.toEqual(baseline);
    expect(humanHistoryReadResultSetDigestV1(crypto, [
      first,
      { ...second, coordinateDigest: new Uint8Array(32).fill(3) },
    ])).not.toEqual(baseline);
    expect(humanHistoryReadResultSetDigestV1(crypto, [
      first,
      { ...second, outcome: "unavailable", reason: "signer_evidence_unavailable" },
    ])).not.toEqual(baseline);
  });

  test("selected-coordinate digest binds order and the complete selected tuple", () => {
    const crypto = new LatticeCrypto(seededRng(275_24));
    const first = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      messageId: 41,
      editRevision: 0,
      role: "user",
      logicalMessageKey: "turn:human-41",
    };
    const second = {
      sessionId: "22222222-2222-4222-8222-222222222222",
      messageId: 42,
      editRevision: 3,
      role: "assistant",
      logicalMessageKey: "row:42",
    };
    const baseline = humanHistoryReadSelectedCoordinateDigestV1(
      crypto,
      [first, second],
    );
    expect(humanHistoryReadSelectedCoordinateDigestV1(crypto, [second, first]))
      .not.toEqual(baseline);
    for (const replacement of [
      { ...second, messageId: 43 },
      { ...second, editRevision: 4 },
      { ...second, role: "tool" },
      { ...second, logicalMessageKey: "row:other" },
      { ...second, sessionId: "33333333-3333-4333-8333-333333333333" },
    ]) expect(humanHistoryReadSelectedCoordinateDigestV1(
      crypto,
      [first, replacement],
    )).not.toEqual(baseline);
    expect(() => humanHistoryReadSelectedCoordinateDigestV1(
      crypto,
      [first, { ...first }],
    )).toThrow("duplicated");
  });

  test("rejects malformed or noncanonical wire bytes", () => {
    const { created } = fixture();
    expect(() => decodeHumanHistoryReadAcknowledgementV1(
      created.bytes.subarray(0, created.bytes.length - 1),
    )).toThrow();
    const trailing = new Uint8Array(created.bytes.length + 1);
    trailing.set(created.bytes);
    expect(() => decodeHumanHistoryReadAcknowledgementV1(trailing)).toThrow();
  });
});
