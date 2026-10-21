import type { LatticeCrypto, KeyPair } from "@nautilo/lattice-crypto";

import {
  TaskRuntimeRecipientRegistryV1,
  withTaskRuntimeTemporarySignerV1,
  type TaskRuntimeCancellationResultEvidenceV1,
  type TaskRuntimeCancellationResultProofV1,
  type TaskRuntimeCertifiedPublicationSigningInputV1,
  type TaskRuntimeTemporarySignerV1,
} from "../../../lattice-crypto/src/background/task-runtime-recipient-registry-v1.ts";
import { createTaskRuntimeBackgroundAuthorizationRequestV1 } from
  "../../../lattice-crypto/src/background/task-runtime-request-v1.ts";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV3,
  encodeTaskRuntimeBackgroundAuthorizationRequestV3,
  taskRuntimeBackgroundAuthorizationIssuerV3,
  type TaskRuntimePublicationWorkBindingV3,
} from "../../../lattice-crypto/src/background/task-runtime-request-v3.ts";
import type { TaskRuntimeEphemeralSignerV2 } from
  "../../../lattice-crypto/src/background/task-runtime-request-authority.ts";
import { createTaskRuntimeSignerAuthorizationV2 } from
  "../../../lattice-crypto/src/background/task-runtime-signer-authorization-v1.ts";
import type {
  TaskRuntimeExecutionNamespaceAuthorityV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import type {
  TaskRuntimeRunResultReadEvidenceV1,
  TaskRuntimeRunResultReadInvocationV1,
  TaskRuntimeRunResultReadProofV1,
} from "../../../lattice-crypto/src/background/task-runtime-run-result-read-evidence-v1.ts";
import type {
  TaskRuntimeTerminalMessageEvidenceV1,
  TaskRuntimeTerminalMessageProofV1,
} from "../../../lattice-crypto/src/background/task-runtime-terminal-message-evidence-v1.ts";
import type { TaskRuntimeWakeForegroundEvidenceV1 } from
  "../../../lattice-crypto/src/background/task-runtime-wake-foreground-evidence-v1.ts";
import {
  createDomainForegroundAuthorizationPlanV2,
  mintDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
  type DomainForegroundAuthorityEntryV2,
  type DomainForegroundAuthorizationPublicCurrentAuthorityV2,
  type DomainForegroundSecretEntryV2,
} from "../../../lattice-crypto/src/format/domain-foreground-authorization-v2.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
} from "../../../lattice-crypto/src/v2-types/ids.ts";

type PublicationCommon = Readonly<{
  crypto: LatticeCrypto;
  now: number;
  deviceSigner: KeyPair;
  requestId: string;
  sessionId: string;
  roomId: string;
  requesterHumanId: string;
  signerAgentId: string;
  policyRevision: number;
  domains: readonly (DomainForegroundSecretEntryV2 & Pick<
    DomainForegroundAuthorityEntryV2,
    "activeNamespaceBindingSetDigest" | "activeNamespaceBindingCount"
  >)[];
  namespaceRequirements:
    readonly TaskRuntimeExecutionNamespaceAuthorityV1[];
  work: TaskRuntimePublicationWorkBindingV3;
}>;

type CertifiedPublication = Readonly<{
  registry: TaskRuntimeRecipientRegistryV1;
  authorizationBytes: Uint8Array;
  certificateBytes: Uint8Array;
  requestBytes: Uint8Array;
  recipientKeyId: string;
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
  certifiedSigning: TaskRuntimeCertifiedPublicationSigningInputV1;
  signer: TaskRuntimeEphemeralSignerV2;
}>;

const DEVICE = "device:task-publication-signer-fixture";
const SERVER = "server:task-publication-signer-fixture";
const RECIPIENT_KEY = "recipient:task-publication-signer-fixture";
const bytes = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

