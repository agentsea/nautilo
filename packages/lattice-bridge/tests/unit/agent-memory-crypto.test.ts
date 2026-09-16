import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  coordinateGrantAuthoritySetUse,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectThroughNamespace,
  domainEpoch,
  grantId,
  grantWriteRecord,
  humanId,
  InMemoryLatticeStore,
  mintGrant,
  namespaceId,
  preflightGrantAuthoritySetUse,
  prepareAgentRuntimeInitialization,
  type GrantAuthoritySetAuthorization,
  type GrantAuthoritySetExecutionEvidence,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  serializeGrantV2,
} from "@nautilo/lattice-crypto/wire";

import {
  prepareAgentMemoryCryptoRevision,
} from "../../src/memory/agent-memory-crypto.ts";
import {
  decodeMemoryPayloadV1,
} from "../../src/memory/memory-payload-v1.ts";
import {
  MEMORY_OBJECT_TYPE,
  type PreparedMemoryCryptoRevision,
} from "../../src/memory/memory-repository.ts";
import {
  readPreparedMemoryCryptoRevisionSnapshot,
} from "../../src/memory/memory-prepared-revision.ts";

const NOW = 1_810_000_000_000;
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NAMESPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    bytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        bytes[index] = state & 0xff;
      }
      return bytes;
    },
  };
}

