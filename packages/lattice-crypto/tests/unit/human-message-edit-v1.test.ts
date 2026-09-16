import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeHumanLiveShadowMessageRequestV4,
  LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V4,
} from "../../src/message/live-shadow-message-request-v4.ts";
import {
  decodeHumanMessageEditPlanV1,
  decodeHumanMessageEditRequestV1,
  deriveHumanMessageEditCryptoObjectIdV1,
  encodeHumanMessageEditPlanV1,
  encodeHumanMessageEditRequestV1,
  HUMAN_MESSAGE_EDIT_MAX_TTL_MS_V1,
  parseHumanMessageEditCryptoObjectIdV1,
  prepareHumanMessageEditRequestV1,
  verifyHumanMessageEditRequestV1,
  type HumanMessageEditAuthorizationSchemeV1,
  type HumanMessageEditPlanV1,
  type HumanMessageEditPreparedTargetV1,
} from "../../src/message/human-message-edit-v1.ts";

const SOURCE = readFileSync(new URL(
  "../../src/message/human-message-edit-v1.ts",
  import.meta.url,
), "utf8");

const NOW = 1_800_000_000_000;
const ROOM = "20000000-0000-4000-8000-000000000318";
const SESSION_A = "10000000-0000-4000-8000-000000000318";
const SESSION_B = "10000000-0000-4000-8000-000000000319";
const OPERATION = "human-edit:v1:30000000-0000-4000-8000-000000000318";
const schemes: readonly HumanMessageEditAuthorizationSchemeV1[] = [
  "foreground_session_v1",
  "human_peer_v1",
  "shared_agent_v1",
  "human_ai_readable_v1",
];

const hash = (fill: number) => new Uint8Array(32).fill(fill);

function target(
  sessionId: string,
  messageId: number,
  keyClass: "human" | "ai",
): HumanMessageEditPreparedTargetV1 {
  return {
    sessionId, messageId, expectedRevision: 3, nextRevision: 4,
    createdAt: NOW - messageId,
    namespaceId: `namespace_${messageId}`, keyClass,
    namespaceAccessRevision: 7, namespaceKeyGeneration: 8,
    namespaceHeadDigest: hash(1), namespacePublicationDigest: hash(2),
    namespacePublicationSetDigest: hash(3),
    namespaceAudienceFingerprint: hash(4),
    cryptoObjectId: `conversation_message:${sessionId}:${messageId}:4`,
    plaintextPayloadDigest: hash(5), encryptedPayloadDigest: hash(6),
    manifestDigest: hash(7), envelopeDigest: hash(8),
  };
}

function fixture(scheme: HumanMessageEditAuthorizationSchemeV1) {
  const crypto = new LatticeCrypto(seededRng(318_001), { now: () => NOW });
  const signing = crypto.generateSigningKeyPair();
  const preparedTargets = [target(SESSION_A, 41, scheme === "human_peer_v1" ? "human" : "ai"),
    target(SESSION_B, 42, scheme === "human_peer_v1" ? "human" : "ai")];
  const plan: HumanMessageEditPlanV1 = {
    formatVersion: 1, purpose: "message.human_edit_plan",
    operationId: OPERATION, clientIdempotencyKey: `idem_${scheme}`,
    authorizationScheme: scheme, policyRevision: 12, roomId: ROOM,
    subjectHumanId: "human_m318", committerDeviceId: "device_m318",
    committerDeviceSigningKeyGeneration: 3, hostAuthorizationRevision: 9,
    targets: preparedTargets.map(({ plaintextPayloadDigest: _p,
      encryptedPayloadDigest: _e, manifestDigest: _m, envelopeDigest: _n,
      ...value }) => value),
    issuedAt: NOW, deadlineAt: NOW + 20_000,
  };
  const planBytes = encodeHumanMessageEditPlanV1(plan);
  const created = prepareHumanMessageEditRequestV1(crypto, {
    ...plan, planDigest: crypto.hash(planBytes), targets: preparedTargets,
    committerSigningPublicKey: signing.publicKey,
    committerSigningPrivateKey: signing.privateKey,
  });
  return { crypto, signing, plan, planBytes, created };
}

