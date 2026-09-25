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
  sealNamespaceKeyring,
  verifyNamespaceBindingProof,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import type { TaskContentAuthorityV1 } from
  "../../src/task/task-content-authority-v1.ts";
import {
  readPreparedTaskContentCryptoRevisionSnapshotV1,
} from "../../src/task/task-content-prepared-revision.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
} from "../../src/task/task-content-repository.ts";
import {
  decodeTaskRunResultPayloadV1,
} from "../../src/task/task-payload-v1.ts";
import {
  prepareTaskRuntimeRunResult,
} from "../../src/task/task-run-result-preparation.ts";

const NOW = 1_820_000_000_000;
const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const REQUESTER_ID = "30000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "40000000-0000-4000-8000-000000000001";
const DOMAIN_ID = "50000000-0000-4000-8000-000000000001";
const AGENT_ID = "60000000-0000-4000-8000-000000000001";
const ACCESS_REVISION = 0;
const POLICY_REVISION = 3;
const AGENT_AUTHORIZATION_REVISION = 7;

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    bytes(length: number): Uint8Array {
      const result = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        result[index] = state & 0xff;
      }
      return result;
    },
  };
}

async function setup(seed = 1, configuredNamespaceId = NAMESPACE_ID) {
  const crypto = new LatticeCrypto(seededRng(seed), { now: () => NOW });
  const namespaceCommitter = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const targetNamespaceId = namespaceId(configuredNamespaceId);
  const targetDomainId = cryptoDomainId(DOMAIN_ID);
  const targetDomainEpoch = domainEpoch(4);
  const targetAccessRevision = accessRevision(ACCESS_REVISION);
  const committerDeviceId = cryptoDeviceId("task-result-committer");
  const aiDomainRoot = bytes(0x41);
  const humanDomainRoot = bytes(0x31);
  const keyrings = createInitialNamespaceKeyrings(crypto, targetNamespaceId);
  const metadata = {
    domainId: targetDomainId,
    domainEpoch: targetDomainEpoch,
    accessRevision: targetAccessRevision,
    previousBindingHash: null,
    committerDeviceId,
  };
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: humanDomainRoot,
    keyring: {
      ...keyrings.human,
      accessRevision: targetAccessRevision,
    },
    metadata,
    committerSigningPrivateKey: namespaceCommitter.privateKey,
    resolveCurrentCommitter: () => namespaceCommitter.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: aiDomainRoot,
    keyring: {
      ...keyrings.ai,
      accessRevision: targetAccessRevision,
    },
    metadata,
    committerSigningPrivateKey: namespaceCommitter.privateKey,
    resolveCurrentCommitter: () => namespaceCommitter.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: namespaceCommitter.privateKey,
    resolveCurrentCommitter: () => namespaceCommitter.publicKey,
  });
  const trustedHead = verifyNamespaceBindingProof({
    crypto,
    anchor: {
      namespaceId: targetNamespaceId,
      accessRevision: targetAccessRevision,
      bindingHash: namespaceBindingHash(binding),
    },
    proof: [binding],
    resolveHistoricalCommitter: () => namespaceCommitter.publicKey,
  });
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "task-result-agent-initialization",
    agentId: agentId(AGENT_ID),
    authorizationRevision: authorizationRevision(
      AGENT_AUTHORIZATION_REVISION,
    ),
    configObjects: [{
      objectId: "task-result-agent-config",
      configRevision: authorizationRevision(1),
      plaintextDek: bytes(0x21),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId(REQUESTER_ID),
      managerAuthorizationRevision: authorizationRevision(2),
      managerDeviceId: cryptoDeviceId("task-result-manager"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const coordinate = Object.freeze({
    kind: "run_result" as const,
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    contentRevision: 1 as const,
  });
  const authority = Object.freeze({
    authorityVersion: 1 as const,
    kind: "requester_private_namespace" as const,
    keyClass: "ai" as const,
    requesterHumanId: REQUESTER_ID,
    namespaceId: configuredNamespaceId,
    domainId: DOMAIN_ID,
    expectedAccessRevision: ACCESS_REVISION,
    expectedPolicyRevision: POLICY_REVISION,
  } satisfies TaskContentAuthorityV1);
  const evidence = Object.freeze({
    requestId: "task-result-request",
    workId: RUN_ID,
    claimId: "task-result-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 1,
    recipientKeyId: "task-runtime-recipient.1",
    authorizationDigest: bytes(0x51),
    policyRevision: POLICY_REVISION,
    episodeId: "task-result-episode",
    sourceRoomId: "task-result-room",
    hostAuthorizationRevision: 5,
    recipientAuthorizationRevision: 6,
    result: Object.freeze({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      contentRevision: 1 as const,
      objectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      signerAgentId: AGENT_ID,
      namespace: Object.freeze({
        namespaceId: configuredNamespaceId,
        domainId: DOMAIN_ID,
        operations: Object.freeze(["encrypt"] as const),
        expectedAccessRevision: ACCESS_REVISION,
        expectedPolicyRevision: POLICY_REVISION,
      }),
    }),
    domainRequirements: Object.freeze([Object.freeze({
      domainId: DOMAIN_ID,
      sourceNamespaceId: configuredNamespaceId,
      participantDigest: bytes(0x61),
      participantCount: 1,
      keyClass: "ai" as const,
      domainKeyGeneration: 4,
      authorizationRevision: authorizationRevision(9),
      headDigest: bytes(0x62),
      activeNamespaceBindingSetDigest: bytes(0x63),
      activeNamespaceBindingCount: 1,
    })]),
    namespaceRequirements: Object.freeze([Object.freeze({
      ordinal: 0,
      namespaceId: configuredNamespaceId,
      domainId: DOMAIN_ID,
      operations: Object.freeze(["decrypt", "encrypt"] as const),
      expectedAccessRevision: ACCESS_REVISION,
      expectedPolicyRevision: POLICY_REVISION,
    })]),
  } satisfies TaskRuntimeExecutionEvidenceInputV1);
  return {
    crypto,
    aiDomainRoot,
    aiEnvelope,
    trustedHead,
    namespaceCommitter,
    manager,
    initialized,
    coordinate,
    authority,
    evidence,
  };
}

function prepareInput(
  scenario: Awaited<ReturnType<typeof setup>>,
  evidence: Parameters<
    Parameters<typeof withTaskRuntimeExecutionEvidenceV1>[0]["execute"]
  >[0],
) {
  return {
    crypto: scenario.crypto,
    evidence,
    payload: Object.freeze({
      formatVersion: 1 as const,
      resultText: "Protected Task result",
      lastError: null,
    }),
    authority: scenario.authority,
    createdAt: NOW,
    namespace: {
      trustedHead: scenario.trustedHead,
      aiKeyringEnvelope: scenario.aiEnvelope,
      currentDomainRoot: scenario.aiDomainRoot,
      resolveHistoricalCommitter: () =>
        scenario.namespaceCommitter.publicKey,
    },
    agentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
    runtime: scenario.initialized.runtime,
    signerPublication: scenario.initialized.signerPublication,
    resolveHistoricalSignerPublicationManager: () =>
      scenario.manager.publicKey,
  };
}

describe("Task Runtime result preparation", () => {
  test("encrypts once under the current AI Namespace key and seals a V5 Agent result", async () => {
    const scenario = await setup();
    const controller = new AbortController();
    const revision = await withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: controller.signal,
      now: () => NOW,
      execute: (evidence) =>
        prepareTaskRuntimeRunResult(prepareInput(scenario, evidence)),
    });
    const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(
      revision,
    );
    expect(snapshot.coordinate).toEqual(scenario.coordinate);
    expect(snapshot.signerKind).toBe("agent_runtime");
    expect(snapshot.access.manifest.signer).toMatchObject({
      kind: "agent_runtime",
      agentId: AGENT_ID,
      runtimeGeneration: scenario.initialized.runtime.generation,
      signerKeyId: scenario.initialized.signerPublication.signerKeyId,
    });
    const keyring = openNamespaceKeyring({
      crypto: scenario.crypto,
      domainRoot: scenario.aiDomainRoot,
      envelope: scenario.aiEnvelope,
      resolveHistoricalCommitter: () =>
        scenario.namespaceCommitter.publicKey,
    });
    const current = keyring.generations.find((entry) =>
      entry.generation === keyring.currentGeneration
    );
    if (current === undefined) throw new Error("current AI key is missing");
    const plaintext = decryptObjectThroughNamespace(
      scenario.crypto,
      current.key,
      decodeNamespaceObjectEnvelopeV2(snapshot.access.envelopeBytes[0]),
      decodeEncryptedPayloadV2(snapshot.object.payloadBytes.ciphertext),
    );
    if (plaintext === null) throw new Error("prepared result did not decrypt");
    expect(decodeTaskRunResultPayloadV1(plaintext)).toEqual({
      formatVersion: 1,
      resultText: "Protected Task result",
      lastError: null,
    });
    plaintext.fill(0);
    for (const generation of keyring.generations) generation.key.fill(0);
  });

  test("rejects result, Namespace, and signer substitution before publication", async () => {
    const scenario = await setup(2);
    const wrongNamespace = await setup(
      3,
      "40000000-0000-4000-8000-000000000099",
    );
    expect(withTaskRuntimeExecutionEvidenceV1({
      evidence: {
        ...scenario.evidence,
        result: {
          ...scenario.evidence.result,
          objectId: "substituted-result-object",
        },
      },
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) =>
        prepareTaskRuntimeRunResult(prepareInput(scenario, evidence)),
    })).rejects.toThrow("coordinate or authority disagrees");

    expect(withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => prepareTaskRuntimeRunResult({
        ...prepareInput(scenario, evidence),
        namespace: {
          trustedHead: wrongNamespace.trustedHead,
          aiKeyringEnvelope: wrongNamespace.aiEnvelope,
          currentDomainRoot: wrongNamespace.aiDomainRoot,
          resolveHistoricalCommitter: () =>
            wrongNamespace.namespaceCommitter.publicKey,
        },
      }),
    })).rejects.toThrow("authority was substituted");

    expect(withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => prepareTaskRuntimeRunResult({
        ...prepareInput(scenario, evidence),
        signerPublication: {
          ...scenario.initialized.signerPublication,
          signature: new Uint8Array(
            scenario.initialized.signerPublication.signature.length,
          ).fill(0x7f),
        },
      }),
    })).rejects.toThrow("authority was substituted");
  });

  test("fails closed when Task execution evidence expires or is revoked", async () => {
    const scenario = await setup(4);
    let now = NOW;
    expect(withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: new AbortController().signal,
      now: () => now,
      execute: (evidence) => {
        now = scenario.evidence.expiresAt;
        return prepareTaskRuntimeRunResult(prepareInput(scenario, evidence));
      },
    })).rejects.toThrow("evidence is not active");

    const controller = new AbortController();
    expect(withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: controller.signal,
      now: () => NOW,
      execute: (evidence) => {
        controller.abort();
        return prepareTaskRuntimeRunResult(prepareInput(scenario, evidence));
      },
    })).rejects.toThrow("evidence is not active");
  });
});
