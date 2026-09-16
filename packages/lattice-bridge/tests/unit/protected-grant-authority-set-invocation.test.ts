import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  grantWriteRecord,
  humanId,
  mintGrant,
  namespaceId,
  objectId,
  unixTimestamp,
  type GrantAuthoritySetUseAuthorizationContext,
  type GrantAuthoritySetUseAuthorizationDecision,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
  encodeBackgroundWorkDescriptorV2,
  serializeGrantV2,
} from "@nautilo/lattice-crypto/wire";

import {
  createProtectedInvocationCapability,
  createProtectedInvocationRecipient,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthoritySetFactsV2,
  type ProtectedGrantAuthoritySetPortV2,
} from "../../src/invocation/protected-grant-invocation";
import {
  executeProtectedSyntheticBackgroundWorkV2,
  protectedSyntheticBackgroundObjectAadV2,
} from "../../src/testing/index";
import { createFakeLatticeStorage } from "../../src/testing/fake-lattice-storage";

const NOW = 8_500_000;

function seededRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9;
  return {
    bytes(length: number): Uint8Array {
      const value = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        value[index] = state & 0xff;
      }
      return value;
    },
  };
}

function allow(
  context: GrantAuthoritySetUseAuthorizationContext,
): GrantAuthoritySetUseAuthorizationDecision {
  return Object.freeze({
    context,
    currentTime: NOW + 2,
    issuingDeviceActive: true,
    recipientAgentAuthorized: true,
    requestedNamespacesAuthorized: true,
    requestedDomainsAuthorized: true,
    hostAllowsOperation: true,
    currentSingleUseStatus: context.singleUseStatus,
  });
}

