import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import {
  decodeHumanLiveShadowMessageRequestV1,
  decodeLiveShadowMessagePlanV1,
  encodeHumanLiveShadowMessageRequestV1,
  encodeLiveShadowMessagePlanV1,
  humanLiveShadowMessageRequestDigestV1,
  humanLiveShadowMessageRequestSigningBytesV1,
  liveShadowMessagePlanDigestV1,
  prepareHumanLiveShadowMessageRequestV1,
  verifyHumanLiveShadowMessageRequestExactReplayV1,
  verifyHumanLiveShadowMessageRequestV1,
  type HumanLiveShadowMessageRequestV1,
  type LiveShadowMessagePlanV1,
} from "../../src/message/live-shadow-message-request-v1.ts";

const SESSION = "10000000-0000-4000-8000-000000000001";
const ROOM = "20000000-0000-4000-8000-000000000001";
const NOW = 1_800_000_000_000;

function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x282_01), { now: () => NOW });
  const signing = crypto.generateSigningKeyPair();
  const plan: LiveShadowMessagePlanV1 = {
    formatVersion: 1,
    purpose: "message.live_shadow_plan",
    operationId: "turn:live:alpha",
    policyRevision: 7,
    sessionId: SESSION,
    roomId: ROOM,
    humanMessageId: 41,
    revision: 0,
    createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId("human:alpha"),
    committerDeviceId: cryptoDeviceId("device:browser:alpha"),
    hostAuthorizationRevision: authorizationRevision(9),
    recipientAgentId: agentId("agent:alpha"),
    agentAuthorizationRevision: authorizationRevision(11),
    agentRuntimeGeneration: 0,
    agentSignerKeyId: `agent_runtime_signer_${"a".repeat(64)}`,
    agentSignerPublicKey: new Uint8Array(32).fill(8),
    namespaceId: namespaceId("namespace:room:alpha"),
    namespaceBindingHash: new Uint8Array(32).fill(1),
    namespaceAccessRevision: accessRevision(3),
    namespaceKeyGeneration: namespaceGeneration(4),
    bindingRevisionAtWrap: accessRevision(3),
    domainId: cryptoDomainId("domain:alpha"),
    domainEpoch: 5,
    recipientId: "recipient:turn:alpha",
    recipientKeyId: "recipient-key:turn:alpha",
    recipientPublicKey: new Uint8Array(65).fill(2),
    attemptCoordinate: "attempt:turn:alpha",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30_000),
  };
  const planBytes = encodeLiveShadowMessagePlanV1(plan);
  const created = prepareHumanLiveShadowMessageRequestV1(crypto, {
    subjectHumanId: plan.subjectHumanId,
    operationId: plan.operationId,
    policyRevision: plan.policyRevision,
    sessionId: plan.sessionId,
    roomId: plan.roomId,
    messageId: plan.humanMessageId,
    revision: 0,
    createdAt: plan.createdAt,
    recipientAgentId: plan.recipientAgentId,
    agentAuthorizationRevision: plan.agentAuthorizationRevision,
    cryptoObjectId: objectId("message:live-shadow:v1:alpha"),
    namespaceId: plan.namespaceId,
    namespaceBindingHash: plan.namespaceBindingHash,
    namespaceAccessRevision: plan.namespaceAccessRevision,
    namespaceKeyGeneration: plan.namespaceKeyGeneration,
    bindingRevisionAtWrap: plan.bindingRevisionAtWrap,
    domainId: plan.domainId,
    domainEpoch: plan.domainEpoch,
    recipientKeyId: plan.recipientKeyId,
    grantId: "grant:turn:alpha",
    grantDigest: new Uint8Array(32).fill(3),
    grantExpiresAt: plan.deadlineAt,
    planDigest: liveShadowMessagePlanDigestV1(crypto, planBytes),
    plaintextPayloadDigest: new Uint8Array(32).fill(4),
    encryptedPayloadDigest: new Uint8Array(32).fill(5),
    manifestDigest: new Uint8Array(32).fill(6),
    envelopeDigest: new Uint8Array(32).fill(7),
    issuedAt: plan.issuedAt,
    deadlineAt: plan.deadlineAt,
    committerDeviceId: plan.committerDeviceId,
    hostAuthorizationRevision: plan.hostAuthorizationRevision,
    committerSigningPublicKey: signing.publicKey,
    committerSigningPrivateKey: signing.privateKey,
  });
  const resolve = () => signing.publicKey;
  return { crypto, signing, plan, planBytes, created, resolve };
}

function mutate(
  request: HumanLiveShadowMessageRequestV1,
  changes: Partial<HumanLiveShadowMessageRequestV1>,
): Uint8Array {
  return encodeHumanLiveShadowMessageRequestV1({ ...request, ...changes });
}

