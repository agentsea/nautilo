import { bytesToHex } from "@noble/hashes/utils.js";

import {
  agentRuntimeSignerPublicationMatchesRuntimeV1,
  verifyHistoricalAgentRuntimeSignerPublicationV1,
  type AgentRuntimeSignerPublicationV1,
  type ResolveHistoricalAgentRuntimeSignerPublicationManagerV1,
} from "../agent-runtime/signer-publication-v1.ts";
import type { AgentRuntimeGenerationV2 } from "../agent-runtime/types.ts";
import { deriveAgentRuntimeObjectSignerPublicV1 } from
  "../agent-runtime/object-signer-v1.ts";
import {
  assertAuthenticTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionDomainAuthorityV1,
  type TaskRuntimeExecutionEvidenceV1,
} from "../background/task-runtime-execution-evidence-v1.ts";
import {
  assertAuthenticTaskRuntimeCancellationResultEvidenceV1,
  type TaskRuntimeTemporarySignerV1,
  type TaskRuntimeCancellationResultEvidenceV1,
  type TaskRuntimeTemporarySignerEvidenceV1,
} from "../background/task-runtime-recipient-registry-v1.ts";
import {
  assertAuthenticTaskRuntimeRunResultReadEvidenceV1,
} from "../background/task-runtime-run-result-read-evidence-v1.ts";
import {
  assertAuthenticTaskRuntimeTerminalMessageEvidenceV1,
} from "../background/task-runtime-terminal-message-evidence-v1.ts";
import {
  assertAuthenticTaskRuntimeWakeForegroundEvidenceV1,
} from "../background/task-runtime-wake-foreground-evidence-v1.ts";
import {
  destroyVerifiedTaskRuntimeSignerAuthorization,
  verifyHistoricalTaskRuntimeSignerAuthorization,
} from "../background/task-runtime-signer-authorization-v1.ts";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  createAgentObjectAccessManifestV5,
  createTaskRuntimeObjectAccessManifestV5,
  type ObjectAccessManifestV5,
} from "../format/object-access-manifest-v5.ts";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../format/object-v2.ts";
import {
  assertVerifiedNamespaceBindingHead,
  namespaceKeyringEnvelopeHash,
} from "../namespace/bindings.ts";
import type { HistoricalCommitterResolverV2 } from
  "../namespace/authorization.ts";
import { withOpenedDomainNamespaceBundleV2 } from "../format/domain-namespace-bundle-v2.ts";
import { openNamespaceKeyring } from "../namespace/keyrings.ts";
import type {
  NamespaceKeyringEnvelopeV2,
  VerifiedNamespaceBindingHeadV2,
} from "../namespace/types.ts";
import {
  accessRevision,
  authorizationRevision,
  namespaceId,
  namespaceGeneration,
  objectId,
  unixTimestamp,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  encryptedObjectWriteRecordV2,
} from "../storage/v2-record-policy.ts";
import type { OpaqueEncryptedObjectRecordV2 } from
  "../storage/v2-records.ts";
import { encryptObjectPayloadV2 } from "./payload.ts";
import { wrapObjectDekForNamespaceV2 } from "./namespace-envelope.ts";

const HASH_BYTES = 32;

type ResultEvidence = TaskRuntimeExecutionEvidenceV1
  | TaskRuntimeCancellationResultEvidenceV1;

function assertResultEvidence(evidence: ResultEvidence): void {
  if (evidence.purpose === "task.runtime.cancellation_result") {
    assertAuthenticTaskRuntimeCancellationResultEvidenceV1(evidence);
  } else {
    assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
  }
}

function assertTemporarySignerPreparationEvidence(
  evidence: TaskRuntimeTemporarySignerEvidenceV1,
): void {
  switch (evidence.purpose) {
    case "task.runtime.execution":
      assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
      break;
    case "task.runtime.cancellation_result":
      assertAuthenticTaskRuntimeCancellationResultEvidenceV1(evidence);
      break;
    case "task.runtime.terminal_message":
      assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(evidence);
      break;
    case "task.runtime.run_result_read":
      assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence);
      break;
    case "task.runtime.wake_foreground":
      assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(evidence);
      break;
  }
}

