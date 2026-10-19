import { withWakeEvidence } from "../fixtures/task-wake-foreground-evidence.ts";
import {
  PUBLICATION_NAMESPACE,
  withPublicationSigner,
} from "../../../lattice-crypto/tests/fixtures/task-publication-signer.ts";
import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  mintDomainForegroundAuthorization,
  persistAgentRuntimeInitialization,
  prepareAgentRuntimeInitialization,
  TaskRuntimeRecipientRegistry,
  type DomainForegroundSecretEntry,
  type Rng,
  type TaskRuntimeCancellationResultEvidence,
  type TaskRuntimeRunResultReadEvidence,
  type TaskRuntimeTerminalMessageEvidence,
} from "@nautilo/lattice-crypto";
import { serializeDomainForegroundAuthorizationV2 } from
  "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import { withTaskRuntimeTerminalMessageEvidenceV1 } from
  "../../../lattice-crypto/src/background/task-runtime-terminal-message-evidence-v1.ts";
import {
  withTaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-run-result-read-evidence-v1.ts";

import { createFakeLatticeStorage } from
  "../../src/testing/fake-lattice-storage.ts";
import {
  withProtectedTaskCancellationResultSigner,
  withProtectedTaskResultSigner,
  withProtectedTaskRunResultMessageSigner,
  withProtectedTaskTerminalMessageSigner,
  withProtectedTaskWakeForegroundSigner,
} from "../../src/task/protected-task-result-signer.ts";
import { deriveMessageCryptoObjectIdV2 } from
  "../../src/message/conversation-repository.ts";
import { deriveTaskContentCryptoObjectIdV1 } from
  "../../src/task/task-content-repository.ts";

const NOW = 1_830_000_000_000;
const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "30000000-0000-4000-8000-000000000001";
const DOMAIN_ID = "40000000-0000-4000-8000-000000000001";
const AGENT_ID = "50000000-0000-4000-8000-000000000001";
const AGENT_AUTHORIZATION_REVISION = 7;
const DOMAIN_AUTHORIZATION_REVISION = 11;
const DOMAIN_EPOCH = 4;

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

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x334_05), { now: () => NOW });
  const committer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const domainRoot = bytes(0x41);
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "task-result-signer-initialization",
    agentId: agentId(AGENT_ID),
    authorizationRevision: authorizationRevision(
      AGENT_AUTHORIZATION_REVISION,
    ),
    configObjects: [{
      objectId: "task-result-agent-config",
      configRevision: authorizationRevision(1),
      plaintextDek: bytes(0x31),
    }],
    domains: [{
      domainId: cryptoDomainId(DOMAIN_ID),
      domainEpoch: domainEpoch(DOMAIN_EPOCH),
      agentAuthorizationRevision: authorizationRevision(
        AGENT_AUTHORIZATION_REVISION,
      ),
      committerDeviceId: cryptoDeviceId("task-result-committer"),
      domainRoot,
      committerSigningPrivateKey: committer.privateKey,
    }],
    resolveCurrentDomainCommitterAuthority: () => committer.publicKey,
    manager: {
      managerHumanId: humanId("task-result-manager"),
      managerAuthorizationRevision: authorizationRevision(3),
      managerDeviceId: cryptoDeviceId("task-result-manager-device"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const { storage } = createFakeLatticeStorage();
  expect(await persistAgentRuntimeInitialization({
    crypto,
    storage,
    prepared: initialized,
    resolveCurrentAuthorization: () => ({
      currentState: {
        agentId: agentId(AGENT_ID),
        authorizationRevision: authorizationRevision(
          AGENT_AUTHORIZATION_REVISION,
        ),
        runtimeGeneration: agentRuntimeGeneration(0),
      },
      currentManager: {
        managerHumanId: humanId("task-result-manager"),
        managerAuthorizationRevision: authorizationRevision(3),
        managerDeviceId: cryptoDeviceId("task-result-manager-device"),
      },
      currentManagerSigningPublicKey: manager.publicKey,
      domains: [{
        domainId: cryptoDomainId(DOMAIN_ID),
        domainEpoch: domainEpoch(DOMAIN_EPOCH),
        agentAuthorizationRevision: authorizationRevision(
          AGENT_AUTHORIZATION_REVISION,
        ),
        committerDeviceId: cryptoDeviceId("task-result-committer"),
        committerSigningPublicKey: committer.publicKey,
      }],
    }),
  })).toBe("inserted");
  initialized.runtime.key.fill(0);

  const domain = Object.freeze({
    domainId: DOMAIN_ID,
    sourceNamespaceId: NAMESPACE_ID,
    participantDigest: bytes(0x51),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: DOMAIN_EPOCH,
    authorizationRevision: authorizationRevision(
      DOMAIN_AUTHORIZATION_REVISION,
    ),
    headDigest: bytes(0x52),
    domainKey: domainRoot.slice(),
  } satisfies DomainForegroundSecretEntry);
  return { crypto, committer, manager, storage, domain };
}

function evidenceFor(
  domain: DomainForegroundSecretEntry,
  input: Readonly<{
    domainId?: string;
    domainEpoch?: number;
    signerAgentId?: string;
  }> = {},
): TaskRuntimeExecutionEvidenceInputV1 {
  const domainId = input.domainId ?? domain.domainId;
  const domainKeyGeneration = input.domainEpoch ?? domain.domainKeyGeneration;
  return Object.freeze({
    requestId: "task-result-signer-request",
    workId: RUN_ID,
    claimId: "task-result-signer-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 1,
    recipientKeyId: "task-result-signer-recipient",
    authorizationDigest: bytes(0x61),
    policyRevision: 5,
    episodeId: "task-result-signer-episode",
    sourceRoomId: "task-result-signer-room",
    hostAuthorizationRevision: 2,
    recipientAuthorizationRevision: 0,
    result: Object.freeze({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      contentRevision: 1 as const,
      objectId: "task-result-signer-object",
      signerAgentId: input.signerAgentId ?? AGENT_ID,
      namespace: Object.freeze({
        namespaceId: NAMESPACE_ID,
        domainId,
        operations: Object.freeze(["encrypt"] as const),
        expectedAccessRevision: 0,
        expectedPolicyRevision: 5,
      }),
    }),
    domainRequirements: Object.freeze([Object.freeze({
      domainId,
      sourceNamespaceId: domain.sourceNamespaceId,
      participantDigest: domain.participantDigest,
      participantCount: domain.participantCount,
      keyClass: "ai" as const,
      domainKeyGeneration,
      authorizationRevision: domain.authorizationRevision,
      headDigest: domain.headDigest,
      activeNamespaceBindingSetDigest: bytes(0x62),
      activeNamespaceBindingCount: 1,
    })]),
    namespaceRequirements: Object.freeze([Object.freeze({
      ordinal: 0,
      namespaceId: NAMESPACE_ID,
      domainId,
      operations: Object.freeze(["decrypt", "encrypt"] as const),
      expectedAccessRevision: 0,
      expectedPolicyRevision: 5,
    })]),
  });
}

async function withCancellationEvidence<Value>(
  state: Awaited<ReturnType<typeof fixture>>,
  operation: (input: Readonly<{
    evidence: TaskRuntimeCancellationResultEvidence;
    domain: DomainForegroundSecretEntry;
    expire(): void;
  }>) => Value | PromiseLike<Value>,
) {
  let currentTime = NOW;
  const recipients = new TaskRuntimeRecipientRegistry(state.crypto, {
    now: () => currentTime,
  });
  const requestId = "task-cancellation-result-signer-request";
  const recipientKeyId = "task-cancellation-result-signer-recipient";
  const attempt = await recipients.createAttempt({
    requestId,
    workId: RUN_ID,
    recipientGeneration: 1,
    recipientKeyId,
    expiresAt: NOW + 60_000,
  });
  if (attempt.status !== "created") {
    throw new Error("cancellation result recipient unavailable");
  }
  const domainRequirement = Object.freeze({
    domainId: state.domain.domainId,
    sourceNamespaceId: state.domain.sourceNamespaceId,
    participantDigest: state.domain.participantDigest,
    participantCount: state.domain.participantCount,
    keyClass: "ai" as const,
    domainKeyGeneration: state.domain.domainKeyGeneration,
    authorizationRevision: state.domain.authorizationRevision,
    headDigest: state.domain.headDigest,
    activeNamespaceBindingSetDigest: bytes(0x53),
    activeNamespaceBindingCount: 1,
  });
  const plan = createDomainForegroundAuthorizationPlan(state.crypto, {
    authorizationId: requestId,
    policyRevision: 5,
    sessionId: "task-cancellation-result-signer-session",
    roomId: "task-cancellation-result-signer-room",
    subjectHumanId: humanId("task-cancellation-result-signer-human"),
    committerDeviceId: cryptoDeviceId("task-result-committer"),
    committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(2),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 1,
    recipientKeyId,
    operations: ["encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
    maximumSecretBytes: 4_096,
    domains: [domainRequirement],
  });
  const authorization = await mintDomainForegroundAuthorization(state.crypto, {
    plan,
    domains: [state.domain],
    committerDeviceSigningPrivateKey: state.committer.privateKey,
    recipientEncryptionPublicKey: attempt.attempt.recipientPublicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const result = Object.freeze({
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    contentRevision: 2 as const,
    objectId: deriveTaskContentCryptoObjectIdV1({
      kind: "run_result",
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      contentRevision: 2,
    }),
    signerAgentId: AGENT_ID,
    namespace: Object.freeze({
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      operations: Object.freeze(["encrypt"] as const),
      expectedAccessRevision: 0,
      expectedPolicyRevision: 5,
    }),
  });
  try {
    return await recipients.withOpenedCancellationResultGrant({
      requestId,
      workId: RUN_ID,
      recipientGeneration: 1,
      recipientKeyId,
      claimId: "task-cancellation-result-signer-claim",
      claimExpiresAt: NOW + 60_000,
      authorizationBytes,
      current: {
        authorizationId: plan.authorizationId,
        policyRevision: plan.policyRevision,
        sessionId: plan.sessionId,
        roomId: plan.roomId,
        subjectHumanId: plan.subjectHumanId,
        committerDeviceId: plan.committerDeviceId,
        committerDeviceSigningGeneration:
          plan.committerDeviceSigningGeneration,
        committerDeviceSigningPublicKey: state.committer.publicKey,
        committerDeviceActive: true,
        hostAuthorizationRevision: plan.hostAuthorizationRevision,
        recipientKind: plan.recipientKind,
        recipientPrincipalId: plan.recipientPrincipalId,
        recipientAuthorizationRevision: plan.recipientAuthorizationRevision,
        recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
        recipientKeyId: plan.recipientKeyId,
        recipientAuthorized: true,
        domains: plan.domains,
      },
      currentNamespaceRequirements: [{
        ordinal: 0,
        namespaceId: NAMESPACE_ID,
        domainId: DOMAIN_ID,
        operations: ["encrypt"],
        expectedAccessRevision: 0,
        expectedPolicyRevision: 5,
      }],
      result,
      operation: (domains, _signal, evidence) => {
        const domain = domains[0];
        if (domain === undefined) throw new Error("missing cancellation Domain");
        return operation({
          evidence,
          domain,
          expire: () => {
            currentTime = NOW + 60_000;
          },
        });
      },
    });
  } finally {
    authorizationBytes.fill(0);
    recipients.close();
  }
}

async function withRunResultReadEvidence<Value>(
  state: Awaited<ReturnType<typeof fixture>>,
  operation: (evidence: TaskRuntimeRunResultReadEvidence) => Value | PromiseLike<Value>,
) {
  const privateDomain = {
    domainId: "task-result-private-domain",
    sourceNamespaceId: "task-result-private-namespace",
    participantDigest: bytes(0x81), participantCount: 1, keyClass: "ai" as const,
    domainKeyGeneration: 2, authorizationRevision: authorizationRevision(3),
    headDigest: bytes(0x82), activeNamespaceBindingSetDigest: bytes(0x83),
    activeNamespaceBindingCount: 1,
  };
  const destinationDomain = {
    domainId: state.domain.domainId,
    sourceNamespaceId: state.domain.sourceNamespaceId,
    participantDigest: state.domain.participantDigest,
    participantCount: state.domain.participantCount,
    keyClass: "ai" as const,
    domainKeyGeneration: state.domain.domainKeyGeneration,
    authorizationRevision: state.domain.authorizationRevision,
    headDigest: state.domain.headDigest,
    activeNamespaceBindingSetDigest: bytes(0x84),
    activeNamespaceBindingCount: 1,
  };
  const objectId = deriveTaskContentCryptoObjectIdV1({
    kind: "run_result", taskId: TASK_ID, taskRunId: RUN_ID, contentRevision: 1,
  });
  const input: TaskRuntimeRunResultReadEvidenceInputV1 = {
    purpose: "task.runtime.run_result_read", workKind: "task.deliver_result",
    requestId: `task-run-delivery-result-authorization:${RUN_ID}`,
    workId: RUN_ID, claimId: "task-result-message-signer-claim",
    claimExpiresAt: NOW + 60_000, recipientExpiresAt: NOW + 60_000,
    authorizationExpiresAt: NOW + 60_000, expiresAt: NOW + 60_000,
    recipientGeneration: 1, recipientKeyId: "task-result-message-signer-recipient",
    authorizationDigest: bytes(0x85), requesterHumanId: "task-result-requester",
    policyRevision: 5, episodeId: "task-result-destination-session",
    sourceRoomId: "task-result-destination-room", hostAuthorizationRevision: 2,
    recipientAuthorizationRevision: 0, operations: ["decrypt"],
    result: {
      taskId: TASK_ID, taskRunId: RUN_ID, terminalStatus: "completed",
      contentRevision: 1, objectId, cryptoAccessRevision: 0,
      genesisManifestHash: bytes(0x86), signerAgentId: AGENT_ID,
      namespace: { namespaceId: privateDomain.sourceNamespaceId,
        domainId: privateDomain.domainId, operations: ["decrypt"],
        expectedAccessRevision: 0, expectedPolicyRevision: 5 },
    },
    invocation: { kind: "raw", bindingId: `task-run-output:${RUN_ID}`,
      operationId: `task-run-delivery-message:${RUN_ID}`,
      roomId: "task-result-destination-room",
      sessionId: "task-result-destination-session" },
    resultDomain: privateDomain,
    messageWrite: {
      taskId: TASK_ID, taskRunId: RUN_ID,
      bindingId: `task-run-output:${RUN_ID}`,
      messageOperationId: `task-run-delivery-message:${RUN_ID}`,
      roomId: "task-result-destination-room",
      sessionId: "task-result-destination-session", signerAgentId: AGENT_ID,
      namespace: { namespaceId: state.domain.sourceNamespaceId,
        domainId: state.domain.domainId, operations: ["encrypt"],
        expectedAccessRevision: 0, expectedPolicyRevision: 5 },
      domain: destinationDomain,
    },
  };
  return withTaskRuntimeRunResultReadEvidenceV1({
    evidence: input, signal: new AbortController().signal, now: () => NOW,
    execute: evidence => operation(evidence),
  });
}

describe("protected Task result signer", () => {
  test("lends the signer only under the raw result proof's independent destination Domain", async () => {
    const state = await fixture();
    let borrowedKey: Uint8Array | undefined;
    const result = await withRunResultReadEvidence(state, evidence =>
      withProtectedTaskRunResultMessageSigner({
        crypto: state.crypto, storage: state.storage, evidence,
        domain: state.domain,
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () => state.manager.publicKey,
        execute: authority => {
          borrowedKey = authority.runtime.key;
          return "message-signer";
        },
      }));
    expect(result).toEqual({ status: "executed", value: "message-signer" });
    expect(borrowedKey).toEqual(new Uint8Array(32));
  });

  test("rejects a substituted result Message write Domain before Runtime custody", async () => {
    const state = await fixture();
    let runtimeRead = false;
    let executed = false;
    const result = await withRunResultReadEvidence(state, evidence =>
      withProtectedTaskRunResultMessageSigner({
        crypto: state.crypto,
        storage: {
          getAgentRuntimeAtomicState: async (...parameters) => {
            runtimeRead = true;
            return state.storage.getAgentRuntimeAtomicState(...parameters);
          },
          getAgentRuntimeSignerPublication:
            state.storage.getAgentRuntimeSignerPublication.bind(state.storage),
        },
        evidence,
        domain: Object.freeze({ ...state.domain,
          authorizationRevision: authorizationRevision(
            state.domain.authorizationRevision + 1,
          ) }),
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () => state.manager.publicKey,
        execute: () => { executed = true; },
      }));
    expect(result).toEqual({ status: "unavailable", reason: "authority_unavailable" });
    expect(runtimeRead).toBe(false);
    expect(executed).toBe(false);
  });

  test("lends and wipes the signer only for authentic terminal Message destination evidence", async () => {
    const state = await fixture();
    const coordinate = { sessionId: NAMESPACE_ID, messageId: 1, revision: 0 };
    const controller = new AbortController();
    const capture: { borrowedKey: Uint8Array | null } = { borrowedKey: null };
    const result = await withTaskRuntimeTerminalMessageEvidenceV1({
      evidence: {
        purpose: "task.runtime.terminal_message",
        workKind: "task.deliver_message",
        requestId: `task-run-delivery-message-authorization:${RUN_ID}`,
        workId: RUN_ID,
        claimId: "task-terminal-message-signer-claim",
        claimExpiresAt: NOW + 60_000,
        recipientExpiresAt: NOW + 60_000,
        expiresAt: NOW + 60_000,
        recipientGeneration: 1,
        recipientKeyId: "task-terminal-message-signer-recipient",
        authorizationDigest: bytes(0x71),
        policyRevision: 5,
        episodeId: "task-terminal-message-signer-episode",
        sourceRoomId: TASK_ID,
        hostAuthorizationRevision: 2,
        recipientAuthorizationRevision: 0,
        operations: ["encrypt"],
        message: {
          taskId: TASK_ID,
          taskRunId: RUN_ID,
          bindingId: `task-run-output:${RUN_ID}`,
          messageOperationId: `task-run-delivery-message:${RUN_ID}`,
          ...coordinate,
          objectId: deriveMessageCryptoObjectIdV2(coordinate),
          roomId: TASK_ID,
          namespaceId: NAMESPACE_ID,
          domainId: DOMAIN_ID,
          mode: "encrypted_only",
          acceptedPolicyRevision: 5,
          publicationPolicyRevision: 5,
          signerAgentId: AGENT_ID,
          payloadDigest: bytes(0x72),
        },
        domainRequirements: [{
          domainId: DOMAIN_ID,
          sourceNamespaceId: NAMESPACE_ID,
          participantDigest: state.domain.participantDigest,
          participantCount: state.domain.participantCount,
          keyClass: "ai",
          domainKeyGeneration: state.domain.domainKeyGeneration,
          authorizationRevision: state.domain.authorizationRevision,
          headDigest: state.domain.headDigest,
          activeNamespaceBindingSetDigest: bytes(0x73),
          activeNamespaceBindingCount: 1,
        }],
        namespaceRequirements: [{
          ordinal: 0,
          namespaceId: NAMESPACE_ID,
          domainId: DOMAIN_ID,
          operations: ["encrypt"],
          expectedAccessRevision: 0,
          expectedPolicyRevision: 5,
        }],
      },
      signal: controller.signal,
      now: () => NOW,
      execute: evidence => withProtectedTaskTerminalMessageSigner({
        crypto: state.crypto,
        storage: state.storage,
        evidence: evidence as TaskRuntimeTerminalMessageEvidence,
        domain: state.domain,
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () => state.manager.publicKey,
        execute: authority => {
          capture.borrowedKey = authority.runtime.key;
          expect(String(authority.runtime.agentId)).toBe(AGENT_ID);
          return "terminal-message-prepared";
        },
      }),
    });
    expect(result).toEqual({
      status: "executed",
      value: "terminal-message-prepared",
    });
    expect(capture.borrowedKey).toEqual(new Uint8Array(32));
  });

  test("lends the current durable signer and wipes its Runtime key", async () => {
    const state = await fixture();
    const controller = new AbortController();
    const capture: { borrowedKey: Uint8Array | null } = {
      borrowedKey: null,
    };
    const result = await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceFor(state.domain),
      signal: controller.signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultSigner({
        crypto: state.crypto,
        storage: state.storage,
        evidence,
        domain: state.domain,
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () =>
          state.manager.publicKey,
        execute: (authority) => {
          capture.borrowedKey = authority.runtime.key;
          expect(String(authority.runtime.agentId)).toBe(AGENT_ID);
          expect(String(authority.signerPublication.agentId)).toBe(AGENT_ID);
          expect(authority.agentAuthorizationRevision)
            .toBe(AGENT_AUTHORIZATION_REVISION);
          expect(authority.runtime.key).not.toEqual(new Uint8Array(32));
          return "prepared";
        },
      }),
    });
    expect(result).toEqual({ status: "executed", value: "prepared" });
    expect(capture.borrowedKey).toEqual(new Uint8Array(32));
  });

  test.each([
    ["Domain", { domainId: "different-domain" }],
    ["Domain epoch", { domainEpoch: DOMAIN_EPOCH + 1 }],
    ["Agent", { signerAgentId: "different-agent" }],
  ] as const)("rejects a wrong %s before lending the signer", async (
    _label,
    mismatch,
  ) => {
    const state = await fixture();
    const domain = Object.freeze({
      ...state.domain,
      domainId: "domainId" in mismatch
        ? mismatch.domainId
        : state.domain.domainId,
      domainKeyGeneration:
        "domainEpoch" in mismatch
          ? mismatch.domainEpoch
          : state.domain.domainKeyGeneration,
    });
    let executed = false;
    const result = await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceFor(domain, mismatch),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultSigner({
        crypto: state.crypto,
        storage: state.storage,
        evidence,
        domain,
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () =>
          state.manager.publicKey,
        execute: () => {
          executed = true;
        },
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "runtime_unavailable",
    });
    expect(executed).toBe(false);
  });

  test("rejects a stale Agent authorization revision", async () => {
    const state = await fixture();
    const result = await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceFor(state.domain),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultSigner({
        crypto: state.crypto,
        storage: state.storage,
        evidence,
        domain: state.domain,
        expectedAgentAuthorizationRevision:
          AGENT_AUTHORIZATION_REVISION + 1,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () =>
          state.manager.publicKey,
        execute: () => "must-not-run",
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "runtime_unavailable",
    });
  });

  test("rejects a substituted signer publication", async () => {
    const state = await fixture();
    const publication = await state.storage.getAgentRuntimeSignerPublication(
      AGENT_ID,
      0,
    );
    if (publication === null) throw new Error("missing signer publication");
    const signerPublicKey = publication.signerPublicKey.slice();
    signerPublicKey[0] = signerPublicKey[0]! ^ 0xff;
    let executed = false;
    const result = await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceFor(state.domain),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultSigner({
        crypto: state.crypto,
        storage: {
          getAgentRuntimeAtomicState:
            state.storage.getAgentRuntimeAtomicState.bind(state.storage),
          getAgentRuntimeSignerPublication: async () => Object.freeze({
            ...publication,
            signerPublicKey,
          }),
        },
        evidence,
        domain: state.domain,
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () =>
          state.manager.publicKey,
        execute: () => {
          executed = true;
        },
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "signer_unavailable",
    });
    expect(executed).toBe(false);
  });

  test("wipes the Runtime key when the bounded callback throws", async () => {
    const state = await fixture();
    const capture: { borrowedKey: Uint8Array | null } = {
      borrowedKey: null,
    };
    const failure = await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceFor(state.domain),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultSigner({
        crypto: state.crypto,
        storage: state.storage,
        evidence,
        domain: state.domain,
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () =>
          state.manager.publicKey,
        execute: (authority) => {
          capture.borrowedKey = authority.runtime.key;
          throw new Error("synthetic preparation failure");
        },
      }),
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("synthetic preparation failure");
    expect(capture.borrowedKey).toEqual(new Uint8Array(32));
  });

  test("lends the signer under a real encrypt-only cancellation grant", async () => {
    const state = await fixture();
    const capture: { borrowedKey: Uint8Array | null } = { borrowedKey: null };
    const opened = await withCancellationEvidence(state, ({
      evidence,
      domain,
    }) => withProtectedTaskCancellationResultSigner({
      crypto: state.crypto,
      storage: state.storage,
      evidence,
      domain,
      expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
      resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
      resolveHistoricalSignerPublicationManager: () => state.manager.publicKey,
      execute: (authority) => {
        capture.borrowedKey = authority.runtime.key;
        expect(String(authority.runtime.agentId)).toBe(AGENT_ID);
        expect(authority.runtime.key).not.toEqual(new Uint8Array(32));
        return "cancelled-result-prepared";
      },
    }));
    expect(opened).toEqual({
      status: "opened",
      value: { status: "executed", value: "cancelled-result-prepared" },
    });
    expect(capture.borrowedKey).toEqual(new Uint8Array(32));
  });

  test("rejects execution and cancellation evidence across brands", async () => {
    const state = await fixture();
    const executionFailure = await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceFor(state.domain),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskCancellationResultSigner({
        crypto: state.crypto,
        storage: state.storage,
        evidence: evidence as unknown as TaskRuntimeCancellationResultEvidence,
        domain: state.domain,
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () =>
          state.manager.publicKey,
        execute: () => "must-not-run",
      }),
    }).then(() => null, (error: unknown) => error);
    expect(executionFailure).toBeInstanceOf(TypeError);

    const cancellation = await withCancellationEvidence(state, ({
      evidence,
      domain,
    }) => withProtectedTaskResultSigner({
      crypto: state.crypto,
      storage: state.storage,
      evidence: evidence as unknown as Parameters<
        typeof withProtectedTaskResultSigner
      >[0]["evidence"],
      domain,
      expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
      resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
      resolveHistoricalSignerPublicationManager: () => state.manager.publicKey,
      execute: () => "must-not-run",
    }).then(() => null, (error: unknown) => error));
    expect(cancellation.status).toBe("opened");
    if (cancellation.status !== "opened") {
      throw new Error("cancellation result grant did not open");
    }
    expect(cancellation.value).toBeInstanceOf(TypeError);
  });

  test("rejects a substituted cancellation Domain before signer custody", async () => {
    const state = await fixture();
    let runtimeRead = false;
    let executed = false;
    const opened = await withCancellationEvidence(state, ({
      evidence,
      domain,
    }) => withProtectedTaskCancellationResultSigner({
      crypto: state.crypto,
      storage: {
        getAgentRuntimeAtomicState: async (...parameters) => {
          runtimeRead = true;
          return state.storage.getAgentRuntimeAtomicState(...parameters);
        },
        getAgentRuntimeSignerPublication:
          state.storage.getAgentRuntimeSignerPublication.bind(state.storage),
      },
      evidence,
      domain: Object.freeze({
        ...domain,
        sourceNamespaceId: "substituted-result-namespace",
      }),
      expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
      resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
      resolveHistoricalSignerPublicationManager: () => state.manager.publicKey,
      execute: () => {
        executed = true;
      },
    }));
    expect(opened).toEqual({
      status: "opened",
      value: { status: "unavailable", reason: "authority_unavailable" },
    });
    expect(runtimeRead).toBe(false);
    expect(executed).toBe(false);
  });

  test("rechecks cancellation expiry after awaited custody and callback", async () => {
    const state = await fixture();
    let executedAfterCustodyExpiry = false;
    const custodyFailure = await withCancellationEvidence(state, ({
      evidence,
      domain,
      expire,
    }) => withProtectedTaskCancellationResultSigner({
      crypto: state.crypto,
      storage: {
        getAgentRuntimeAtomicState:
          state.storage.getAgentRuntimeAtomicState.bind(state.storage),
        getAgentRuntimeSignerPublication: async (agent, generation) => {
          const publication = await state.storage
            .getAgentRuntimeSignerPublication(agent, generation);
          expire();
          return publication;
        },
      },
      evidence,
      domain,
      expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
      resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
      resolveHistoricalSignerPublicationManager: () => state.manager.publicKey,
      execute: () => {
        executedAfterCustodyExpiry = true;
      },
    })).then(() => null, (error: unknown) => error);
    expect(custodyFailure).toBeInstanceOf(TypeError);
    expect(executedAfterCustodyExpiry).toBe(false);

    const callbackState = await fixture();
    const capture: { borrowedKey: Uint8Array | null } = { borrowedKey: null };
    const callbackFailure = await withCancellationEvidence(callbackState, ({
      evidence,
      domain,
      expire,
    }) => withProtectedTaskCancellationResultSigner({
      crypto: callbackState.crypto,
      storage: callbackState.storage,
      evidence,
      domain,
      expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
      resolveHistoricalRuntimeCommitter: () => callbackState.committer.publicKey,
      resolveHistoricalSignerPublicationManager: () =>
        callbackState.manager.publicKey,
      execute: (authority) => {
        capture.borrowedKey = authority.runtime.key;
        expire();
        return "must-not-escape";
      },
    })).then(() => null, (error: unknown) => error);
    expect(callbackFailure).toBeInstanceOf(TypeError);
    expect(capture.borrowedKey).toEqual(new Uint8Array(32));
  });
});