describe("M282 live Shadow plan and Human request V1", () => {
  test("pins canonical plan and signed request bytes", () => {
    const { crypto, planBytes, created } = fixture();
    expect(decodeLiveShadowMessagePlanV1(planBytes).operationId)
      .toBe("turn:live:alpha");
    expect(decodeHumanLiveShadowMessageRequestV1(created.bytes).grantId)
      .toBe("grant:turn:alpha");
    expect(Buffer.from(crypto.hash(planBytes)).toString("hex")).toBe(
      "353c8f77eb15546ff48a0c1e613cf2b31fd3f798cdc8ae1ce5c168fb74bcd508",
    );
    expect(Buffer.from(created.requestDigest).toString("hex")).toBe(
      "303ad9f394098346224ca79b92a414dabdab649973a6b202bbd42973a651deb3",
    );
  });

  test("verifies freshness, current device authority, and exact replay", () => {
    const { crypto, created, resolve } = fixture();
    expect(verifyHumanLiveShadowMessageRequestV1(crypto, {
      requestBytes: created.bytes,
      now: unixTimestamp(NOW + 1),
      resolveCurrentAuthority: resolve,
    }).operationId).toBe("turn:live:alpha");
    expect(verifyHumanLiveShadowMessageRequestExactReplayV1(crypto, {
      requestBytes: created.bytes,
      expectedRequestDigest: created.requestDigest,
      resolveCurrentAuthority: resolve,
    }).operationId).toBe("turn:live:alpha");
    expect(humanLiveShadowMessageRequestDigestV1(crypto, created.bytes))
      .toEqual(created.requestDigest);
    expect(() => verifyHumanLiveShadowMessageRequestV1(crypto, {
      requestBytes: created.bytes,
      now: unixTimestamp(NOW + 30_000),
      resolveCurrentAuthority: resolve,
    })).toThrow(/currently valid/i);
  });

  test("rejects coordinate and digest substitution", () => {
    const { crypto, created, resolve } = fixture();
    for (const bytes of [
      mutate(created.request, { roomId: "20000000-0000-4000-8000-000000000002" }),
      mutate(created.request, { policyRevision: 8 }),
      mutate(created.request, { recipientKeyId: "recipient-key:substitute" }),
      mutate(created.request, { plaintextPayloadDigest: new Uint8Array(32).fill(9) }),
      mutate(created.request, { manifestDigest: new Uint8Array(32).fill(9) }),
    ]) {
      expect(() => verifyHumanLiveShadowMessageRequestV1(crypto, {
        requestBytes: bytes,
        now: unixTimestamp(NOW + 1),
        resolveCurrentAuthority: resolve,
      })).toThrow(/signature/i);
    }
    const wrongDigest = new Uint8Array(created.requestDigest);
    wrongDigest[0] = (wrongDigest[0] ?? 0) ^ 1;
    expect(() => verifyHumanLiveShadowMessageRequestExactReplayV1(crypto, {
      requestBytes: created.bytes,
      expectedRequestDigest: wrongDigest,
      resolveCurrentAuthority: resolve,
    })).toThrow(/digest disagrees/i);
  });

  test("rejects truncation and extension as noncanonical", () => {
    const { created, planBytes } = fixture();
    expect(() => decodeLiveShadowMessagePlanV1(planBytes.subarray(0, -1)))
      .toThrow();
    expect(() => decodeHumanLiveShadowMessageRequestV1(
      new Uint8Array([...created.bytes, 0]),
    )).toThrow();
  });

  test("validates every plan coordinate, bound, and exact field set", () => {
    const { plan, planBytes } = fixture();
    const encodeChangedPlan = (changes: Record<string, unknown>) =>
      encodeLiveShadowMessagePlanV1({ ...plan, ...changes } as LiveShadowMessagePlanV1);
    const invalid: readonly [string, unknown][] = [
      ["formatVersion", 2], ["purpose", "message.wrong"],
      ["operationId", ""], ["policyRevision", 0], ["policyRevision", 1.5],
      ["sessionId", `${SESSION}x`], ["roomId", ROOM.slice(0, -1)],
      ["humanMessageId", 0], ["humanMessageId", 2_147_483_648],
      ["revision", 1], ["createdAt", -1], ["subjectHumanId", ""],
      ["committerDeviceId", ""], ["hostAuthorizationRevision", -1],
      ["recipientAgentId", ""], ["agentAuthorizationRevision", -1],
      ["namespaceId", ""], ["namespaceBindingHash", new Uint8Array(31)],
      ["namespaceAccessRevision", -1], ["namespaceKeyGeneration", -1],
      ["bindingRevisionAtWrap", -1], ["domainId", ""], ["domainEpoch", -1],
      ["recipientId", ""], ["recipientKeyId", ""],
      ["recipientPublicKey", new Uint8Array(64)], ["attemptCoordinate", ""],
      ["issuedAt", -1], ["deadlineAt", plan.issuedAt],
      ["deadlineAt", unixTimestamp(plan.issuedAt + 30_001)],
    ];
    for (const [field, replacement] of invalid) {
      expect(() => encodeChangedPlan({ [field]: replacement }), field).toThrow();
    }
    expect(() => encodeLiveShadowMessagePlanV1({ ...plan, extra: true } as LiveShadowMessagePlanV1))
      .toThrow("invalid field set");
    const { attemptCoordinate: _attempt, ...missing } = plan;
    expect(() => encodeLiveShadowMessagePlanV1(missing as LiveShadowMessagePlanV1))
      .toThrow("invalid field set");
    expect(() => encodeLiveShadowMessagePlanV1(null as never)).toThrow("must be an object");
    expect(() => encodeLiveShadowMessagePlanV1([] as never)).toThrow("must be an object");
    expect(liveShadowMessagePlanDigestV1(fixture().crypto, planBytes))
      .toEqual(fixture().crypto.hash(planBytes));
  });

  test("validates every Human request coordinate and digest exactly", () => {
    const { created } = fixture();
    const value = created.request;
    const invalid: readonly [keyof HumanLiveShadowMessageRequestV1, unknown][] = [
      ["formatVersion", 2], ["purpose", "message.wrong"],
      ["normalizationVersion", 2], ["subjectHumanId", ""],
      ["operationId", ""], ["policyRevision", 0],
      ["policyRevision", 1.5], ["sessionId", `${SESSION}x`],
      ["roomId", ROOM.slice(0, -1)], ["messageId", 0],
      ["messageId", 2_147_483_648], ["revision", 1], ["createdAt", -1],
      ["recipientAgentId", ""], ["agentAuthorizationRevision", -1],
      ["cryptoObjectId", ""], ["namespaceId", ""],
      ["namespaceBindingHash", new Uint8Array(31)],
      ["namespaceAccessRevision", -1], ["namespaceKeyGeneration", -1],
      ["bindingRevisionAtWrap", -1], ["domainId", ""], ["domainEpoch", -1],
      ["recipientKeyId", ""], ["grantId", ""],
      ["grantDigest", new Uint8Array(31)], ["planDigest", new Uint8Array(33)],
      ["plaintextPayloadDigest", new Uint8Array(31)],
      ["encryptedPayloadDigest", new Uint8Array(33)],
      ["manifestDigest", new Uint8Array(31)], ["envelopeDigest", new Uint8Array(33)],
      ["issuedAt", -1], ["deadlineAt", value.issuedAt],
      ["deadlineAt", unixTimestamp(value.issuedAt + 30_001)],
      ["grantExpiresAt", unixTimestamp(value.deadlineAt - 1)],
      ["committerDeviceId", ""], ["hostAuthorizationRevision", -1],
      ["signature", new Uint8Array(63)],
    ];
    for (const [field, replacement] of invalid) {
      expect(() => mutate(value, { [field]: replacement } as Partial<HumanLiveShadowMessageRequestV1>), field)
        .toThrow();
    }
    expect(() => encodeHumanLiveShadowMessageRequestV1({ ...value, extra: true } as HumanLiveShadowMessageRequestV1))
      .toThrow("invalid field set");
    const { signature: _signature, ...missing } = value;
    expect(() => encodeHumanLiveShadowMessageRequestV1(missing as HumanLiveShadowMessageRequestV1))
      .toThrow("invalid field set");
    expect(() => encodeHumanLiveShadowMessageRequestV1(null as never)).toThrow("must be an object");
    expect(() => encodeHumanLiveShadowMessageRequestV1([] as never)).toThrow("must be an object");
    expect(humanLiveShadowMessageRequestSigningBytesV1(missing).length).toBeGreaterThan(0);
  });

  test("binds every valid Human request field and exact resolver context", () => {
    const { crypto, signing, created } = fixture();
    const value = created.request;
    const substitutions: readonly Partial<HumanLiveShadowMessageRequestV1>[] = [
      { subjectHumanId: humanId("human:beta") }, { operationId: "turn:live:beta" },
      { policyRevision: 8 }, { sessionId: "30000000-0000-4000-8000-000000000001" },
      { roomId: "40000000-0000-4000-8000-000000000001" }, { messageId: 42 },
      { createdAt: unixTimestamp(NOW + 1) }, { recipientAgentId: agentId("agent:beta") },
      { agentAuthorizationRevision: authorizationRevision(12) },
      { cryptoObjectId: objectId("message:live-shadow:v1:beta") },
      { namespaceId: namespaceId("namespace:room:beta") },
      { namespaceBindingHash: new Uint8Array(32).fill(0x21) },
      { namespaceAccessRevision: accessRevision(4) },
      { namespaceKeyGeneration: namespaceGeneration(5) },
      { bindingRevisionAtWrap: accessRevision(4) }, { domainId: cryptoDomainId("domain:beta") },
      { domainEpoch: 6 }, { recipientKeyId: "recipient-key:turn:beta" },
      { grantId: "grant:turn:beta" }, { grantDigest: new Uint8Array(32).fill(0x31) },
      { grantExpiresAt: unixTimestamp(NOW + 40_000) }, { planDigest: new Uint8Array(32).fill(0x32) },
      { plaintextPayloadDigest: new Uint8Array(32).fill(0x33) },
      { encryptedPayloadDigest: new Uint8Array(32).fill(0x34) },
      { manifestDigest: new Uint8Array(32).fill(0x35) },
      { envelopeDigest: new Uint8Array(32).fill(0x36) },
      { issuedAt: unixTimestamp(NOW + 1), deadlineAt: unixTimestamp(NOW + 30_000) },
      { deadlineAt: unixTimestamp(NOW + 29_999) },
      { committerDeviceId: cryptoDeviceId("device:browser:beta") },
      { hostAuthorizationRevision: authorizationRevision(10) },
    ];
    for (const substitution of substitutions) {
      const bytes = mutate(value, substitution);
      expect(bytes).not.toEqual(created.bytes);
      expect(() => verifyHumanLiveShadowMessageRequestV1(crypto, {
        requestBytes: bytes,
        now: unixTimestamp(NOW + 2),
        resolveCurrentAuthority: () => signing.publicKey,
      })).toThrow("signature is invalid");
    }
    let context: unknown;
    expect(verifyHumanLiveShadowMessageRequestV1(crypto, {
      requestBytes: created.bytes,
      now: value.issuedAt,
      resolveCurrentAuthority: (resolved) => {
        context = resolved;
        return signing.publicKey;
      },
    })).toEqual(value);
    expect(context).toEqual({
      purpose: "human-live-shadow-message-verify",
      subjectHumanId: value.subjectHumanId,
      operationId: value.operationId,
      committerDeviceId: value.committerDeviceId,
      hostAuthorizationRevision: value.hostAuthorizationRevision,
    });
    for (const now of [unixTimestamp(value.issuedAt - 1), value.deadlineAt, value.grantExpiresAt]) {
      expect(() => verifyHumanLiveShadowMessageRequestV1(crypto, {
        requestBytes: created.bytes,
        now,
        resolveCurrentAuthority: () => signing.publicKey,
      })).toThrow("not currently valid");
    }
    expect(() => verifyHumanLiveShadowMessageRequestV1(crypto, {
      requestBytes: created.bytes,
      now: value.issuedAt,
      resolveCurrentAuthority: () => null,
    })).toThrow("authority is unavailable");
    expect(() => verifyHumanLiveShadowMessageRequestV1(crypto, {
      requestBytes: created.bytes,
      now: value.issuedAt,
      resolveCurrentAuthority: () => new Uint8Array(31),
    })).toThrow("public key");
    const other = crypto.generateSigningKeyPair();
    expect(() => verifyHumanLiveShadowMessageRequestV1(crypto, {
      requestBytes: created.bytes,
      now: value.issuedAt,
      resolveCurrentAuthority: () => other.publicKey,
    })).toThrow("signature is invalid");
  });

  test("rejects invalid and mismatched Human signing keys", () => {
    const { crypto, signing, created } = fixture();
    const { formatVersion: _format, purpose: _purpose, normalizationVersion: _normalization, signature: _signature, ...unsigned } = created.request;
    expect(() => prepareHumanLiveShadowMessageRequestV1(crypto, {
      ...unsigned,
      committerSigningPublicKey: new Uint8Array(31),
      committerSigningPrivateKey: signing.privateKey,
    })).toThrow("public key");
    expect(() => prepareHumanLiveShadowMessageRequestV1(crypto, {
      ...unsigned,
      committerSigningPublicKey: signing.publicKey,
      committerSigningPrivateKey: new Uint8Array(31),
    })).toThrow("private key");
    const other = crypto.generateSigningKeyPair();
    expect(() => prepareHumanLiveShadowMessageRequestV1(crypto, {
      ...unsigned,
      committerSigningPublicKey: other.publicKey,
      committerSigningPrivateKey: signing.privateKey,
    })).toThrow("do not match");
  });
});