async function prepareMemory(
  mutate?: (input: {
    namespaceSet: {
      recipientAgentId: string;
      runtimeAuthorizationRevision: number;
      namespaces: Array<{
        namespaceId: string;
        domainId: string;
        domainEpoch: number;
        accessRevision: number;
        policyRevision: number;
        domainAgentAuthorizationRevision: number;
        bindingHash: Uint8Array;
        currentGeneration: number;
        generations: Array<{ generation: number; key: Uint8Array }>;
      }>;
    };
    evidence: GrantAuthoritySetExecutionEvidence;
  }) => void,
) {
  const crypto = new LatticeCrypto(seededRng(0x243_12), { now: () => NOW });
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const runtimeAuthorizationRevision = authorizationRevision(17);
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "memory-agent-runtime-initialization",
    agentId: agentId("memory-agent"),
    authorizationRevision: runtimeAuthorizationRevision,
    configObjects: [{
      objectId: "memory-agent-config",
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x31),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId("alice"),
      managerAuthorizationRevision: authorizationRevision(8),
      managerDeviceId: cryptoDeviceId("alice-device"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const domains = [
    {
      domainId: cryptoDomainId("domain-a"),
      domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(11),
      aiRoot: new Uint8Array(32).fill(0x41),
    },
    {
      domainId: cryptoDomainId("domain-b"),
      domainEpoch: domainEpoch(6),
      agentAuthorizationRevision: authorizationRevision(13),
      aiRoot: new Uint8Array(32).fill(0x42),
    },
  ] as const;
  const grant = await mintGrant(crypto, {
    id: grantId("memory-reusable-grant"),
    issuingDeviceId: cryptoDeviceId("alice-device"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: initialized.runtime.agentId,
    recipientKeyId: "memory-recipient",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId("alice")],
    operations: ["encrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: domains,
    singleUse: false,
  });
  const namespaceRequirements = [
    {
      namespaceId: namespaceId(NAMESPACE_A),
      domainId: domains[0].domainId,
      operations: ["encrypt"] as const,
      namespaceParticipants: [humanId("alice")],
      expectedAccessRevision: accessRevision(2),
      expectedPolicyRevision: authorizationRevision(21),
    },
    {
      namespaceId: namespaceId(NAMESPACE_B),
      domainId: domains[1].domainId,
      operations: ["encrypt"] as const,
      namespaceParticipants: [humanId("alice")],
      expectedAccessRevision: accessRevision(5),
      expectedPolicyRevision: authorizationRevision(22),
    },
  ];
  const authorization: GrantAuthoritySetAuthorization = {
    now: NOW + 1,
    expectedIssuingDeviceId: grant.issuingDeviceId,
    issuingDeviceHumanId: humanId("alice"),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: initialized.runtime.agentId,
    recipientKeyId: grant.recipientKeyId,
    recipientEncryptionPrivateKey: recipient.privateKey,
    singleUseAvailable: true,
    grantScope: grant.scope,
    namespaceRequirements,
    domainRequirements: domains.map((entry) => ({
      domainId: entry.domainId,
      expectedEpoch: entry.domainEpoch,
      expectedAgentAuthorizationRevision: entry.agentAuthorizationRevision,
    })),
    hostAllowsOperation: true,
  };
  const store = new InMemoryLatticeStore();
  await store.putGrant(grantWriteRecord(serializeGrantV2(grant)));
  const preflight = await preflightGrantAuthoritySetUse(
    crypto,
    grant,
    authorization,
  );
  if (preflight === null) throw new Error("expected authority-set preflight");
  const keys = [
    new Uint8Array(32).fill(0x71),
    new Uint8Array(32).fill(0x72),
  ];
  const result = await coordinateGrantAuthoritySetUse({
    preflight,
    storage: store,
    resolveCurrentAuthorization: (context) => ({
      context,
      currentTime: context.preflightTime,
      issuingDeviceActive: true,
      recipientAgentAuthorized: true,
      requestedNamespacesAuthorized: true,
      requestedDomainsAuthorized: true,
      hostAllowsOperation: true,
      currentSingleUseStatus: context.singleUseStatus,
    }),
    execute: (_opened, evidence) => {
      const namespaceSet = {
        recipientAgentId: initialized.runtime.agentId,
        runtimeAuthorizationRevision,
        namespaces: namespaceRequirements.map((requirement, index) => ({
          namespaceId: requirement.namespaceId,
          domainId: requirement.domainId,
          domainEpoch: domains[index]!.domainEpoch,
          accessRevision: requirement.expectedAccessRevision,
          policyRevision: requirement.expectedPolicyRevision,
          domainAgentAuthorizationRevision:
            domains[index]!.agentAuthorizationRevision,
          bindingHash: new Uint8Array(32).fill(0x81 + index),
          currentGeneration: index + 2,
          generations: [{ generation: index + 2, key: keys[index]! }],
        })),
      };
      mutate?.({ namespaceSet, evidence });
      return prepareAgentMemoryCryptoRevision({
        crypto,
        memoryId: MEMORY_ID,
        contentRevision: 3,
        payload: {
          formatVersion: 1,
          content: "private memory content",
          type: "preference",
        },
        createdAt: NOW,
        namespaceSet,
        authoritySet: evidence,
        runtime: initialized.runtime,
        signerPublication: initialized.signerPublication,
      });
    },
  });
  if (result.status !== "executed") throw new Error("expected preparation");
  return { crypto, keys, prepared: result.value };
}

describe("Agent Memory crypto preparation", () => {
  test("encrypts once and wraps the same DEK for every exact Namespace", async () => {
    const { crypto, keys, prepared } = await prepareMemory();
    const snapshot = readPreparedMemoryCryptoRevisionSnapshot(prepared);
    expect(snapshot.requiredNamespaceIds).toEqual([NAMESPACE_A, NAMESPACE_B]);
    expect(snapshot.access.envelopeBytes).toHaveLength(2);
    const payload = decodeEncryptedPayloadV2(
      snapshot.object.payloadBytes.ciphertext,
    );
    expect(payload.context.objectType).toBe(MEMORY_OBJECT_TYPE);
    for (const envelopeBytes of snapshot.access.envelopeBytes) {
      const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
      const key = envelope.context.namespaceId === NAMESPACE_A
        ? keys[0]!
        : keys[1]!;
      const plaintext = decryptObjectThroughNamespace(
        crypto,
        key,
        envelope,
        payload,
      );
      expect(plaintext).not.toBeNull();
      expect(decodeMemoryPayloadV1(plaintext!)).toEqual({
        formatVersion: 1,
        content: "private memory content",
        type: "preference",
      });
      plaintext!.fill(0);
    }
    expect("preauthorizedTombstone" in snapshot.access).toBe(false);
    expect(snapshot.access.authority.namespaceBindings.map((entry) => ({
      namespaceId: entry.namespaceId,
      access: entry.expectedAccessRevision,
      policy: entry.expectedPolicyRevision,
      domainId: entry.domainId,
    }))).toEqual([
      { namespaceId: NAMESPACE_A, access: 2, policy: 21, domainId: "domain-a" },
      { namespaceId: NAMESPACE_B, access: 5, policy: 22, domainId: "domain-b" },
    ]);
  });

  test("rejects partial, extra, and stale authority coordinates", () => {
    expect(prepareMemory(({ namespaceSet }) => namespaceSet.namespaces.pop()))
      .rejects.toThrow("exact authority set disagrees");
    expect(prepareMemory(({ namespaceSet }) => {
      namespaceSet.namespaces[0]!.policyRevision += 1;
    })).rejects.toThrow("exact authority set disagrees");
    expect(prepareMemory(({ namespaceSet }) => {
      namespaceSet.namespaces.push({ ...namespaceSet.namespaces[0]! });
    })).rejects.toThrow("exact authority set disagrees");
  });

  test("keeps encrypted state behind an authentic opaque prepared handle", async () => {
    const { prepared } = await prepareMemory();
    const forgery = Object.freeze({ ...prepared }) as PreparedMemoryCryptoRevision;
    expect(() => readPreparedMemoryCryptoRevisionSnapshot(forgery))
      .toThrow("not prepared by the bridge crypto role");
    expect("preauthorizedTombstone" in
      readPreparedMemoryCryptoRevisionSnapshot(prepared).access).toBe(false);
  });
});
