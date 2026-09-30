import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectThroughNamespace,
  domainEpoch,
  humanId,
  namespaceBindingHash,
  namespaceId,
  openNamespaceKeyring,
  prepareAgentRuntimeInitialization,
  prepareTaskRuntimeResultObject,
  sealNamespaceKeyring,
  verifyNamespaceBindingProof,
  withTaskRuntimeCheckpointNamespace,
  type Rng,
} from "../../src/index.ts";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "../../src/wire.ts";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../src/background/task-runtime-execution-evidence-v1.ts";

const NOW = 1_820_000_000_000;
const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const HUMAN_ID = "30000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "40000000-0000-4000-8000-000000000001";
const DOMAIN_ID = "50000000-0000-4000-8000-000000000001";
const AGENT_ID = "60000000-0000-4000-8000-000000000001";

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function rng(): Rng {
  let state = 1;
  return {
    bytes(length) {
      const result = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        result[index] = state & 0xff;
      }
      return result;
    },
  };
}

async function scenario() {
  const crypto = new LatticeCrypto(rng(), { now: () => NOW });
  const committer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const root = bytes(0x41);
  const ns = namespaceId(NAMESPACE_ID);
  const domain = cryptoDomainId(DOMAIN_ID);
  const epoch = domainEpoch(4);
  const revision = accessRevision(0);
  const device = cryptoDeviceId("task-crypto-committer");
  const rings = createInitialNamespaceKeyrings(crypto, ns);
  const metadata = {
    domainId: domain,
    domainEpoch: epoch,
    accessRevision: revision,
    previousBindingHash: null,
    committerDeviceId: device,
  };
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: bytes(0x31),
    keyring: { ...rings.human, accessRevision: revision },
    metadata,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: root,
    keyring: { ...rings.ai, accessRevision: revision },
    metadata,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const trustedHead = verifyNamespaceBindingProof({
    crypto,
    anchor: {
      namespaceId: ns,
      accessRevision: revision,
      bindingHash: namespaceBindingHash(binding),
    },
    proof: [binding],
    resolveHistoricalCommitter: () => committer.publicKey,
  });
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "task-crypto-agent-initialization",
    agentId: agentId(AGENT_ID),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{
      objectId: "task-crypto-agent-config",
      configRevision: authorizationRevision(1),
      plaintextDek: bytes(0x21),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId(HUMAN_ID),
      managerAuthorizationRevision: authorizationRevision(2),
      managerDeviceId: cryptoDeviceId("task-crypto-manager"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const evidence = {
    requestId: "task-crypto-request",
    workId: RUN_ID,
    claimId: "task-crypto-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 1,
    recipientKeyId: "task-crypto-recipient.1",
    authorizationDigest: bytes(0x51),
    policyRevision: 3,
    episodeId: "task-crypto-episode",
    sourceRoomId: "task-crypto-room",
    hostAuthorizationRevision: 5,
    recipientAuthorizationRevision: 6,
    result: {
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      contentRevision: 1,
      objectId: "task-crypto-result-object",
      signerAgentId: AGENT_ID,
      namespace: {
        namespaceId: NAMESPACE_ID,
        domainId: DOMAIN_ID,
        operations: ["encrypt"],
        expectedAccessRevision: 0,
        expectedPolicyRevision: 3,
      },
    },
    domainRequirements: [{
      domainId: DOMAIN_ID,
      sourceNamespaceId: NAMESPACE_ID,
      participantDigest: bytes(0x61),
      participantCount: 1,
      keyClass: "ai",
      domainKeyGeneration: 4,
      authorizationRevision: authorizationRevision(9),
      headDigest: bytes(0x62),
      activeNamespaceBindingSetDigest: bytes(0x63),
      activeNamespaceBindingCount: 1,
    }],
    namespaceRequirements: [{
      ordinal: 0,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      operations: ["decrypt", "encrypt"],
      expectedAccessRevision: 0,
      expectedPolicyRevision: 3,
    }],
  } as const satisfies TaskRuntimeExecutionEvidenceInputV1;
  return {
    crypto,
    committer,
    manager,
    root,
    aiEnvelope,
    trustedHead,
    initialized,
    evidence,
    namespace: {
      trustedHead,
      aiKeyringEnvelope: aiEnvelope,
      currentDomainRoot: root,
      resolveHistoricalCommitter: () => committer.publicKey,
    },
  };
}

describe("Task Runtime object authority", () => {
  test("seals an Agent-signed result under the current Task Namespace key", async () => {
    const input = await scenario();
    const plaintext = new TextEncoder().encode("Task result stays protected");
    const prepared = await withTaskRuntimeExecutionEvidenceV1({
      evidence: input.evidence,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => prepareTaskRuntimeResultObject(input.crypto, {
        evidence,
        plaintext,
        objectType: "nautilo-task-run-result-v1",
        createdAt: NOW,
        namespace: input.namespace,
        agentAuthorizationRevision: 7,
        runtime: input.initialized.runtime,
        signerPublication: input.initialized.signerPublication,
        resolveHistoricalSignerPublicationManager: () => input.manager.publicKey,
      }),
    });
    expect(prepared.access.manifest.signer).toMatchObject({
      kind: "agent_runtime",
      agentId: AGENT_ID,
    });
    const ring = openNamespaceKeyring({
      crypto: input.crypto,
      domainRoot: input.root,
      envelope: input.aiEnvelope,
      resolveHistoricalCommitter: () => input.committer.publicKey,
    });
    try {
      const current = ring.generations.find((entry) =>
        entry.generation === ring.currentGeneration);
      expect(current).toBeDefined();
      const opened = decryptObjectThroughNamespace(
        input.crypto,
        current!.key,
        decodeNamespaceObjectEnvelopeV2(prepared.access.envelopeBytes[0]),
        decodeEncryptedPayloadV2(prepared.object.payloadBytes.ciphertext),
      );
      expect(opened).toEqual(plaintext);
      opened?.fill(0);
    } finally {
      for (const entry of ring.generations) entry.key.fill(0);
      plaintext.fill(0);
    }
  });

  test("checkpoint keys are erased and current Task authority is rechecked at commit", async () => {
    const input = await scenario();
    const signal = new AbortController().signal;
    let checks = 0;
    let borrowedKey: Uint8Array | null = null;
    const value = await withTaskRuntimeExecutionEvidenceV1({
      evidence: input.evidence,
      signal,
      now: () => NOW,
      execute: (evidence) => withTaskRuntimeCheckpointNamespace({
        crypto: input.crypto,
        evidence,
        identity: {
          taskId: TASK_ID,
          taskRunId: RUN_ID,
          sourceRoomId: input.evidence.sourceRoomId,
          namespaceId: NAMESPACE_ID,
          domainId: DOMAIN_ID,
          expectedAccessRevision: 0,
          expectedPolicyRevision: 3,
        },
        namespace: input.namespace,
        signal,
        assertCurrentTaskAuthority: async () => { checks += 1; },
        execute: async (material, assertCommitAllowed) => {
          borrowedKey = material.generations[0]!.key;
          expect(borrowedKey.some((byte) => byte !== 0)).toBe(true);
          await assertCommitAllowed();
          return "committed";
        },
      }),
    });
    expect(value).toBe("committed");
    expect(checks).toBe(2);
    expect(borrowedKey).not.toBeNull();
    expect(borrowedKey!.every((byte) => byte === 0)).toBe(true);
  });

  test("a substituted source Room cannot open checkpoint keys", async () => {
    const input = await scenario();
    const signal = new AbortController().signal;
    let opened = false;
    expect(withTaskRuntimeExecutionEvidenceV1({
      evidence: input.evidence,
      signal,
      now: () => NOW,
      execute: (evidence) => withTaskRuntimeCheckpointNamespace({
        crypto: input.crypto,
        evidence,
        identity: {
          taskId: TASK_ID,
          taskRunId: RUN_ID,
          sourceRoomId: "wrong-room",
          namespaceId: NAMESPACE_ID,
          domainId: DOMAIN_ID,
          expectedAccessRevision: 0,
          expectedPolicyRevision: 3,
        },
        namespace: input.namespace,
        signal,
        assertCurrentTaskAuthority: async () => undefined,
        execute: () => { opened = true; return "unreachable"; },
      }),
    })).rejects.toThrow("authority was substituted");
    expect(opened).toBe(false);
  });
});
