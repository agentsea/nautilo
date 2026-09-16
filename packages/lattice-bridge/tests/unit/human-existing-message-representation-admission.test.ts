import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId as latticeNamespaceId,
  objectId as latticeObjectId,
  prepareHumanExistingMessageRepresentationPublicationRequest,
  unixTimestamp,
  type HumanExistingMessageRepresentationAuthorRole,
} from "@nautilo/lattice-crypto";

import { readPreparedConversationCryptoRevision } from
  "../../src/message/conversation-prepared-revision.ts";
import { deriveMessageCryptoObjectIdV2, conversationExistingRepresentationRepairIdentityDigest } from
  "../../src/message/conversation-repository.ts";
import {
  admitHumanExistingMessageRepresentation,
  admitHumanExistingMessageRepresentationReplay,
} from "../../src/message/human-existing-message-representation-admission.ts";
import { prepareHumanExistingMessageRepresentationCryptoRevision,
  prepareHumanPeerLiveShadowCryptoRevision } from
  "../../src/message/human-existing-message-representation-crypto.ts";
import {
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "../../src/message/message-payload-v2.ts";

function seededRng(seed: number) {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

function payload(role: HumanExistingMessageRepresentationAuthorRole): MessagePayloadV2 {
  if (role === "tool") {
    return { role, content: "tool result", toolName: "search" };
  }
  return { role, content: `existing ${role} bytes` };
}

function fixture(role: HumanExistingMessageRepresentationAuthorRole, keyClass: "ai" | "human" = "ai") {
  const crypto = new LatticeCrypto(
    { bytes: seededRng(0x280_10 + role.length) },
    { now: () => 1_800_000_000_000 },
  );
  const device = crypto.generateSigningKeyPair();
  const planBase = {
    subjectHumanId: "00000000-0000-4000-8000-000000000284",
    operationId: `operation-existing-${role}`,
    sessionId: "00000000-0000-4000-8000-000000000280",
    roomId: "00000000-0000-4000-8000-000000000281",
    messageId: 42,
    revision: 3,
    createdAt: 1_800_000_000_000,
    authorRole: role,
    authorHumanTurnId: role === "user" ? "human-turn-original" : null,
    sessionAgentId: "00000000-0000-4000-8000-000000000282",
    namespaceId: "00000000-0000-4000-8000-000000000283",
    namespaceBindingHash: new Uint8Array(32).fill(0x45),
    namespaceAccessRevision: 2,
    namespaceKeyGeneration: 1,
    bindingRevisionAtWrap: 2,
    keyClass,
  };
  const objectId = deriveMessageCryptoObjectIdV2(planBase);
  const authoritativePlaintext = payload(role);
  const prepare = keyClass === "ai"
    ? prepareHumanExistingMessageRepresentationCryptoRevision
    : prepareHumanPeerLiveShadowCryptoRevision;
  const client = prepare({
    crypto,
    objectId,
    payload: authoritativePlaintext,
    createdAt: planBase.createdAt,
    namespace: {
      namespaceId: planBase.namespaceId,
      accessRevision: planBase.namespaceAccessRevision,
      keyGeneration: planBase.namespaceKeyGeneration,
      aiKey: new Uint8Array(32).fill(0x66),
      humanKey: new Uint8Array(32).fill(0x66),
    },
    device: {
      deviceId: "device-existing-representation",
      hostAuthorizationRevision: 8,
      signingPrivateKey: device.privateKey,
    },
    resolveCurrentAuthorization: () => null,
  });
  const snapshot = readPreparedConversationCryptoRevision(client);
  const plaintextBytes = encodeMessagePayloadV2(authoritativePlaintext);
  const request = prepareHumanExistingMessageRepresentationPublicationRequest(
    crypto,
    {
      subjectHumanId: humanId(planBase.subjectHumanId),
      operationId: planBase.operationId,
      sessionId: planBase.sessionId,
      roomId: planBase.roomId,
      messageId: planBase.messageId,
      revision: planBase.revision,
      createdAt: unixTimestamp(planBase.createdAt),
      authorRole: role,
      authorHumanTurnId: planBase.authorHumanTurnId,
      sessionAgentId: agentId(planBase.sessionAgentId),
      cryptoObjectId: latticeObjectId(objectId),
      namespaceId: latticeNamespaceId(planBase.namespaceId),
      namespaceBindingHash: planBase.namespaceBindingHash,
      namespaceAccessRevision: planBase.namespaceAccessRevision,
      namespaceKeyGeneration: planBase.namespaceKeyGeneration,
      bindingRevisionAtWrap: planBase.bindingRevisionAtWrap,
      ciphertextPayloadHash: crypto.hash(snapshot.object.payloadBytes.ciphertext),
      plaintextPayloadHash: crypto.hash(plaintextBytes),
      accessManifestHash: crypto.hash(snapshot.access.manifestBytes),
      envelopeHash: crypto.hash(snapshot.access.envelopeBytes[0]!),
      issuedAt: unixTimestamp(1_800_000_000_000),
      deadlineAt: unixTimestamp(1_800_000_010_000),
      committerDeviceId: cryptoDeviceId("device-existing-representation"),
      hostAuthorizationRevision: authorizationRevision(8),
      committerSigningPublicKey: device.publicKey,
      committerSigningPrivateKey: device.privateKey,
    },
  );
  plaintextBytes.fill(0);
  return {
    crypto,
    device,
    plan: { ...planBase, objectId },
    authoritativePlaintext,
    request,
    snapshot,
  };
}

describe("Human existing Message representation admission", () => {
  test.each(["ai", "human"] as const)("admits exact user, assistant, tool, and system bytes under current Human authority using %s keys", async (keyClass) => {
    for (const role of ["user", "assistant", "tool", "system"] as const) {
      const state = fixture(role, keyClass);
      let authorityCalls = 0;
      const admitted = await admitHumanExistingMessageRepresentation({
        crypto: state.crypto,
        productPlan: state.plan,
        authoritativePlaintext: state.authoritativePlaintext,
        requestBytes: state.request.bytes,
        payloadBytes: state.snapshot.object.payloadBytes.ciphertext,
        manifestBytes: state.snapshot.access.manifestBytes,
        envelopeBytes: state.snapshot.access.envelopeBytes,
        now: 1_800_000_000_001,
        resolveCurrentHumanAuthority: (context) => {
          authorityCalls += 1;
          expect(context.purpose).toBe(
            "human-existing-message-representation-publication-verify",
          );
          expect(context).not.toHaveProperty("agentId");
          expect(context).not.toHaveProperty("grantId");
          return state.device.publicKey;
        },
      });
      expect(admitted.prepared).toMatchObject({
        objectId: state.plan.objectId,
        namespaceId: state.plan.namespaceId,
        keyClass,
      });
      expect(authorityCalls).toBeGreaterThan(0);
      expect(state.plan.authorRole).toBe(role);
      expect(String(state.request.request.subjectHumanId)).toBe(
        "00000000-0000-4000-8000-000000000284",
      );
    }
  });

  test("fails closed on product, author, payload, Room, Namespace, device, and deadline substitution", async () => {
    const state = fixture("assistant");
    const base = {
      crypto: state.crypto,
      productPlan: state.plan,
      authoritativePlaintext: state.authoritativePlaintext,
      requestBytes: state.request.bytes,
      payloadBytes: state.snapshot.object.payloadBytes.ciphertext,
      manifestBytes: state.snapshot.access.manifestBytes,
      envelopeBytes: state.snapshot.access.envelopeBytes,
      now: 1_800_000_000_001,
      resolveCurrentHumanAuthority: () => state.device.publicKey,
    };
    for (const productPlan of [
      { ...state.plan, keyClass: "human" as const },
      { ...state.plan, subjectHumanId: "00000000-0000-4000-8000-000000000298" },
      { ...state.plan, operationId: "operation-substituted" },
      { ...state.plan, roomId: "00000000-0000-4000-8000-000000000299" },
      { ...state.plan, messageId: 43 },
      { ...state.plan, revision: 4 },
      { ...state.plan, createdAt: state.plan.createdAt + 1 },
      { ...state.plan, authorRole: "tool" as const },
      { ...state.plan, authorHumanTurnId: "invented-human-turn" },
      { ...state.plan, sessionAgentId: "00000000-0000-4000-8000-000000000299" },
      { ...state.plan, objectId: "message:v2:substituted" },
      { ...state.plan, namespaceId: "00000000-0000-4000-8000-000000000299" },
      { ...state.plan, namespaceBindingHash: new Uint8Array(32).fill(0x46) },
      { ...state.plan, namespaceAccessRevision: state.plan.namespaceAccessRevision + 1 },
      { ...state.plan, namespaceKeyGeneration: state.plan.namespaceKeyGeneration + 1 },
      { ...state.plan, bindingRevisionAtWrap: state.plan.bindingRevisionAtWrap + 1 },
    ]) {
      expect(admitHumanExistingMessageRepresentation({
        ...base,
        productPlan,
      })).rejects.toThrow();
    }
    expect(admitHumanExistingMessageRepresentation({
      ...base,
      authoritativePlaintext: { role: "tool", content: "different role", toolName: "x" },
    })).rejects.toThrow(/authorship disagree/i);
    expect(admitHumanExistingMessageRepresentation({
      ...base,
      authoritativePlaintext: { role: "assistant", content: "different bytes" },
    })).rejects.toThrow(/signed crypto facts disagree/i);
    expect(admitHumanExistingMessageRepresentation({
      ...base,
      now: 1_800_000_010_000,
    })).rejects.toThrow(/not currently valid/i);
    expect(admitHumanExistingMessageRepresentation({
      ...base,
      resolveCurrentHumanAuthority: () => null,
    })).rejects.toThrow(/authority is unavailable/i);
    expect(admitHumanExistingMessageRepresentation({
      ...base,
      resolveCurrentHumanAuthority: () =>
        state.crypto.generateSigningKeyPair().publicKey,
    })).rejects.toThrow(/signature is invalid/i);
  });

  test("verifies a response-loss replay from exact durable bytes without minting a second write", async () => {
    const state = fixture("system");
    const admitted = await admitHumanExistingMessageRepresentation({
      crypto: state.crypto,
      productPlan: state.plan,
      authoritativePlaintext: state.authoritativePlaintext,
      requestBytes: state.request.bytes,
      payloadBytes: state.snapshot.object.payloadBytes.ciphertext,
      manifestBytes: state.snapshot.access.manifestBytes,
      envelopeBytes: state.snapshot.access.envelopeBytes,
      now: 1_800_000_000_001,
      resolveCurrentHumanAuthority: () => state.device.publicKey,
    });
    const replay = await admitHumanExistingMessageRepresentationReplay({
      crypto: state.crypto,
      productPlan: state.plan,
      authoritativePlaintext: state.authoritativePlaintext,
      requestBytes: state.request.bytes,
      storedPayloadBytes: state.snapshot.object.payloadBytes.ciphertext,
      storedManifestBytes: state.snapshot.access.manifestBytes,
      storedEnvelopeBytes: state.snapshot.access.envelopeBytes,
      durableAllocationRequestDigest: admitted.allocationRequestDigest,
      resolveCurrentHumanAuthority: () => state.device.publicKey,
    });
    expect(replay).toEqual({
      allocationRequestDigest: admitted.allocationRequestDigest,
      operationId: state.plan.operationId,
      objectId: state.plan.objectId,
    });
    expect(replay).not.toHaveProperty("prepared");

    const wrongDigest = admitted.allocationRequestDigest.slice();
    wrongDigest[0] = wrongDigest[0]! ^ 1;
    expect(admitHumanExistingMessageRepresentationReplay({
      crypto: state.crypto,
      productPlan: state.plan,
      authoritativePlaintext: state.authoritativePlaintext,
      requestBytes: state.request.bytes,
      storedPayloadBytes: state.snapshot.object.payloadBytes.ciphertext,
      storedManifestBytes: state.snapshot.access.manifestBytes,
      storedEnvelopeBytes: state.snapshot.access.envelopeBytes,
      durableAllocationRequestDigest: wrongDigest,
      resolveCurrentHumanAuthority: () => state.device.publicKey,
    })).rejects.toThrow(/durable digest/i);
  });
});

// Independently computed from the issued V1 UTF-8 preimage plus 32 raw 0x42 bytes.
test.each([
  ["user", "3d6851125474a51604646ff129aabb8499b88d78d7b278877cf0ed1696d4a190"],
  ["assistant", "4b35533746c8bd210493296857a1c1713ffa6600d356621cc835bb3e92e858f1"],
  ["tool", "fed3b4561155ed1a81e1d782247960a566b430e0751beb08096d547177ab1b75"],
  ["system", "9105181a7a7db4eecd5ca79db9335f69b954ded19202f38753cf76ade51f0099"],
] as const)("pins issued AI repair identity bytes for %s", (authorRole, expected) => {
  const input = { sessionId: "11111111-1111-4111-8111-111111111111", messageId: 42,
    revision: 0, namespaceId: "22222222-2222-4222-8222-222222222222", authorRole,
    authorityFingerprint: new Uint8Array(32).fill(0x42), policyRevision: 3 };
  expect(Buffer.from(conversationExistingRepresentationRepairIdentityDigest(input)).toString("hex")).toBe(expected);
  expect(Buffer.from(conversationExistingRepresentationRepairIdentityDigest({ ...input, keyClass: "ai" })).toString("hex")).toBe(expected);
  expect(Buffer.from(conversationExistingRepresentationRepairIdentityDigest({ ...input, keyClass: "human" })).toString("hex")).not.toBe(expected);
});