test("execution evidence cannot mint a wake foreground signer", async () => {
  const f = await fixture();
  const error = await withTaskRuntimeExecutionEvidenceV1({ evidence: evidenceFor(f.domain),
    signal: new AbortController().signal, now: () => NOW,
    execute: evidence => withProtectedTaskWakeForegroundSigner({
      ...f, evidence: evidence as never, namespaceId: NAMESPACE_ID,
      expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
      resolveHistoricalRuntimeCommitter: () => f.committer.publicKey,
      resolveHistoricalSignerPublicationManager: () => f.manager.publicKey,
      execute: () => { throw new Error("must not execute"); },
    }),
  }).then(() => null, (error: unknown) => error);
  expect(error).toBeInstanceOf(TypeError);
});


test("wake opens genuine HIVE signer by independent foreground Namespace and wipes runtime on callback exit", async () => {
  const f = await fixture(); let key: Uint8Array | undefined;
  const result = await withWakeEvidence({ now: NOW, domain: f.domain, namespaceId: NAMESPACE_ID,
    accessRevision: 0, policyRevision: 5, signerAgentId: AGENT_ID,
    execute: evidence => withProtectedTaskWakeForegroundSigner({ ...f, evidence, namespaceId: NAMESPACE_ID,
      expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
      resolveHistoricalRuntimeCommitter: () => f.committer.publicKey,
      resolveHistoricalSignerPublicationManager: () => f.manager.publicKey,
      execute: authority => { key = authority.runtime.key; expect(key.some(b => b !== 0)).toBe(true); return 42; },
    }),
  });
  expect(result).toEqual({ status: "executed", value: 42 });
  expect(key!.every(b => b === 0)).toBe(true);
  expect(f.domain.domainKey.some(b => b !== 0)).toBe(true);
});