describe("M318 common Human message edit wire", () => {
  test("derives and strictly parses an operation-scoped edit object identity", () => {
    const coordinates = { operationId: OPERATION, sessionId: SESSION_A,
      messageId: 41, revision: 4 };
    const objectId = deriveHumanMessageEditCryptoObjectIdV1(coordinates);
    expect(objectId.length).toBeLessThanOrEqual(128);
    expect(parseHumanMessageEditCryptoObjectIdV1(objectId, coordinates)).toEqual({
      operationId: OPERATION,
      operationNonce: "30000000-0000-4000-8000-000000000318",
    });
    expect(() => parseHumanMessageEditCryptoObjectIdV1(objectId, {
      ...coordinates, messageId: 42,
    })).toThrow(/coordinates disagree/i);
    expect(() => parseHumanMessageEditCryptoObjectIdV1(objectId, {
      ...coordinates, revision: 5,
    })).toThrow(/coordinates disagree/i);
    expect(() => deriveHumanMessageEditCryptoObjectIdV1({
      ...coordinates, operationId: "human-edit:v1:not-a-uuid",
    })).toThrow(/operation ID is invalid/i);
    expect(() => parseHumanMessageEditCryptoObjectIdV1(
      objectId.replace("30000000", "40000000"), coordinates,
    )).toThrow(/coordinates disagree/i);
  });

  test("derives freshness and decoder allocation bounds from existing authorities", () => {
    expect(HUMAN_MESSAGE_EDIT_MAX_TTL_MS_V1)
      .toBe(LIVE_SHADOW_MESSAGE_REQUEST_MAX_TTL_MS_V4);
    expect(SOURCE).toContain("reader.readCount(bytes.length)");
    expect(SOURCE).toContain("reader.readFrame(bytes.length)");
    expect(SOURCE).not.toContain("MAX_HUMAN_MESSAGE_EDIT_PLAN_WIRE_BYTES_V1");
    expect(SOURCE).not.toContain("MAX_HUMAN_MESSAGE_EDIT_REQUEST_WIRE_BYTES_V1");
    expect(SOURCE).not.toContain("0xffff_ffff");
  });

  for (const scheme of schemes) {
    test(`round-trips and verifies exact ${scheme} fanout coordinates`, () => {
      const f = fixture(scheme);
      expect(decodeHumanMessageEditPlanV1(f.planBytes)).toEqual(f.plan);
      expect(decodeHumanMessageEditRequestV1(f.created.bytes))
        .toEqual(f.created.request);
      expect(verifyHumanMessageEditRequestV1(f.crypto, {
        requestBytes: f.created.bytes, planBytes: f.planBytes, now: NOW + 1,
        resolveCurrentAuthority: (identity) => {
          expect(identity).toEqual({ purpose: "human-message-edit-v1-verify",
            subjectHumanId: "human_m318", operationId: OPERATION,
            authorizationScheme: scheme, committerDeviceId: "device_m318",
            committerDeviceSigningKeyGeneration: 3,
            hostAuthorizationRevision: 9 });
          return f.signing.publicKey;
        },
      })).toEqual(f.created.request);
    });
  }

  test("rejects unordered, duplicated, gapped, and cross-revision target sets", () => {
    const f = fixture("foreground_session_v1");
    const first = f.plan.targets[0]!;
    expect(() => encodeHumanMessageEditPlanV1({ ...f.plan,
      targets: [f.plan.targets[1]!, first] })).toThrow(/ordered/);
    expect(() => encodeHumanMessageEditPlanV1({ ...f.plan,
      targets: [first, first] })).toThrow(/ordered/);
    expect(() => encodeHumanMessageEditPlanV1({ ...f.plan,
      targets: [{ ...first, nextRevision: 5 }, f.plan.targets[1]!] })).toThrow(/immediately/);
    expect(() => encodeHumanMessageEditPlanV1({ ...f.plan,
      targets: [first, { ...f.plan.targets[1]!, expectedRevision: 2,
        nextRevision: 3 }] })).toThrow(/share one expected/);
  });

  test("rejects identity, digest, target, revision, signature and freshness tampering", () => {
    const f = fixture("shared_agent_v1");
    const verify = (requestBytes: Uint8Array, planBytes = f.planBytes,
      now = NOW + 1, key: Uint8Array | null = f.signing.publicKey) =>
      verifyHumanMessageEditRequestV1(f.crypto, { requestBytes, planBytes, now,
        resolveCurrentAuthority: () => key });
    const mutate = (change: object) => encodeHumanMessageEditRequestV1({
      ...f.created.request, ...change,
    });
    expect(() => verify(mutate({ subjectHumanId: "human_other" }))).toThrow();
    expect(() => verify(mutate({ planDigest: hash(99) }))).toThrow();
    expect(() => verify(mutate({ targets: f.created.request.targets.map(
      (value, index) => index === 0 ? { ...value, cryptoObjectId: "wrong" } : value) }))).toThrow();
    expect(() => verify(mutate({ targets: f.created.request.targets.map(
      (value, index) => index === 0 ? { ...value, expectedRevision: 2,
        nextRevision: 3 } : value) }))).toThrow();
    const corrupt = f.created.bytes.slice();
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect(() => verify(corrupt)).toThrow(/authority/);
    expect(() => verify(f.created.bytes, f.planBytes, NOW + 20_000)).toThrow(/plan/);
    expect(() => verify(f.created.bytes, f.planBytes, NOW + 1, null)).toThrow(/authority/);
  });

  test("edit and create request domains cannot be reinterpreted", () => {
    const f = fixture("foreground_session_v1");
    expect(() => decodeHumanLiveShadowMessageRequestV4(f.created.bytes))
      .toThrow(/domain/);
  });
});