function taskRuntimePublicationWorkMatchesEvidence(
  projection: Extract<
    ReturnType<typeof verifyHistoricalTaskRuntimeSignerAuthorization>["projection"],
    { formatVersion: 2 }
  >,
  evidence: Exclude<
    TaskRuntimeTemporarySignerEvidenceV1,
    TaskRuntimeExecutionEvidenceV1
  >,
): boolean {
  const work = projection.work;
  switch (evidence.purpose) {
    case "task.runtime.cancellation_result":
      return work.kind === "task.cancel_result"
        && work.taskId === evidence.result.taskId
        && work.taskRunId === evidence.result.taskRunId
        && work.contentRevision === 2;
    case "task.runtime.terminal_message":
      return work.kind === "task.deliver_message"
        && work.taskId === evidence.message.taskId
        && work.taskRunId === evidence.message.taskRunId
        && work.contentRevision === 2
        && work.messageObjectId === evidence.message.objectId;
    case "task.runtime.run_result_read":
      return evidence.workKind === "task.deliver_result"
        && evidence.invocation.kind === "raw"
        && evidence.result.contentRevision === 1
        && work.kind === "task.deliver_result"
        && work.taskId === evidence.result.taskId
        && work.taskRunId === evidence.result.taskRunId
        && work.contentRevision === 1;
    case "task.runtime.wake_foreground":
      return work.kind === "task.delivery_wake"
        && work.taskId === evidence.invocation.reference.taskId
        && work.taskRunId === evidence.invocation.reference.taskRunId
        && work.contentRevision === evidence.sourceContentRevision
        && work.jobId === evidence.invocation.jobId;
  }
}

function taskRuntimeEvidenceSignerAgentId(
  evidence: TaskRuntimeTemporarySignerEvidenceV1,
): string {
  switch (evidence.purpose) {
    case "task.runtime.execution":
    case "task.runtime.cancellation_result":
      return evidence.result.signerAgentId;
    case "task.runtime.terminal_message":
      return evidence.message.signerAgentId;
    case "task.runtime.run_result_read":
      return evidence.result.signerAgentId;
    case "task.runtime.wake_foreground":
      return evidence.signerAgentId;
  }
}


export type TaskRuntimeResultNamespaceSourceV1 = Readonly<{
  trustedHead: VerifiedNamespaceBindingHeadV2;
  aiKeyringEnvelope: NamespaceKeyringEnvelopeV2;
  currentDomainRoot: Uint8Array;
  resolveHistoricalCommitter: HistoricalCommitterResolverV2;
}>;

export type PrepareTaskRuntimeResultObjectV1Input = Readonly<{
  evidence: TaskRuntimeExecutionEvidenceV1;
  plaintext: Uint8Array;
  objectType: string;
  createdAt: number;
  namespace: TaskRuntimeResultNamespaceSourceV1;
  agentAuthorizationRevision: number;
  runtime: AgentRuntimeGenerationV2;
  signerPublication: AgentRuntimeSignerPublicationV1 | null;
  temporarySigner?: TaskRuntimeTemporarySignerV1;
  resolveHistoricalSignerPublicationManager:
    ResolveHistoricalAgentRuntimeSignerPublicationManagerV1;
}>;

export type TaskRuntimeResultObjectAuthorityV1 = Readonly<{
  purpose: "persist-task-runtime-result-genesis";
  requestId: string;
  workId: string;
  claimId: string;
  authorizationDigest: Uint8Array;
  objectId: string;
  payloadHash: Uint8Array;
  taskId: string;
  taskRunId: string;
  contentRevision: 1 | 2;
  namespace: Readonly<{
    namespaceId: string;
    domainId: string;
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
    bindingHash: Uint8Array;
    keyGeneration: number;
    envelopeHash: Uint8Array;
  }>;
  domain: TaskRuntimeExecutionDomainAuthorityV1;
  agentId: string;
  runtimeGeneration: number;
  agentAuthorizationRevision: number;
  signerKeyId: string;
}>;