test("wake lends a certified fresh signer without permanent Runtime lookups", async () => {
  let permanentLookups = 0;
  let borrowedKey: Uint8Array | undefined;
  const result = await withPublicationSigner(({ crypto, evidence, domain }) =>
    withProtectedTaskWakeForegroundSigner({
      crypto,
      storage: {
        getAgentRuntimeAtomicState: async () => {
          permanentLookups += 1;
          throw new Error("fresh signer queried permanent Runtime state");
        },
        getAgentRuntimeSignerPublication: async () => {
          permanentLookups += 1;
          throw new Error("fresh signer queried permanent signer publication");
        },
      },
      evidence,
      namespaceId: PUBLICATION_NAMESPACE,
      domain: { ...domain, domainKey: bytes(0x51) },
      expectedAgentAuthorizationRevision: 0,
      resolveHistoricalRuntimeCommitter: () => {
        throw new Error("fresh signer queried Runtime history");
      },
      resolveHistoricalSignerPublicationManager: () => {
        throw new Error("fresh signer queried signer history");
      },
      execute: authority => {
        expect(authority.signerPublication).toBeNull();
        expect(authority.agentAuthorizationRevision).toBe(0);
        expect(authority.runtime.generation).toBe(agentRuntimeGeneration(0));
        borrowedKey = authority.runtime.key;
        expect(borrowedKey.some(byte => byte !== 0)).toBe(true);
        return "certified";
      },
    }));
  expect(result).toEqual({ status: "executed", value: "certified" });
  expect(permanentLookups).toBe(0);
  expect(borrowedKey?.every(byte => byte === 0)).toBe(true);
});

