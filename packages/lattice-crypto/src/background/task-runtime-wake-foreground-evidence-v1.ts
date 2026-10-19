import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import type {
  TaskRuntimeExecutionDomainAuthorityV1,
  TaskRuntimeExecutionNamespaceAuthorityV1,
} from "./task-runtime-execution-evidence-v1.ts";
import {
  assertAuthenticTaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadInvocationV1,
} from "./task-runtime-run-result-read-evidence-v1.ts";

const wakeForegroundBrand: unique symbol = Symbol("TaskRuntimeWakeForegroundEvidenceV1");

export type TaskRuntimeWakeMutationDestinationV1 = Readonly<{
  roomId: string;
  semanticDigest: string;
  namespace: TaskRuntimeExecutionNamespaceAuthorityV1;
}>;

export type TaskRuntimeWakeForegroundEvidenceV1 = Readonly<{
  purpose: "task.runtime.wake_foreground";
  workKind: "task.delivery_wake";
  requestId: string;
  workId: string;
  claimId: string;
  claimExpiresAt: number;
  recipientExpiresAt: number;
  authorizationExpiresAt: number;
  expiresAt: number;
  recipientGeneration: number;
  recipientKeyId: string;
  authorizationDigest: Uint8Array;
  requesterHumanId: string;
  policyRevision: number;
  episodeId: string;
  sourceRoomId: string;
  hostAuthorizationRevision: number;
  recipientAuthorizationRevision: number;
  committerDeviceId: string;
  committerDeviceSigningGeneration: number;
  committerDeviceSigningPublicKeyHash: Uint8Array;
  /** Attribution for the HIVE signer, never individual Agent grant membership. */
  signerAgentId: string;
  sourceContentRevision: 1 | 2;
  invocation: Extract<TaskRuntimeRunResultReadInvocationV1, { kind: "wake" }>;
  operations: readonly ["decrypt", "encrypt"];
  namespaceRequirements: readonly TaskRuntimeExecutionNamespaceAuthorityV1[];
  additionalMutationDestination?: TaskRuntimeWakeMutationDestinationV1;
  domainRequirements: readonly TaskRuntimeExecutionDomainAuthorityV1[];
  readonly [wakeForegroundBrand]: true;
}>;

type State = Readonly<{
  fingerprint: string;
  readEvidence: TaskRuntimeRunResultReadEvidenceV1;
}>;
const states = new WeakMap<object, State>();

function bytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError("Task wake foreground digest is invalid");
  }
  return Uint8Array.from(value);
}