async function withCertifiedPublication<Value>(
  input: PublicationCommon,
  use: (publication: CertifiedPublication) => Value | PromiseLike<Value>,
): Promise<Value> {
  const registry = new TaskRuntimeRecipientRegistryV1(input.crypto, {
    now: () => input.now,
  });
  const domains = [...input.domains].sort((left, right) =>
    left.domainId.localeCompare(right.domainId));
  const workId = input.work.kind === "task.delivery_wake"
    ? input.work.jobId
    : input.work.taskRunId;
  const created = await registry.createAttempt({
    requestId: input.requestId,
    workId,
    recipientGeneration: 0,
    recipientKeyId: RECIPIENT_KEY,
    expiresAt: input.now + 60_000,
    signerAgentId: input.signerAgentId,
  });
  if (created.status !== "created" || created.attempt.signer === undefined) {
    registry.close();
    throw new Error("Task publication signer fixture recipient was not created");
  }
  const recipient = created.attempt;
  const signer = recipient.signer;
  if (signer === undefined) throw new Error("Task publication signer is absent");
  const plan = createDomainForegroundAuthorizationPlanV2(input.crypto, {
    authorizationId: input.requestId,
    policyRevision: input.policyRevision,
    sessionId: input.sessionId,
    roomId: input.roomId,
    subjectHumanId: humanId(input.requesterHumanId),
    committerDeviceId: cryptoDeviceId(DEVICE),
    committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(5),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: recipient.recipientKeyId,
    operations: input.work.kind === "task.deliver_message"
        || input.work.kind === "task.cancel_result"
      ? ["encrypt"]
      : ["decrypt", "encrypt"],
    issuedAt: input.now,
    deadlineAt: input.now + 60_000,
    maximumSecretBytes: 2048,
    domains: domains.map(({ domainKey: _domainKey, ...domain }) => domain),
  });
  const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: input.requestId,
    workId,
    workKind: input.work.kind,
    workPurpose: input.work.kind,
    recipientGeneration: 0,
    episodeId: input.sessionId,
    sourceRoomId: input.roomId,
    recipientKeyId: recipient.recipientKeyId,
    recipientPublicKey: recipient.recipientPublicKey,
    authorizationPlan: plan,
    issuedAt: plan.issuedAt,
    deadlineAt: plan.deadlineAt,
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV3(
    input.crypto,
    {
      baseRequest,
      work: input.work,
      signer,
      deviceGroupHead: {
        serverInstanceId: SERVER,
        lineageGeneration: 1,
        epoch: 1,
        headDigest: bytes(0xa1),
        signingPublicKeyHash: input.crypto.hash(input.deviceSigner.publicKey),
      },
      namespaceRequirements: input.namespaceRequirements,
    },
  );
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV3(
    input.crypto,
    request,
  );
  const authorization = await mintDomainForegroundAuthorizationV2(input.crypto, {
    plan,
    domains,
    committerDeviceSigningPrivateKey: input.deviceSigner.privateKey,
    recipientEncryptionPublicKey: recipient.recipientPublicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const authorizationHash = input.crypto.hash(authorizationBytes);
  const planBytes = serializeDomainForegroundAuthorizationPlanV2(plan);
  const certificateBytes = createTaskRuntimeSignerAuthorizationV2(input.crypto, {
    requestBytes,
    authorizationBytes,
    expectedAuthorizationPlanBytes: planBytes,
    expectedAuthorizationHash: authorizationHash,
    issuerSigningPrivateKey: input.deviceSigner.privateKey,
  });
  planBytes.fill(0);
  authorizationHash.fill(0);
  const current = {
    authorizationId: input.requestId,
    policyRevision: input.policyRevision,
    sessionId: input.sessionId,
    roomId: input.roomId,
    subjectHumanId: plan.subjectHumanId,
    committerDeviceId: plan.committerDeviceId,
    committerDeviceSigningGeneration: 1,
    committerDeviceSigningPublicKey: input.deviceSigner.publicKey,
    committerDeviceActive: true,
    hostAuthorizationRevision: authorizationRevision(5),
    recipientKind: "runtime" as const,
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: recipient.recipientKeyId,
    recipientAuthorized: true,
    domains: domains.map(({ domainKey: _domainKey, ...domain }) => domain),
  };
  const certifiedSigning = {
    requestBytes,
    certificateBytes,
    currentIssuer: taskRuntimeBackgroundAuthorizationIssuerV3(request),
    expectedPublication: input.work,
  };
  try {
    return await use({ registry, authorizationBytes, certificateBytes, signer,
      requestBytes, recipientKeyId: recipient.recipientKeyId, current,
      certifiedSigning });
  } finally {
    registry.close();
    authorizationBytes.fill(0);
    certificateBytes.fill(0);
    requestBytes.fill(0);
    certifiedSigning.currentIssuer.headDigest.fill(0);
    certifiedSigning.currentIssuer.signingPublicKeyHash.fill(0);
  }
}

/** Build genuine RequestV3/certificateV2 evidence for a wake publication. */
export async function withCertifiedWakePublicationSigner<Value>(
  input: PublicationCommon & Readonly<{
    work: Extract<TaskRuntimePublicationWorkBindingV3,
      { kind: "task.delivery_wake" }>;
    requesterHumanId: string;
    result: TaskRuntimeRunResultReadProofV1;
    invocation: Extract<TaskRuntimeRunResultReadInvocationV1,
      { kind: "wake" }>;
    foregroundNamespaceRequirements:
      readonly TaskRuntimeExecutionNamespaceAuthorityV1[];
  }>,
  use: (input: Readonly<{
    evidence: TaskRuntimeWakeForegroundEvidenceV1;
    authorizationBytes: Uint8Array;
    certificateBytes: Uint8Array;
    signer: TaskRuntimeTemporarySignerV1;
  }>) => Value | Promise<Value>,
): Promise<Value> {
  return withCertifiedPublication(input, async publication => {
    const opened = await publication.registry.withOpenedRunResultReadGrant({
      requestId: input.requestId,
      workId: input.work.jobId,
      workKind: "task.delivery_wake",
      recipientGeneration: 0,
      recipientKeyId: publication.recipientKeyId,
      claimId: "certified-wake-publication",
      claimExpiresAt: input.now + 30_000,
      authorizationBytes: publication.authorizationBytes,
      current: publication.current,
      requesterHumanId: input.requesterHumanId,
      result: input.result,
      invocation: input.invocation,
      currentNamespaceRequirements: input.namespaceRequirements,
      currentForegroundNamespaceRequirements:
        input.foregroundNamespaceRequirements,
      certifiedSigning: publication.certifiedSigning,
      operation: (_partitions, _signal, _readEvidence, wakeEvidence) => {
        if (wakeEvidence === undefined || wakeEvidence === null) {
          throw new Error("Certified wake evidence is absent");
        }
        return withTaskRuntimeTemporarySignerV1(wakeEvidence, signer => use({
          evidence: wakeEvidence,
          authorizationBytes: publication.authorizationBytes,
          signer,
          certificateBytes: publication.certificateBytes,
        }));
      },
    });
    if (opened.status !== "opened") {
      throw new Error(`Certified wake publication did not open: ${opened.reason}`);
    }
    return opened.value;
  });
}

export async function withCertifiedTerminalPublicationSigner<Value>(
  input: PublicationCommon & Readonly<{
    work: Extract<TaskRuntimePublicationWorkBindingV3,
      { kind: "task.deliver_message" }>;
    message: TaskRuntimeTerminalMessageProofV1;
  }>,
  use: (input: Readonly<{
    evidence: TaskRuntimeTerminalMessageEvidenceV1;
    signer: TaskRuntimeTemporarySignerV1;
    authorizationBytes: Uint8Array;
    certificateBytes: Uint8Array;
  }>) => Value | Promise<Value>,
): Promise<Value> {
  return withCertifiedPublication(input, async publication => {
    const opened = await publication.registry.withOpenedTerminalMessageGrant({
      requestId: input.requestId,
      workId: input.work.taskRunId,
      recipientGeneration: 0,
      recipientKeyId: publication.recipientKeyId,
      claimId: "certified-terminal-publication",
      claimExpiresAt: input.now + 30_000,
      authorizationBytes: publication.authorizationBytes,
      current: publication.current,
      currentNamespaceRequirements: input.namespaceRequirements,
      message: input.message,
      certifiedSigning: publication.certifiedSigning,
      operation: (_domains, _signal, evidence) =>
        withTaskRuntimeTemporarySignerV1(evidence, signer => use({ evidence,
          signer, authorizationBytes: publication.authorizationBytes,
          certificateBytes: publication.certificateBytes })),
    });
    if (opened.status !== "opened") {
      throw new Error(`Certified terminal publication did not open: ${opened.reason}`);
    }
    return opened.value;
  });
}

export async function withCertifiedRunResultPublicationSigner<Value>(
  input: PublicationCommon & Readonly<{
    work: Extract<TaskRuntimePublicationWorkBindingV3,
      { kind: "task.deliver_result" }>;
    requesterHumanId: string;
    result: TaskRuntimeRunResultReadProofV1;
    invocation: Extract<TaskRuntimeRunResultReadInvocationV1, { kind: "raw" }>;
    foregroundNamespaceRequirements:
      readonly TaskRuntimeExecutionNamespaceAuthorityV1[];
  }>,
  use: (input: Readonly<{
    evidence: TaskRuntimeRunResultReadEvidenceV1;
    signer: TaskRuntimeTemporarySignerV1;
    authorizationBytes: Uint8Array;
    certificateBytes: Uint8Array;
  }>) => Value | Promise<Value>,
): Promise<Value> {
  return withCertifiedPublication(input, async publication => {
    const opened = await publication.registry.withOpenedRunResultReadGrant({
      requestId: input.requestId,
      workId: input.work.taskRunId,
      workKind: "task.deliver_result",
      recipientGeneration: 0,
      recipientKeyId: publication.recipientKeyId,
      claimId: "certified-run-result-publication",
      claimExpiresAt: input.now + 30_000,
      authorizationBytes: publication.authorizationBytes,
      current: publication.current,
      requesterHumanId: input.requesterHumanId,
      result: input.result,
      invocation: input.invocation,
      currentNamespaceRequirements: input.namespaceRequirements,
      currentForegroundNamespaceRequirements:
        input.foregroundNamespaceRequirements,
      certifiedSigning: publication.certifiedSigning,
      operation: (_partitions, _signal, evidence) =>
        withTaskRuntimeTemporarySignerV1(evidence, signer => use({ evidence,
          signer, authorizationBytes: publication.authorizationBytes,
          certificateBytes: publication.certificateBytes })),
    });
    if (opened.status !== "opened") {
      throw new Error(`Certified result publication did not open: ${opened.reason}`);
    }
    return opened.value;
  });
}

export async function withCertifiedCancellationPublicationSigner<Value>(
  input: PublicationCommon & Readonly<{
    work: Extract<TaskRuntimePublicationWorkBindingV3,
      { kind: "task.cancel_result" }>;
    result: TaskRuntimeCancellationResultProofV1;
  }>,
  use: (input: Readonly<{
    evidence: TaskRuntimeCancellationResultEvidenceV1;
    signer: TaskRuntimeTemporarySignerV1;
    authorizationBytes: Uint8Array;
    certificateBytes: Uint8Array;
  }>) => Value | Promise<Value>,
): Promise<Value> {
  return withCertifiedPublication(input, async publication => {
    const opened = await publication.registry.withOpenedCancellationResultGrant({
      requestId: input.requestId,
      workId: input.work.taskRunId,
      recipientGeneration: 0,
      recipientKeyId: publication.recipientKeyId,
      claimId: "certified-cancellation-publication",
      claimExpiresAt: input.now + 30_000,
      authorizationBytes: publication.authorizationBytes,
      current: publication.current,
      currentNamespaceRequirements: input.namespaceRequirements,
      result: input.result,
      certifiedSigning: publication.certifiedSigning,
      operation: (_domains, _signal, evidence) =>
        withTaskRuntimeTemporarySignerV1(evidence, signer => use({ evidence,
          signer, authorizationBytes: publication.authorizationBytes,
          certificateBytes: publication.certificateBytes })),
    });
    if (opened.status !== "opened") {
      throw new Error(
        `Certified cancellation publication did not open: ${opened.reason}`,
      );
    }
    return opened.value;
  });
}
