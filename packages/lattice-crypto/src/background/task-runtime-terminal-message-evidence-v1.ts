import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import type {
  TaskRuntimeExecutionDomainAuthorityV1,
} from "./task-runtime-execution-evidence-v1.ts";

declare const taskRuntimeTerminalMessageEvidenceBrand: unique symbol;

const MESSAGE_OBJECT_ID_DOMAIN_V2 =
  "nautilo/conversation-message-crypto-object/v2";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

export type TaskRuntimeTerminalMessageProofV1 = Readonly<{
  readonly taskId: string;
  readonly taskRunId: string;
  readonly bindingId: string;
  readonly messageOperationId: string;
  readonly sessionId: string;
  readonly messageId: number;
  readonly revision: number;
  readonly objectId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly mode: "shadow_encryption" | "encrypted_only";
  readonly acceptedPolicyRevision: number;
  readonly publicationPolicyRevision: number;
  readonly signerAgentId: string;
  /** Digest of the exact encoded MessagePayloadV2 authorized for publication. */
  readonly payloadDigest: Uint8Array;
}>;

export type TaskRuntimeTerminalMessageEvidenceV1 = Readonly<{
  readonly purpose: "task.runtime.terminal_message";
  readonly workKind: "task.deliver_message";
  readonly requestId: string;
  readonly workId: string;
  readonly claimId: string;
  readonly claimExpiresAt: number;
  readonly recipientExpiresAt: number;
  readonly expiresAt: number;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly authorizationDigest: Uint8Array;
  readonly policyRevision: number;
  readonly episodeId: string;
  readonly sourceRoomId: string;
  readonly hostAuthorizationRevision: number;
  readonly recipientAuthorizationRevision: number;
  readonly operations: readonly ["encrypt"];
  readonly message: TaskRuntimeTerminalMessageProofV1;
  readonly domainRequirements: readonly [TaskRuntimeExecutionDomainAuthorityV1];
  readonly namespaceRequirements: readonly [Readonly<{
    readonly ordinal: 0;
    readonly namespaceId: string;
    readonly domainId: string;
    readonly operations: readonly ["encrypt"];
    readonly expectedAccessRevision: number;
    readonly expectedPolicyRevision: number;
  }>];
  readonly [taskRuntimeTerminalMessageEvidenceBrand]: true;
}>;

type EvidenceInput = Omit<TaskRuntimeTerminalMessageEvidenceV1,
  typeof taskRuntimeTerminalMessageEvidenceBrand>;
type EvidenceState = {
  active: boolean;
  readonly fingerprint: string;
  readonly signal: AbortSignal;
  readonly now: () => number;
};
const states = new WeakMap<object, EvidenceState>();

function expectedObjectId(message: Pick<TaskRuntimeTerminalMessageProofV1,
  "sessionId" | "messageId" | "revision">): string {
  if (!UUID.test(message.sessionId)
    || !Number.isSafeInteger(message.messageId) || message.messageId < 1
    || !Number.isSafeInteger(message.revision) || message.revision < 0) {
    throw new TypeError("Task Runtime terminal Message coordinate is invalid");
  }
  const sessionBytes = encoder.encode(message.sessionId);
  const digest = sha256(encoder.encode(
    `${MESSAGE_OBJECT_ID_DOMAIN_V2}\n${sessionBytes.length}\n${message.sessionId}\n${message.messageId}\n${message.revision}`,
  ));
  try {
    return `message:v2:${bytesToHex(digest)}`;
  } finally {
    digest.fill(0);
  }
}