describe("Wave 11 protected Grant authority-set invocation", () => {
  test("keeps three exact Domains and four Namespaces inside one terminal capability", async () => {
    const crypto = new LatticeCrypto(seededRng(12_001), { now: () => NOW });
    const issuer = crypto.generateSigningKeyPair();
    const recipient = await createProtectedInvocationRecipient({
      crypto,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "background-key",
    });
    const roots = [
      new Uint8Array(32).fill(0xa1),
      new Uint8Array(32).fill(0xb2),
      new Uint8Array(32).fill(0xc3),
    ];
    const grant = await mintGrant(crypto, {
      id: grantId("grant-wave-11-set"),
      issuingDeviceId: cryptoDeviceId("alice-phone"),
      issuingHumanId: humanId("alice"),
      issuingDeviceSigningPrivateKey: issuer.privateKey,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "background-key",
      recipientEncryptionPublicKey: recipient.publicKey,
      scope: [humanId("alice")],
      operations: ["decrypt", "encrypt"],
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
      coveredDomains: [
        {
          domainId: cryptoDomainId("domain-a"),
          domainEpoch: domainEpoch(4),
          agentAuthorizationRevision: authorizationRevision(8),
          aiRoot: roots[0]!,
        },
        {
          domainId: cryptoDomainId("domain-b"),
          domainEpoch: domainEpoch(5),
          agentAuthorizationRevision: authorizationRevision(9),
          aiRoot: roots[1]!,
        },
        {
          domainId: cryptoDomainId("domain-c"),
          domainEpoch: domainEpoch(6),
          agentAuthorizationRevision: authorizationRevision(10),
          aiRoot: roots[2]!,
        },
      ],
      singleUse: true,
    });
    const { storage } = createFakeLatticeStorage();
    await storage.putGrant(grantWriteRecord(serializeGrantV2(grant)));
    const coordinates = Object.freeze({
      invocationId: "invocation-wave-11-set",
      grantId: grant.id,
      issuingHumanId: "alice",
      recipientAgentId: grant.recipientAgentId,
      recipientKeyId: grant.recipientKeyId,
      issuingDeviceId: grant.issuingDeviceId,
      namespaceIds: Object.freeze(["room-a", "room-b", "room-c", "room-d"]),
      domainIds: Object.freeze(["domain-a", "domain-b", "domain-c"]),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    });
    const facts: ProtectedGrantAuthoritySetFactsV2 = Object.freeze({
      now: NOW + 1,
      expectedIssuingDeviceId: "alice-phone",
      issuingDeviceHumanId: "alice",
      issuingDeviceSigningPublicKey: issuer.publicKey,
      issuingDeviceActive: true,
      recipientAgentId: "genie",
      recipientKeyId: "background-key",
      singleUseAvailable: true,
      grantScope: ["alice"],
      namespaceRequirements: [
        {
          namespaceId: namespaceId("room-a"),
          domainId: cryptoDomainId("domain-a"),
          operations: ["decrypt"] as const,
          namespaceParticipants: ["alice"],
          expectedAccessRevision: accessRevision(2),
          expectedPolicyRevision: 3,
        },
        {
          namespaceId: namespaceId("room-b"),
          domainId: cryptoDomainId("domain-a"),
          operations: ["encrypt"] as const,
          namespaceParticipants: ["alice"],
          expectedAccessRevision: accessRevision(3),
          expectedPolicyRevision: 4,
        },
        {
          namespaceId: namespaceId("room-c"),
          domainId: cryptoDomainId("domain-b"),
          operations: ["decrypt", "encrypt"] as const,
          namespaceParticipants: ["alice", "bob"],
          expectedAccessRevision: accessRevision(4),
          expectedPolicyRevision: 5,
        },
        {
          namespaceId: namespaceId("room-d"),
          domainId: cryptoDomainId("domain-c"),
          operations: ["decrypt", "encrypt"] as const,
          namespaceParticipants: ["alice", "dana"],
          expectedAccessRevision: accessRevision(5),
          expectedPolicyRevision: 6,
        },
      ],
      domainRequirements: [
        {
          domainId: cryptoDomainId("domain-a"),
          expectedEpoch: domainEpoch(4),
          expectedAgentAuthorizationRevision: authorizationRevision(8),
        },
        {
          domainId: cryptoDomainId("domain-b"),
          expectedEpoch: domainEpoch(5),
          expectedAgentAuthorizationRevision: authorizationRevision(9),
        },
        {
          domainId: cryptoDomainId("domain-c"),
          expectedEpoch: domainEpoch(6),
          expectedAgentAuthorizationRevision: authorizationRevision(10),
        },
      ],
      hostAllowsOperation: true,
    });
    const phases: string[] = [];
    const authority: ProtectedGrantAuthoritySetPortV2 = {
      resolvePreflightFacts: (request) => {
        phases.push(request.phase);
        return facts;
      },
      resolveCurrentAuthorization: (context) => {
        phases.push(context.phase);
        return allow(context);
      },
    };
    const capability = createProtectedInvocationCapability({
      coordinates,
      recipient: recipient.recipient,
    });
    const descriptorBytes = encodeBackgroundWorkDescriptorV2({
      formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
      requestId: "request-wave-11-set",
      recipientGeneration: 0,
      workKind: "memory.review",
      workId: "work-wave-11-set",
      anchorNamespaceId: namespaceId("room-a"),
      anchorDomainId: cryptoDomainId("domain-a"),
      subject: {
        kind: "agent",
        agentId: agentId("genie"),
        runtimeGeneration: agentRuntimeGeneration(3),
        authorizationRevision: authorizationRevision(7),
      },
      purpose: "memory.review",
      operations: ["decrypt", "encrypt"],
      source: {
        kind: "synthetic_payload",
        generation: 1,
        fingerprint: new Uint8Array(32).fill(0x44),
      },
      grantScope: [humanId("alice")],
      inputBindings: [
        {
          objectId: objectId("input-a"),
          namespaceId: namespaceId("room-a"),
        },
        {
          objectId: objectId("input-c"),
          namespaceId: namespaceId("room-c"),
        },
        {
          objectId: objectId("input-d"),
          namespaceId: namespaceId("room-d"),
        },
      ],
      outputSlots: [{
        objectId: objectId("output-bc"),
        objectType: "synthetic.result",
        createdAt: unixTimestamp(NOW),
        namespaceIds: [
          namespaceId("room-b"),
          namespaceId("room-c"),
          namespaceId("room-d"),
        ],
      }],
      namespaceRequirements: facts.namespaceRequirements.map((entry) => ({
        namespaceId: entry.namespaceId,
        domainId: entry.domainId,
        operations: entry.operations,
        expectedAccessRevision: entry.expectedAccessRevision,
        expectedPolicyRevision: authorizationRevision(
          entry.expectedPolicyRevision,
        ),
      })),
      domainRequirements: facts.domainRequirements,
      maximumInputObjectCount: 3,
      maximumOutputObjectCount: 1,
      maximumPlaintextBytes: 1_024,
      maximumCiphertextBytes: 1_024,
      recipientKeyId: "background-key",
      recipientPublicKey: recipient.publicKey,
      issuedAt: NOW,
      notBefore: NOW,
      expiresAt: NOW + 60_000,
      idempotencyId: "idempotency-wave-11-set",
    });
    const inputA = new TextEncoder().encode("alpha");
    const inputC = new TextEncoder().encode("charlie");
    const inputD = new TextEncoder().encode("delta");
    const encryptedInputs = [
      {
        objectId: "input-a",
        namespaceId: "room-a",
        ciphertext: crypto.aeadSeal(
          roots[0]!,
          inputA,
          protectedSyntheticBackgroundObjectAadV2({
            objectId: "input-a",
            namespaceId: "room-a",
          }),
        ),
      },
      {
        objectId: "input-c",
        namespaceId: "room-c",
        ciphertext: crypto.aeadSeal(
          roots[1]!,
          inputC,
          protectedSyntheticBackgroundObjectAadV2({
            objectId: "input-c",
            namespaceId: "room-c",
          }),
        ),
      },
      {
        objectId: "input-d",
        namespaceId: "room-d",
        ciphertext: crypto.aeadSeal(
          roots[2]!,
          inputD,
          protectedSyntheticBackgroundObjectAadV2({
            objectId: "input-d",
            namespaceId: "room-d",
          }),
        ),
      },
    ];
    const borrowedPlaintexts: Uint8Array[] = [];
    let outputPlaintext: Uint8Array | null = null;

    const result = await executeProtectedSyntheticBackgroundWorkV2({
      capability,
      crypto,
      storage,
      authority,
      descriptorBytes,
      expectedDescriptorHash: crypto.hash(descriptorBytes),
      encryptedInputs,
      transform: (inputs) => {
        borrowedPlaintexts.push(...inputs.map((entry) => entry.plaintext));
        expect(inputs.map((entry) => new TextDecoder().decode(entry.plaintext)))
          .toEqual(["alpha", "charlie", "delta"]);
        outputPlaintext = new TextEncoder().encode("alpha+charlie+delta");
        return {
          value: "complete",
          outputs: [{
            objectId: "output-bc",
            plaintext: outputPlaintext,
          }],
        };
      },
    });
    expect(result).toMatchObject({
      status: "executed",
      value: { value: "complete" },
    });
    if (result.status !== "executed") throw new Error("expected execution");
    expect(result.value.outputs).toHaveLength(3);
    for (const output of result.value.outputs) {
      const root = output.namespaceId === "room-b"
        ? roots[0]!
        : output.namespaceId === "room-c" ? roots[1]! : roots[2]!;
      expect(new TextDecoder().decode(crypto.aeadOpen(
        root,
        output.ciphertext,
        protectedSyntheticBackgroundObjectAadV2(output),
      )!)).toBe("alpha+charlie+delta");
    }
    expect(borrowedPlaintexts.every((bytes) => bytes.every((byte) => byte === 0)))
      .toBeTrue();
    expect(outputPlaintext).not.toBeNull();
    expect(outputPlaintext!.every((byte) => byte === 0)).toBeTrue();
    expect(phases).toEqual(["preflight", "before-claim", "before-execute"]);
    expect(inspectProtectedInvocationCapability(capability)).toBeNull();
    expect(await storage.getGrant(grant.id)).toMatchObject({ consumed: true });

    let widenedTransformRan = false;
    expect(await executeProtectedSyntheticBackgroundWorkV2({
      capability,
      crypto,
      storage,
      authority,
      descriptorBytes,
      expectedDescriptorHash: crypto.hash(descriptorBytes),
      encryptedInputs: [
        ...encryptedInputs,
        {
          objectId: "unrequested-object",
          namespaceId: "room-a",
          ciphertext: encryptedInputs[0]!.ciphertext,
        },
      ],
      transform: () => {
        widenedTransformRan = true;
        return { value: "forbidden", outputs: [] };
      },
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(widenedTransformRan).toBeFalse();
  });
});