export type PreparedTaskRuntimeResultObjectV1 = Readonly<{
  object: OpaqueEncryptedObjectRecordV2;
  access: Readonly<{
    manifest: ObjectAccessManifestV5;
    manifestBytes: Uint8Array;
    manifestHash: Uint8Array;
    envelopeBytes: readonly [Uint8Array];
    authority: TaskRuntimeResultObjectAuthorityV1;
    signerEvidenceBytes?: Uint8Array;
  }>;
}>;

type PreparedSnapshot = Readonly<{
  payloadBytes: Uint8Array;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: Uint8Array;
  authorityFingerprint: string;
  signerEvidenceBytes: Uint8Array | null;
}>;

const preparedSnapshots = new WeakMap<object, PreparedSnapshot>();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function sameIssuer(
  left: TaskRuntimeTemporarySignerV1["issuer"],
  right: TaskRuntimeTemporarySignerV1["issuer"],
): boolean {
  return left.humanId === right.humanId
    && left.deviceId === right.deviceId
    && left.deviceGeneration === right.deviceGeneration
    && left.serverInstanceId === right.serverInstanceId
    && left.lineageGeneration === right.lineageGeneration
    && left.epoch === right.epoch
    && left.securityRevision === right.securityRevision
    && sameBytes(left.headDigest, right.headDigest)
    && sameBytes(left.signingPublicKeyHash, right.signingPublicKeyHash);
}

export function assertTaskRuntimeTemporarySignerForPreparationV1(
  crypto: LatticeCrypto,
  evidence: TaskRuntimeTemporarySignerEvidenceV1,
  runtime: AgentRuntimeGenerationV2,
  signer: TaskRuntimeTemporarySignerV1,
): Readonly<{
  signerKeyId: string;
  certificateHash: Uint8Array;
  hostAuthorizationRevision: number;
}> {
  assertTemporarySignerPreparationEvidence(evidence);
  let verified: ReturnType<
    typeof verifyHistoricalTaskRuntimeSignerAuthorization
  > | undefined;
  const derived = deriveAgentRuntimeObjectSignerPublicV1(crypto, signer.runtime);
  try {
    verified = verifyHistoricalTaskRuntimeSignerAuthorization(crypto, {
      certificateBytes: signer.certificateBytes,
      resolveHistoricalIssuer: context =>
        sameBytes(
          context.projection.request.requestHash,
          signer.requestHash,
        )
          && sameBytes(
            context.projection.request.authorizationHash,
            signer.authorizationHash,
          )
          && sameIssuer(context.issuer, signer.issuer)
          ? signer.issuerSigningPublicKey
          : null,
    }, evidence.purpose === "task.runtime.execution" ? 1 : 2);
    const projection = verified.projection;
    const request = projection.request;
    const workMatches = evidence.purpose === "task.runtime.execution"
      ? projection.formatVersion === 1
        && projection.work.taskRunId === evidence.workId
        && projection.work.taskId === evidence.result.taskId
        && projection.work.resultObjectId === evidence.result.objectId
      : projection.formatVersion === 2
        && taskRuntimePublicationWorkMatchesEvidence(projection, evidence);
    if (
      runtime.agentId !== signer.runtime.agentId
      || runtime.generation !== signer.runtime.generation
      || !sameBytes(runtime.key, signer.runtime.key)
      || signer.runtime.generation !== 0
      || derived.principal.agentId !== projection.signer.agentId
      || derived.principal.runtimeGeneration
        !== projection.signer.runtimeGeneration
      || derived.principal.signerKeyId !== projection.signer.signerKeyId
      || !sameBytes(derived.publicKey, signer.signerPublicKey)
      || !sameBytes(
        projection.signer.signerPublicKey,
        signer.signerPublicKey,
      )
      || !sameIssuer(verified.issuer, signer.issuer)
      || !sameBytes(
        request.requestHash,
        signer.requestHash,
      )
      || !sameBytes(
        request.authorizationHash,
        signer.authorizationHash,
      )
      || !sameBytes(evidence.authorizationDigest, signer.authorizationHash)
      || request.requestId !== evidence.requestId
      || request.recipientGeneration !== evidence.recipientGeneration
      || request.recipientKeyId !== evidence.recipientKeyId
      || request.policyRevision !== evidence.policyRevision
      || request.deadlineAt !== evidence.recipientExpiresAt
      || !workMatches
      || projection.signer.agentId !== taskRuntimeEvidenceSignerAgentId(evidence)
      || verified.issuer.securityRevision !== evidence.hostAuthorizationRevision
    ) throw new TypeError("Task Runtime temporary signer authority was substituted");
    return Object.freeze({
      signerKeyId: derived.principal.signerKeyId,
      certificateHash: crypto.hash(signer.certificateBytes),
      hostAuthorizationRevision: verified.issuer.securityRevision,
    });
  } finally {
    derived.publicKey.fill(0);
    if (verified !== undefined) {
      destroyVerifiedTaskRuntimeSignerAuthorization(verified);
    }
  }
}