function cloneEvidence(value: EvidenceInput): TaskRuntimeTerminalMessageEvidenceV1 {
  const message = value.message;
  const namespace = value.namespaceRequirements[0];
  const domain = value.domainRequirements[0];
  for (const [label, id] of [
    ["request ID", value.requestId], ["work ID", value.workId],
    ["claim ID", value.claimId], ["recipient key ID", value.recipientKeyId],
    ["episode ID", value.episodeId], ["source Room ID", value.sourceRoomId],
    ["Task ID", message.taskId], ["Task Run ID", message.taskRunId],
    ["binding ID", message.bindingId], ["Message operation ID", message.messageOperationId],
    ["Message object ID", message.objectId], ["destination Room ID", message.roomId],
    ["destination Namespace ID", message.namespaceId], ["destination Domain ID", message.domainId],
    ["signer Agent ID", message.signerAgentId],
  ] as const) assertPortableId(`Task Runtime terminal Message ${label}`, id);
  for (const [label, counter] of [
    ["claim expiry", value.claimExpiresAt], ["recipient expiry", value.recipientExpiresAt],
    ["expiry", value.expiresAt], ["recipient generation", value.recipientGeneration],
    ["policy revision", value.policyRevision], ["host authorization revision", value.hostAuthorizationRevision],
    ["recipient authorization revision", value.recipientAuthorizationRevision],
    ["Message ID", message.messageId], ["Message revision", message.revision],
    ["accepted policy revision", message.acceptedPolicyRevision],
    ["publication policy revision", message.publicationPolicyRevision],
    ["Namespace access revision", namespace?.expectedAccessRevision ?? -1],
    ["Namespace policy revision", namespace?.expectedPolicyRevision ?? -1],
    ["Domain participant count", domain?.participantCount ?? -1],
    ["Domain key generation", domain?.domainKeyGeneration ?? -1],
    ["Domain authorization revision", domain?.authorizationRevision ?? -1],
    ["Domain active Namespace binding count", domain?.activeNamespaceBindingCount ?? -1],
  ] as const) assertU64Counter(`Task Runtime terminal Message ${label}`, counter);
  if (!UUID.test(message.taskId) || !UUID.test(message.taskRunId)
    || (message.mode !== "shadow_encryption" && message.mode !== "encrypted_only")
    || !UUID.test(message.sessionId) || !UUID.test(message.roomId)
    || value.workKind !== "task.deliver_message"
    || value.workId !== message.taskRunId
    || value.requestId !== `task-run-delivery-message-authorization:${message.taskRunId}`
    || message.bindingId !== `task-run-output:${message.taskRunId}`
    || message.messageOperationId !== `task-run-delivery-message:${message.taskRunId}`
    || message.objectId !== expectedObjectId(message)
    || message.acceptedPolicyRevision < 1
    || message.publicationPolicyRevision < message.acceptedPolicyRevision
    || message.publicationPolicyRevision !== value.policyRevision
    || message.roomId !== value.sourceRoomId
    || value.expiresAt !== Math.min(value.claimExpiresAt, value.recipientExpiresAt)
    || value.operations.length !== 1 || value.operations[0] !== "encrypt"
    || value.namespaceRequirements.length !== 1 || namespace === undefined
    || namespace.ordinal !== 0 || namespace.namespaceId !== message.namespaceId
    || namespace.domainId !== message.domainId
    || namespace.operations.length !== 1 || namespace.operations[0] !== "encrypt"
    || namespace.expectedPolicyRevision !== message.publicationPolicyRevision
    || value.domainRequirements.length !== 1 || domain === undefined
    || domain.keyClass !== "ai" || domain.domainId !== message.domainId
    || domain.sourceNamespaceId !== message.namespaceId) {
    throw new TypeError("Task Runtime terminal Message evidence is invalid");
  }
  if (value.authorizationDigest.length !== 32 || message.payloadDigest.length !== 32
    || domain.participantDigest.length !== 32 || domain.headDigest.length !== 32
    || domain.activeNamespaceBindingSetDigest.length !== 32) {
    throw new RangeError("Task Runtime terminal Message evidence digest is invalid");
  }
  return Object.freeze({
    purpose: "task.runtime.terminal_message",
    workKind: "task.deliver_message",
    requestId: value.requestId,
    workId: value.workId,
    claimId: value.claimId,
    claimExpiresAt: value.claimExpiresAt,
    recipientExpiresAt: value.recipientExpiresAt,
    expiresAt: value.expiresAt,
    recipientGeneration: value.recipientGeneration,
    recipientKeyId: value.recipientKeyId,
    authorizationDigest: value.authorizationDigest.slice(),
    policyRevision: value.policyRevision,
    episodeId: value.episodeId,
    sourceRoomId: value.sourceRoomId,
    hostAuthorizationRevision: value.hostAuthorizationRevision,
    recipientAuthorizationRevision: value.recipientAuthorizationRevision,
    operations: Object.freeze(["encrypt"] as const),
    message: Object.freeze({ ...message, payloadDigest: message.payloadDigest.slice() }),
    domainRequirements: Object.freeze([Object.freeze({
      ...domain,
      participantDigest: domain.participantDigest.slice(),
      headDigest: domain.headDigest.slice(),
      activeNamespaceBindingSetDigest: domain.activeNamespaceBindingSetDigest.slice(),
    })] as const),
    namespaceRequirements: Object.freeze([Object.freeze({
      ...namespace,
      ordinal: 0 as const,
      operations: Object.freeze(["encrypt"] as const),
    })] as const),
  }) as TaskRuntimeTerminalMessageEvidenceV1;
}

function fingerprint(value: TaskRuntimeTerminalMessageEvidenceV1): string {
  return JSON.stringify({
    ...value,
    authorizationDigest: bytesToHex(value.authorizationDigest),
    message: { ...value.message, payloadDigest: bytesToHex(value.message.payloadDigest) },
    domainRequirements: value.domainRequirements.map(entry => ({ ...entry,
      participantDigest: bytesToHex(entry.participantDigest),
      headDigest: bytesToHex(entry.headDigest),
      activeNamespaceBindingSetDigest: bytesToHex(entry.activeNamespaceBindingSetDigest),
    })),
  });
}

export function assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(
  evidence: TaskRuntimeTerminalMessageEvidenceV1,
): void {
  const state = states.get(evidence as object);
  const currentTime = state?.now();
  if (state === undefined || !state.active || state.signal.aborted
    || currentTime === undefined || !Number.isSafeInteger(currentTime)
    || currentTime >= evidence.expiresAt || state.fingerprint !== fingerprint(evidence)) {
    if (state !== undefined) state.active = false;
    throw new TypeError("Task Runtime terminal Message evidence is not active");
  }
}

/** Internal minting seam. The public registry is the sole package entrypoint. */
export async function withTaskRuntimeTerminalMessageEvidenceV1<Value>(input: Readonly<{
  evidence: EvidenceInput;
  signal: AbortSignal;
  now: () => number;
  execute(evidence: TaskRuntimeTerminalMessageEvidenceV1): Value | PromiseLike<Value>;
}>): Promise<Value> {
  const evidence = cloneEvidence(input.evidence);
  const state: EvidenceState = { active: true, fingerprint: fingerprint(evidence),
    signal: input.signal, now: input.now };
  states.set(evidence, state);
  try {
    assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(evidence);
    return await input.execute(evidence);
  } finally {
    state.active = false;
    states.delete(evidence);
  }
}