function stableWakeJobId(taskRunId: string): string {
  const digest = sha256(new TextEncoder().encode(`nautilo/protected-task-run-wake-job/v1\n${taskRunId}`)).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(digest);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fingerprint(evidence: TaskRuntimeWakeForegroundEvidenceV1): string {
  return JSON.stringify(evidence, (_key, value: unknown) =>
    value instanceof Uint8Array ? bytesToHex(value) : value);
}

export function assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(
  evidence: TaskRuntimeWakeForegroundEvidenceV1,
): void {
  const state = states.get(evidence as object);
  try {
    if (state === undefined || state.fingerprint !== fingerprint(evidence)) {
      throw new TypeError("Task wake foreground evidence is not active");
    }
    // The parent owns the actual grant deadline, abort and callback lifetime.
    assertAuthenticTaskRuntimeRunResultReadEvidenceV1(state.readEvidence);
  } catch {
    states.delete(evidence as object);
    throw new TypeError("Task wake foreground evidence is not active");
  }
}

/** Internal registry-only mint; a result-read capability alone has no foreground authority. */
export async function withTaskRuntimeWakeForegroundEvidenceV1<Value>(input: Readonly<{
  readEvidence: TaskRuntimeRunResultReadEvidenceV1;
  committerDeviceId: string;
  committerDeviceSigningGeneration: number;
  committerDeviceSigningPublicKeyHash: Uint8Array;
  namespaceRequirements: readonly TaskRuntimeExecutionNamespaceAuthorityV1[];
  additionalMutationDestination?: TaskRuntimeWakeMutationDestinationV1;
  domainRequirements: readonly TaskRuntimeExecutionDomainAuthorityV1[];
  execute(evidence: TaskRuntimeWakeForegroundEvidenceV1): Value | PromiseLike<Value>;
}>): Promise<Value> {
  const read = input.readEvidence;
  assertAuthenticTaskRuntimeRunResultReadEvidenceV1(read);
  if (read.workKind !== "task.delivery_wake" || read.invocation.kind !== "wake"
    || read.invocation.jobId !== stableWakeJobId(read.result.taskRunId)
    || input.namespaceRequirements.length === 0 || input.domainRequirements.length === 0) {
    throw new TypeError("Task wake foreground authority is invalid");
  }
  assertPortableId("Task wake committer Device", input.committerDeviceId);
  assertU64Counter("Task wake Device signing generation", input.committerDeviceSigningGeneration);
  const domains = input.domainRequirements.map(domain => {
    assertPortableId("Task wake Domain", domain.domainId);
    assertPortableId("Task wake Domain source Namespace", domain.sourceNamespaceId);
    for (const counter of [domain.participantCount, domain.domainKeyGeneration,
      domain.authorizationRevision, domain.activeNamespaceBindingCount]) {
      assertU64Counter("Task wake Domain counter", counter);
    }
    if (domain.keyClass !== "ai") throw new TypeError("Task wake Domain key class is invalid");
    return Object.freeze({ domainId: domain.domainId, sourceNamespaceId: domain.sourceNamespaceId,
      keyClass: "ai" as const, participantCount: domain.participantCount,
      domainKeyGeneration: domain.domainKeyGeneration, authorizationRevision: domain.authorizationRevision,
      activeNamespaceBindingCount: domain.activeNamespaceBindingCount, participantDigest: bytes(domain.participantDigest),
      headDigest: bytes(domain.headDigest), activeNamespaceBindingSetDigest: bytes(domain.activeNamespaceBindingSetDigest) });
  });
  const additional = input.additionalMutationDestination;
  const mutation = additional === undefined ? undefined : Object.freeze({
    roomId: additional.roomId, semanticDigest: additional.semanticDigest,
    namespace: Object.freeze({ ...additional.namespace,
      operations: Object.freeze([...additional.namespace.operations]) }),
  });
  if (mutation !== undefined) {
    assertPortableId("Task wake mutation Room", mutation.roomId);
    assertPortableId("Task wake mutation Namespace", mutation.namespace.namespaceId);
    assertPortableId("Task wake mutation Domain", mutation.namespace.domainId);
    for (const counter of [mutation.namespace.ordinal, mutation.namespace.expectedAccessRevision,
      mutation.namespace.expectedPolicyRevision]) assertU64Counter("Task wake mutation counter", counter);
    if (!/^[0-9a-f]{64}$/u.test(mutation.semanticDigest)
      || mutation.namespace.namespaceId === read.result.namespace.namespaceId
      || input.namespaceRequirements.some(n => n.namespaceId === mutation.namespace.namespaceId
        || n.ordinal === mutation.namespace.ordinal)
      || mutation.namespace.operations.length !== 1 || mutation.namespace.operations[0] !== "encrypt"
      || mutation.namespace.expectedPolicyRevision !== read.policyRevision
      || !domains.some(d => d.domainId === mutation.namespace.domainId)) {
      throw new TypeError("Task wake mutation authority is invalid");
    }
  }
  const namespaces = input.namespaceRequirements.map((namespace, index, all) => {
    assertPortableId("Task wake Namespace", namespace.namespaceId);
    assertPortableId("Task wake Namespace Domain", namespace.domainId);
    for (const counter of [namespace.ordinal, namespace.expectedAccessRevision, namespace.expectedPolicyRevision]) {
      assertU64Counter("Task wake Namespace counter", counter);
    }
    if (namespace.operations.length !== 2 || namespace.operations[0] !== "decrypt" || namespace.operations[1] !== "encrypt"
      || namespace.expectedPolicyRevision !== read.policyRevision
      || index > 0 && (all[index - 1]!.ordinal >= namespace.ordinal
        || all[index - 1]!.namespaceId >= namespace.namespaceId)
      || !domains.some(domain => domain.domainId === namespace.domainId)) {
      throw new TypeError("Task wake foreground Namespace authority is invalid");
    }
    return Object.freeze({ ordinal: namespace.ordinal, namespaceId: namespace.namespaceId,
      domainId: namespace.domainId, expectedAccessRevision: namespace.expectedAccessRevision,
      expectedPolicyRevision: namespace.expectedPolicyRevision,
      operations: Object.freeze(["decrypt", "encrypt"] as const) });
  });
  if (new Set(domains.map(domain => domain.domainId)).size !== domains.length
    || domains.some(domain => !namespaces.some(namespace => namespace.domainId === domain.domainId)
      && mutation?.namespace.domainId !== domain.domainId)) {
    throw new TypeError("Task wake foreground Domain coverage is invalid");
  }
  const evidence: TaskRuntimeWakeForegroundEvidenceV1 = Object.freeze({
    [wakeForegroundBrand]: true as const,
    purpose: "task.runtime.wake_foreground" as const, workKind: "task.delivery_wake" as const,
    requestId: read.requestId, workId: read.workId, claimId: read.claimId,
    claimExpiresAt: read.claimExpiresAt, recipientExpiresAt: read.recipientExpiresAt,
    authorizationExpiresAt: read.authorizationExpiresAt, expiresAt: read.expiresAt,
    recipientGeneration: read.recipientGeneration, recipientKeyId: read.recipientKeyId,
    authorizationDigest: bytes(read.authorizationDigest), requesterHumanId: read.requesterHumanId,
    policyRevision: read.policyRevision, episodeId: read.episodeId, sourceRoomId: read.sourceRoomId,
    hostAuthorizationRevision: read.hostAuthorizationRevision,
    recipientAuthorizationRevision: read.recipientAuthorizationRevision,
    committerDeviceId: input.committerDeviceId,
    committerDeviceSigningGeneration: input.committerDeviceSigningGeneration,
    committerDeviceSigningPublicKeyHash: bytes(input.committerDeviceSigningPublicKeyHash),
    signerAgentId: read.result.signerAgentId,
    sourceContentRevision: read.result.contentRevision,
    invocation: Object.freeze({ ...read.invocation, reference: Object.freeze({ ...read.invocation.reference }) }),
    operations: Object.freeze(["decrypt", "encrypt"] as const),
    ...(mutation === undefined ? {} : { additionalMutationDestination: mutation }),
    namespaceRequirements: Object.freeze(namespaces), domainRequirements: Object.freeze(domains),
  });
  states.set(evidence, { fingerprint: fingerprint(evidence), readEvidence: read });
  try {
    assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(evidence);
    const result = await input.execute(evidence);
    assertAuthenticTaskRuntimeWakeForegroundEvidenceV1(evidence);
    return result;
  } finally { states.delete(evidence); }
}