function exactHash(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function cloneDomain(
  value: TaskRuntimeExecutionDomainAuthorityV1,
): TaskRuntimeExecutionDomainAuthorityV1 {
  return Object.freeze({
    ...value,
    participantDigest: exactHash(
      "Task result Domain participant digest",
      value.participantDigest,
    ),
    headDigest: exactHash("Task result Domain head digest", value.headDigest),
    activeNamespaceBindingSetDigest: exactHash(
      "Task result Domain binding-set digest",
      value.activeNamespaceBindingSetDigest,
    ),
  });
}

function cloneAuthority(
  value: TaskRuntimeResultObjectAuthorityV1,
): TaskRuntimeResultObjectAuthorityV1 {
  return Object.freeze({
    ...value,
    authorizationDigest: exactHash(
      "Task result authorization digest",
      value.authorizationDigest,
    ),
    payloadHash: exactHash("Task result payload hash", value.payloadHash),
    namespace: Object.freeze({
      ...value.namespace,
      bindingHash: exactHash(
        "Task result Namespace binding hash",
        value.namespace.bindingHash,
      ),
      envelopeHash: exactHash(
        "Task result Namespace envelope hash",
        value.namespace.envelopeHash,
      ),
    }),
    domain: cloneDomain(value.domain),
  });
}

function authorityFingerprint(value: TaskRuntimeResultObjectAuthorityV1): string {
  return JSON.stringify({
    ...value,
    authorizationDigest: bytesToHex(value.authorizationDigest),
    payloadHash: bytesToHex(value.payloadHash),
    namespace: {
      ...value.namespace,
      bindingHash: bytesToHex(value.namespace.bindingHash),
      envelopeHash: bytesToHex(value.namespace.envelopeHash),
    },
    domain: {
      ...value.domain,
      participantDigest: bytesToHex(value.domain.participantDigest),
      headDigest: bytesToHex(value.domain.headDigest),
      activeNamespaceBindingSetDigest:
        bytesToHex(value.domain.activeNamespaceBindingSetDigest),
    },
  });
}

function matchingDomain(
  evidence: ResultEvidence,
): TaskRuntimeExecutionDomainAuthorityV1 {
  const matches = evidence.domainRequirements.filter((entry) =>
    entry.domainId === evidence.result.namespace.domainId
  );
  if (matches.length !== 1) {
    throw new TypeError("Task result Domain authority is not exact");
  }
  return matches[0]!;
}

function preparationSigner(
  crypto: LatticeCrypto,
  input: Pick<PrepareTaskRuntimeResultObjectV1Input,
    "agentAuthorizationRevision" | "runtime" | "signerPublication"
    | "temporarySigner" | "resolveHistoricalSignerPublicationManager">,
  evidence: ResultEvidence,
): Readonly<{
  runtime: AgentRuntimeGenerationV2;
  signerKeyId: string;
  signerAuthorizationHash: Uint8Array | null;
  hostAuthorizationRevision: number;
  signerEvidenceBytes: Uint8Array | null;
}> {
  const temporary = input.temporarySigner;
  if ((input.signerPublication === null) === (temporary === undefined)) {
    throw new TypeError("Task result preparation requires exactly one signer authority");
  }
  if (temporary !== undefined) {
    if (input.agentAuthorizationRevision !== 0) {
      throw new TypeError("Temporary Task Runtime Agent authorization revision must be zero");
    }
    const authority = assertTaskRuntimeTemporarySignerForPreparationV1(
      crypto,
      evidence,
      input.runtime,
      temporary,
    );
    return Object.freeze({
      runtime: temporary.runtime,
      signerKeyId: authority.signerKeyId,
      signerAuthorizationHash: authority.certificateHash,
      hostAuthorizationRevision: authority.hostAuthorizationRevision,
      signerEvidenceBytes: temporary.certificateBytes.slice(),
    });
  }
  const publication = input.signerPublication!;
  if (
    publication.agentId !== evidence.result.signerAgentId
    || publication.authorizationRevision
      !== authorizationRevision(input.agentAuthorizationRevision)
    || !agentRuntimeSignerPublicationMatchesRuntimeV1(
      crypto,
      input.runtime,
      publication,
    )
    || !verifyHistoricalAgentRuntimeSignerPublicationV1({
      crypto,
      publication,
      resolveHistoricalManagerAuthority:
        input.resolveHistoricalSignerPublicationManager,
    })
  ) throw new TypeError("Task result preparation authority was substituted");
  return Object.freeze({
    runtime: input.runtime,
    signerKeyId: publication.signerKeyId,
    signerAuthorizationHash: null,
    hostAuthorizationRevision: input.agentAuthorizationRevision,
    signerEvidenceBytes: null,
  });
}

/**
 * Prepares one Task result only while its opened HIVE Task authorization is
 * live. The persona Agent signs the V5 manifest but is never treated as the
 * grant recipient.
 */
export function prepareTaskRuntimeResultObjectV1(
  crypto: LatticeCrypto,
  input: PrepareTaskRuntimeResultObjectV1Input,
): PreparedTaskRuntimeResultObjectV1 {
  assertAuthenticTaskRuntimeExecutionEvidenceV1(input.evidence);
  if (!(input.plaintext instanceof Uint8Array)) {
    throw new TypeError("Task result plaintext must be Uint8Array");
  }
  assertVerifiedNamespaceBindingHead(input.namespace.trustedHead);
  const evidence = input.evidence;
  const resultNamespace = evidence.result.namespace;
  const head = input.namespace.trustedHead;
  const binding = head.binding;
  const domain = matchingDomain(evidence);
  const envelopeHash = namespaceKeyringEnvelopeHash(
    input.namespace.aiKeyringEnvelope,
  );
  if (
    evidence.result.taskRunId !== evidence.workId
    || evidence.result.objectId.length < 1
    || evidence.policyRevision !== resultNamespace.expectedPolicyRevision
    || head.namespaceId !== resultNamespace.namespaceId
    || head.accessRevision !== resultNamespace.expectedAccessRevision
    || binding.namespaceId !== resultNamespace.namespaceId
    || binding.domainId !== resultNamespace.domainId
    || binding.domainEpoch !== domain.domainKeyGeneration
    || binding.accessRevision !== resultNamespace.expectedAccessRevision
    || input.namespace.aiKeyringEnvelope.keyClass !== "ai"
    || input.namespace.aiKeyringEnvelope.namespaceId !== binding.namespaceId
    || input.namespace.aiKeyringEnvelope.domainId !== binding.domainId
    || input.namespace.aiKeyringEnvelope.domainEpoch !== binding.domainEpoch
    || input.namespace.aiKeyringEnvelope.accessRevision !== binding.accessRevision
    || input.namespace.aiKeyringEnvelope.currentGeneration
      !== binding.aiCurrentGeneration
    || !sameBytes(envelopeHash, binding.aiKeyringEnvelopeHash)
    || input.runtime.agentId !== evidence.result.signerAgentId
  ) {
    envelopeHash.fill(0);
    throw new TypeError("Task result preparation authority was substituted");
  }

  const signer = preparationSigner(crypto, input, evidence);
  signer.signerAuthorizationHash?.fill(0);
  signer.signerEvidenceBytes?.fill(0);

  let keyring: ReturnType<typeof openNamespaceKeyring>;
  try {
    keyring = openNamespaceKeyring({
      crypto,
      domainRoot: input.namespace.currentDomainRoot,
      envelope: input.namespace.aiKeyringEnvelope,
      resolveHistoricalCommitter: input.namespace.resolveHistoricalCommitter,
    });
  } catch (error) {
    envelopeHash.fill(0);
    throw error;
  }
  try {
    const current = keyring.generations.find((entry) =>
      entry.generation === keyring.currentGeneration
    );
    if (
      keyring.namespaceId !== resultNamespace.namespaceId
      || keyring.keyClass !== "ai"
      || keyring.accessRevision !== resultNamespace.expectedAccessRevision
      || keyring.currentGeneration !== binding.aiCurrentGeneration
      || current === undefined
    ) throw new TypeError("Task result current Namespace key is unavailable");

    return sealTaskRuntimeResultWithNamespaceKey(crypto, input, {
      key: current.key, keyGeneration: current.generation, bindingHash: head.bindingHash,
    });
  } finally {
    envelopeHash.fill(0);
    for (const generation of keyring.generations) generation.key.fill(0);
  }
}

function sealTaskRuntimeResultWithNamespaceKey(
  crypto: LatticeCrypto,
  input: Omit<PrepareTaskRuntimeResultObjectV1Input, "namespace" | "evidence">
    & Readonly<{ evidence: ResultEvidence }>,
  namespace: Readonly<{ key: Uint8Array; keyGeneration: number; bindingHash: Uint8Array }>,
): PreparedTaskRuntimeResultObjectV1 {
  const evidence = input.evidence;
  const resultNamespace = evidence.result.namespace;
  const domain = matchingDomain(evidence);
  const targetObjectId = objectId(evidence.result.objectId);
  const targetNamespaceId = namespaceId(resultNamespace.namespaceId);
  const targetAccessRevision = accessRevision(resultNamespace.expectedAccessRevision);
  const createdAt = unixTimestamp(input.createdAt);
  const plaintext = Uint8Array.from(input.plaintext);
  let payloadBytes: Uint8Array | undefined;
  let namespaceEnvelopeBytes: Uint8Array | undefined;
  let payloadHash: Uint8Array | undefined;
  let namespaceEnvelopeHash: Uint8Array | undefined;
  try {
    const signer = preparationSigner(crypto, input, evidence);
    const encrypted = encryptObjectPayloadV2(crypto, {
      objectId: targetObjectId,
      keyClass: "ai",
      objectType: input.objectType,
      createdAt,
    }, plaintext);
    try {
      payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
      const namespaceEnvelope = wrapObjectDekForNamespaceV2(
        crypto,
        namespace.key,
        {
          objectId: targetObjectId,
          namespaceId: targetNamespaceId,
          keyClass: "ai",
          keyGeneration: namespaceGeneration(namespace.keyGeneration),
          bindingRevisionAtWrap: targetAccessRevision,
        },
        encrypted.dek,
      );
      try {
        namespaceEnvelopeBytes = encodeNamespaceObjectEnvelopeV2(
          namespaceEnvelope,
        );
      } finally {
        namespaceEnvelope.wrappedDek.fill(0);
      }
    } finally {
      encrypted.dek.fill(0);
      encrypted.payload.ciphertext.fill(0);
    }
    payloadHash = crypto.hash(payloadBytes);
    namespaceEnvelopeHash = crypto.hash(namespaceEnvelopeBytes);
    const manifestInput = {
      objectId: targetObjectId,
      payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [namespaceEnvelopeHash],
      signer: {
        kind: "agent_runtime",
        agentId: signer.runtime.agentId,
        runtimeGeneration: signer.runtime.generation,
        signerKeyId: signer.signerKeyId,
      },
      signerAuthorizationHash: signer.signerAuthorizationHash,
      hostAuthorizationRevision: authorizationRevision(
        signer.hostAuthorizationRevision,
      ),
    } as const;
    const genesis = input.temporarySigner === undefined
      ? createAgentObjectAccessManifestV5(
        crypto,
        manifestInput,
        signer.runtime,
      )
      : createTaskRuntimeObjectAccessManifestV5(crypto, manifestInput, {
        runtime: signer.runtime,
        certificateBytes: input.temporarySigner.certificateBytes,
        issuerSigningPublicKey: input.temporarySigner.issuerSigningPublicKey,
        expectedRequestHash: input.temporarySigner.requestHash,
        expectedAuthorizationHash: input.temporarySigner.authorizationHash,
        now: crypto.clock.now(),
      });
    assertResultEvidence(evidence);
    const authority = cloneAuthority({
      purpose: "persist-task-runtime-result-genesis",
      requestId: evidence.requestId,
      workId: evidence.workId,
      claimId: evidence.claimId,
      authorizationDigest: evidence.authorizationDigest,
      objectId: evidence.result.objectId,
      payloadHash,
      taskId: evidence.result.taskId,
      taskRunId: evidence.result.taskRunId,
      contentRevision: evidence.result.contentRevision,
      namespace: {
        namespaceId: resultNamespace.namespaceId,
        domainId: resultNamespace.domainId,
        expectedAccessRevision: resultNamespace.expectedAccessRevision,
        expectedPolicyRevision: resultNamespace.expectedPolicyRevision,
        bindingHash: namespace.bindingHash,
        keyGeneration: namespaceGeneration(namespace.keyGeneration),
        envelopeHash: namespaceEnvelopeHash,
      },
      domain,
      agentId: signer.runtime.agentId,
      runtimeGeneration: signer.runtime.generation,
      agentAuthorizationRevision: input.agentAuthorizationRevision,
      signerKeyId: signer.signerKeyId,
    });
    const prepared = Object.freeze({
      object: encryptedObjectWriteRecordV2(payloadBytes),
      access: Object.freeze({
        manifest: genesis.manifest,
        manifestBytes: genesis.bytes,
        manifestHash: genesis.hash,
        envelopeBytes: Object.freeze([
          copyOwnedBytesV2(namespaceEnvelopeBytes),
        ] as const),
        authority,
        ...(signer.signerEvidenceBytes === null ? {} : {
          signerEvidenceBytes: signer.signerEvidenceBytes.slice(),
        }),
      }),
    });
    preparedSnapshots.set(prepared, Object.freeze({
      payloadBytes: copyOwnedBytesV2(prepared.object.payloadBytes.ciphertext),
      manifestBytes: copyOwnedBytesV2(prepared.access.manifestBytes),
      manifestHash: copyOwnedBytesV2(prepared.access.manifestHash),
      envelopeBytes: copyOwnedBytesV2(prepared.access.envelopeBytes[0]),
      authorityFingerprint: authorityFingerprint(authority),
      signerEvidenceBytes: signer.signerEvidenceBytes?.slice() ?? null,
    }));
    signer.signerAuthorizationHash?.fill(0);
    signer.signerEvidenceBytes?.fill(0);
    return prepared;
  } finally {
    plaintext.fill(0);
    payloadHash?.fill(0);
    namespaceEnvelopeHash?.fill(0);
    payloadBytes?.fill(0);
    namespaceEnvelopeBytes?.fill(0);
  }
}

export type PrepareNativeTaskRuntimeResultObjectV1Input =
  Omit<PrepareTaskRuntimeResultObjectV1Input, "namespace"> & Readonly<{
    namespace: Omit<Parameters<typeof withOpenedDomainNamespaceBundleV2>[1], "operation" | "expectedBindingDigest"> & Readonly<{
      expectedBindingDigest: Uint8Array;
    }>;
  }>;

/** Native bundle entrypoint sharing the existing Task-result preparation brand. */
export async function prepareNativeTaskRuntimeResultObjectV1(
  crypto: LatticeCrypto,
  input: PrepareNativeTaskRuntimeResultObjectV1Input,
): Promise<PreparedTaskRuntimeResultObjectV1> {
  assertAuthenticTaskRuntimeExecutionEvidenceV1(input.evidence);
  return prepareNativeResultObject(crypto, input);
}

export type PrepareNativeTaskRuntimeCancellationResultObjectV1Input =
  Omit<PrepareNativeTaskRuntimeResultObjectV1Input, "evidence"> & Readonly<{
    evidence: TaskRuntimeCancellationResultEvidenceV1;
  }>;

/** Fresh publication-only custody never becomes Task execution evidence. */
export async function prepareNativeTaskRuntimeCancellationResultObjectV1(
  crypto: LatticeCrypto,
  input: PrepareNativeTaskRuntimeCancellationResultObjectV1Input,
): Promise<PreparedTaskRuntimeResultObjectV1> {
  assertAuthenticTaskRuntimeCancellationResultEvidenceV1(input.evidence);
  return prepareNativeResultObject(crypto, input);
}

async function prepareNativeResultObject(
  crypto: LatticeCrypto,
  input: Omit<PrepareNativeTaskRuntimeResultObjectV1Input, "evidence">
    & Readonly<{ evidence: ResultEvidence }>,
): Promise<PreparedTaskRuntimeResultObjectV1> {
  assertResultEvidence(input.evidence);
  if (!(input.plaintext instanceof Uint8Array)) throw new TypeError("Task result plaintext must be Uint8Array");
  const evidence = input.evidence;
  const target = evidence.result.namespace;
  const domain = matchingDomain(evidence);
  const current = input.namespace.current;
  const requirements = evidence.namespaceRequirements.filter((entry) => entry.namespaceId === target.namespaceId);
  const requirement = requirements[0];
  if (evidence.result.taskRunId !== evidence.workId
    || evidence.policyRevision !== target.expectedPolicyRevision
    || target.operations.length !== 1 || target.operations[0] !== "encrypt"
    || requirements.length !== 1 || requirement === undefined
    || requirement.domainId !== target.domainId
    || requirement.expectedAccessRevision !== target.expectedAccessRevision
    || requirement.expectedPolicyRevision !== target.expectedPolicyRevision
    || !requirement.operations.includes("encrypt")
    || current.namespaceId !== target.namespaceId
    || current.namespaceAccessRevision !== target.expectedAccessRevision
    || current.cryptoDomainId !== target.domainId
    || current.keyClass !== "ai"
    || current.domainKeyGeneration !== domain.domainKeyGeneration
    || current.domainAuthorizationRevision !== domain.authorizationRevision
    || current.participantCount !== domain.participantCount
    || !sameBytes(current.participantDigest, domain.participantDigest)
    || !sameBytes(current.domainHeadDigest, domain.headDigest)
    || input.runtime.agentId !== evidence.result.signerAgentId) {
    throw new TypeError("Native Task result preparation authority was substituted");
  }
  const signer = preparationSigner(crypto, input, evidence);
  signer.signerAuthorizationHash?.fill(0);
  signer.signerEvidenceBytes?.fill(0);
  const plaintext = Uint8Array.from(input.plaintext);
  try {
    const opened = await withOpenedDomainNamespaceBundleV2(crypto, {
      ...input.namespace,
      operation: (retained) => {
        assertResultEvidence(evidence);
        const generation = retained.find((entry) => entry.generation === current.namespaceCurrentGeneration
          && entry.accessRevision === current.namespaceAccessRevision);
        if (generation === undefined) throw new TypeError("Native Task result current Namespace generation is unavailable");
        return sealTaskRuntimeResultWithNamespaceKey(crypto, { ...input, plaintext }, {
          key: generation.generationKey, keyGeneration: generation.generation,
          // Native Task authority identifies the authenticated signed bundle binding.
          bindingHash: input.namespace.expectedBindingDigest,
        });
      },
    });
    if (opened.status !== "opened") throw new TypeError("Native Task result Namespace bundle is unavailable");
    assertResultEvidence(evidence);
    return opened.value;
  } finally { plaintext.fill(0); }
}

export function assertAuthenticPreparedTaskRuntimeResultObjectV1(
  prepared: PreparedTaskRuntimeResultObjectV1,
): void {
  const snapshot = preparedSnapshots.get(prepared as object);
  if (
    snapshot === undefined
    || !sameBytes(snapshot.payloadBytes, prepared.object.payloadBytes.ciphertext)
    || !sameBytes(snapshot.manifestBytes, prepared.access.manifestBytes)
    || !sameBytes(snapshot.manifestHash, prepared.access.manifestHash)
    || !sameBytes(snapshot.envelopeBytes, prepared.access.envelopeBytes[0])
    || (snapshot.signerEvidenceBytes === null)
      !== (prepared.access.signerEvidenceBytes === undefined)
    || (snapshot.signerEvidenceBytes !== null
      && !sameBytes(
        snapshot.signerEvidenceBytes,
        prepared.access.signerEvidenceBytes!,
      ))
    || snapshot.authorityFingerprint
      !== authorityFingerprint(prepared.access.authority)
  ) throw new TypeError(
    "Task result publication requires an authentic prepared object",
  );
}