test("wake certified signer refuses a substituted foreground Namespace before lookup", async () => {
  let permanentLookups = 0;
  const result = await withPublicationSigner(({ crypto, evidence, domain }) =>
    withProtectedTaskWakeForegroundSigner({
      crypto,
      storage: {
        getAgentRuntimeAtomicState: async () => {
          permanentLookups += 1;
          return null;
        },
        getAgentRuntimeSignerPublication: async () => {
          permanentLookups += 1;
          return null;
        },
      },
      evidence,
      namespaceId: "namespace:substituted",
      domain: { ...domain, domainKey: bytes(0x51) },
      expectedAgentAuthorizationRevision: 0,
      resolveHistoricalRuntimeCommitter: () => null,
      resolveHistoricalSignerPublicationManager: () => null,
      execute: () => { throw new Error("substituted Namespace executed"); },
    }));
  expect(result).toMatchObject({ status: "unavailable" });
  expect(permanentLookups).toBe(0);
});

test.each(["private", "domain", "revision", "read-proof", "forgery", "manager"])("wake signer rejects %s authority", async reason => {
  const f = await fixture(); let effects = 0;
  const result = await withWakeEvidence({ now: NOW, domain: f.domain, namespaceId: NAMESPACE_ID,
    accessRevision: 0, policyRevision: 5, signerAgentId: AGENT_ID,
    execute: async (evidence, read) => withProtectedTaskWakeForegroundSigner({ ...f,
      evidence: reason === "read-proof" ? read as never : reason === "forgery" ? { ...evidence } : evidence,
      namespaceId: reason === "private" ? "private-result" : NAMESPACE_ID,
      domain: reason === "domain" ? { ...f.domain, headDigest: bytes(99) } : f.domain,
      expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION + (reason === "revision" ? 1 : 0),
      resolveHistoricalRuntimeCommitter: () => f.committer.publicKey,
      resolveHistoricalSignerPublicationManager: () => reason === "manager" ? null : f.manager.publicKey,
      execute: () => { effects += 1; },
    }),
  }).then(value => value, (error: unknown) => error);
  expect(effects).toBe(0);
  if (reason === "read-proof" || reason === "forgery") expect(result).toBeInstanceOf(TypeError);
  else expect(result).toMatchObject({ status: "unavailable" });
});

test("wake signer wipes runtime when live proof is revoked during callback", async () => {
  const f = await fixture(); const controller = new AbortController(); let key: Uint8Array | undefined;
  const error = await withWakeEvidence({ now: NOW, signal: controller.signal, domain: f.domain,
    namespaceId: NAMESPACE_ID, accessRevision: 0, policyRevision: 5, signerAgentId: AGENT_ID,
    execute: evidence => withProtectedTaskWakeForegroundSigner({ ...f, evidence, namespaceId: NAMESPACE_ID,
      expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
      resolveHistoricalRuntimeCommitter: () => f.committer.publicKey,
      resolveHistoricalSignerPublicationManager: () => f.manager.publicKey,
      execute: authority => { key = authority.runtime.key; controller.abort(); },
    }),
  }).then(() => null, (error: unknown) => error);
  expect(error).toBeInstanceOf(TypeError);
  expect(key!.every(b => b === 0)).toBe(true);
});
