import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import type { TaskRuntimeExecutionDomainAuthorityV1 } from "./task-runtime-execution-evidence-v1.ts";

declare const runResultReadBrand: unique symbol;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type TaskRuntimeRunResultReadProofV1 = Readonly<{
  taskId: string;
  taskRunId: string;
  terminalStatus: "completed" | "errored" | "cancelled";
  contentRevision: 1 | 2;
  objectId: string;
  cryptoAccessRevision: number;
  genesisManifestHash: Uint8Array;
  signerAgentId: string;
  namespace: Readonly<{
    namespaceId: string;
    domainId: string;
    operations: readonly ["decrypt"];
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
  }>;
}>;

export type TaskRuntimeRunResultReadInvocationV1 = Readonly<{
  bindingId: string;
  operationId: string;
  roomId: string;
  sessionId: string;
}> & (Readonly<{ kind: "raw" }> | Readonly<{
  kind: "wake";
  jobId: string;
  reference: Readonly<{
    kind: "protected_task_delivery_v1";
    taskId: string;
    taskRunId: string;
    bindingId: string;
    resultObjectId: string;
    wakeOperationId: string;
  }>;
}>);

export type TaskRuntimeRunResultMessageWriteProofV1 = Readonly<{
  taskId: string;
  taskRunId: string;
  bindingId: string;
  messageOperationId: string;
  roomId: string;
  sessionId: string;
  signerAgentId: string;
  namespace: Readonly<{
    namespaceId: string;
    domainId: string;
    operations: readonly ["encrypt"];
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
  }>;
  domain: TaskRuntimeExecutionDomainAuthorityV1;
}>;

export type TaskRuntimeRunResultReadEvidenceV1 = Readonly<{
  purpose: "task.runtime.run_result_read";
  workKind: "task.deliver_result" | "task.delivery_wake";
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
  operations: readonly ["decrypt"];
  result: TaskRuntimeRunResultReadProofV1;
  invocation: TaskRuntimeRunResultReadInvocationV1;
  resultDomain: TaskRuntimeExecutionDomainAuthorityV1;
  messageWrite: TaskRuntimeRunResultMessageWriteProofV1 | null;
  readonly [runResultReadBrand]: true;
}>;

export type TaskRuntimeRunResultReadEvidenceInputV1 =
  Omit<TaskRuntimeRunResultReadEvidenceV1, typeof runResultReadBrand>;
const states = new WeakMap<object, Readonly<{
  fingerprint: string; signal: AbortSignal; now(): number;
}>>();

function digest(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError("Task result read digest is invalid");
  }
  // Buffer.slice() aliases its parent. Evidence owns and may later lend/wipe
  // these snapshots, so always materialize an independent Uint8Array.
  return Uint8Array.from(value);
}

/** Internal validation shared with the registry before secret custody is opened. */
export function snapshotTaskRuntimeRunResultReadEvidenceV1(
  value: TaskRuntimeRunResultReadEvidenceInputV1,
): TaskRuntimeRunResultReadEvidenceV1 {
  const r = value.result;
  const n = r.namespace;
  const d = value.resultDomain;
  const write = value.messageWrite;
  const invoke = value.invocation;
  for (const id of [value.requestId, value.workId, value.claimId, value.recipientKeyId,
    value.requesterHumanId, value.episodeId, value.sourceRoomId, r.taskId, r.taskRunId,
    r.objectId, r.signerAgentId, n.namespaceId, n.domainId, d.domainId,
    d.sourceNamespaceId, invoke.bindingId, invoke.operationId, invoke.roomId, invoke.sessionId]) {
    assertPortableId("Task result read identity", id);
  }
  for (const counter of [value.claimExpiresAt, value.recipientExpiresAt, value.authorizationExpiresAt, value.expiresAt,
    value.recipientGeneration, value.policyRevision, value.hostAuthorizationRevision,
    value.recipientAuthorizationRevision, n.expectedAccessRevision, n.expectedPolicyRevision,
    d.participantCount, d.domainKeyGeneration, d.authorizationRevision,
    d.activeNamespaceBindingCount, r.cryptoAccessRevision]) assertU64Counter("Task result read counter", counter);
  if (write !== null) {
    for (const id of [write.taskId, write.taskRunId, write.bindingId,
      write.messageOperationId, write.roomId, write.sessionId,
      write.signerAgentId, write.namespace.namespaceId,
      write.namespace.domainId, write.domain.domainId,
      write.domain.sourceNamespaceId]) {
      assertPortableId("Task result Message write identity", id);
    }
    for (const counter of [write.namespace.expectedAccessRevision,
      write.namespace.expectedPolicyRevision, write.domain.participantCount,
      write.domain.domainKeyGeneration, write.domain.authorizationRevision,
      write.domain.activeNamespaceBindingCount]) {
      assertU64Counter("Task result Message write counter", counter);
    }
  }
  const expectedObject = `task-run-result:v1:${bytesToHex(sha256(new TextEncoder().encode(
    `nautilo/task-run-result-crypto-object/v1\n${r.taskId}\n${r.taskRunId}\n${r.contentRevision}`,
  )))}`;
  if (value.purpose !== "task.runtime.run_result_read"
    || !UUID.test(r.taskId) || !UUID.test(r.taskRunId)
    || r.objectId !== expectedObject
    || (r.terminalStatus === "cancelled" ? r.contentRevision !== 2
      : (r.terminalStatus !== "completed" && r.terminalStatus !== "errored") || r.contentRevision !== 1)
    || invoke.bindingId !== `task-run-output:${r.taskRunId}`
    || invoke.roomId !== value.sourceRoomId || invoke.sessionId !== value.episodeId
    || value.expiresAt !== Math.min(value.claimExpiresAt, value.recipientExpiresAt, value.authorizationExpiresAt)
    || value.operations.length !== 1 || value.operations[0] !== "decrypt"
    || n.operations.length !== 1 || n.operations[0] !== "decrypt"
    || n.expectedPolicyRevision !== value.policyRevision
    || d.domainId !== n.domainId || d.keyClass !== "ai") {
    throw new TypeError("Task result read authority was substituted");
  }
  if (invoke.kind === "raw") {
    if (value.workKind !== "task.deliver_result" || value.workId !== r.taskRunId
      || value.requestId !== `task-run-delivery-result-authorization:${r.taskRunId}`
      || invoke.operationId !== `task-run-delivery-message:${r.taskRunId}`
      || (r.contentRevision === 1) !== (write !== null)
      || (write !== null && (write.taskId !== r.taskId
        || write.taskRunId !== r.taskRunId
        || write.bindingId !== invoke.bindingId
        || write.messageOperationId !== invoke.operationId
        || write.roomId !== invoke.roomId
        || write.sessionId !== invoke.sessionId
        || write.signerAgentId !== r.signerAgentId
        || write.namespace.operations.length !== 1
        || write.namespace.operations[0] !== "encrypt"
        || write.namespace.expectedPolicyRevision !== value.policyRevision
        || write.domain.domainId !== write.namespace.domainId
        || write.domain.keyClass !== "ai"))) {
      throw new TypeError("Task result raw delivery identity was substituted");
    }
  } else if (invoke.kind === "wake") {
    const ref = invoke.reference;
    if (!UUID.test(invoke.jobId) || value.workKind !== "task.delivery_wake"
      || value.workId !== invoke.jobId || value.requestId !== `task-wake-authorization:${invoke.jobId}`
      || invoke.operationId !== `task-run-delivery-wake:${r.taskRunId}`
      || Reflect.ownKeys(ref).length !== 6
      || Object.keys(ref).sort().join(",") !== "bindingId,kind,resultObjectId,taskId,taskRunId,wakeOperationId"
      || ref.kind !== "protected_task_delivery_v1" || ref.taskId !== r.taskId
      || ref.taskRunId !== r.taskRunId || ref.bindingId !== invoke.bindingId
      || ref.resultObjectId !== r.objectId || ref.wakeOperationId !== invoke.operationId
      || write !== null) {
      throw new TypeError("Task result wake identity was substituted");
    }
  } else throw new TypeError("Task result invocation is unsupported");
  return Object.freeze({ ...value,
    authorizationDigest: digest(value.authorizationDigest),
    operations: Object.freeze(["decrypt"] as const),
    result: Object.freeze({ ...r, genesisManifestHash: digest(r.genesisManifestHash),
      namespace: Object.freeze({ ...n, operations: Object.freeze(["decrypt"] as const) }) }),
    invocation: Object.freeze(invoke.kind === "raw" ? { ...invoke }
      : { ...invoke, reference: Object.freeze({ ...invoke.reference }) }),
    resultDomain: Object.freeze({ ...d, participantDigest: digest(d.participantDigest),
      headDigest: digest(d.headDigest), activeNamespaceBindingSetDigest: digest(d.activeNamespaceBindingSetDigest) }),
    messageWrite: write === null ? null : Object.freeze({ ...write,
      namespace: Object.freeze({ ...write.namespace, operations: Object.freeze(["encrypt"] as const) }),
      domain: Object.freeze({ ...write.domain,
        participantDigest: digest(write.domain.participantDigest),
        headDigest: digest(write.domain.headDigest),
        activeNamespaceBindingSetDigest: digest(write.domain.activeNamespaceBindingSetDigest),
      }),
    }),
  }) as TaskRuntimeRunResultReadEvidenceV1;
}

function fingerprint(evidence: TaskRuntimeRunResultReadEvidenceV1): string {
  return JSON.stringify(evidence, (_key, value: unknown) =>
    value instanceof Uint8Array ? bytesToHex(value) : value);
}

export function assertAuthenticTaskRuntimeRunResultReadEvidenceV1(
  evidence: TaskRuntimeRunResultReadEvidenceV1,
): void {
  const state = states.get(evidence as object);
  const now = state?.now();
  if (state === undefined || state.signal.aborted || now === undefined
    || !Number.isSafeInteger(now) || now >= evidence.expiresAt
    || state.fingerprint !== fingerprint(evidence)) {
    if (state !== undefined) states.delete(evidence);
    throw new TypeError("Task result read evidence is not active");
  }
}

/** Internal minting seam; only the registry exports an acquisition API. */
export async function withTaskRuntimeRunResultReadEvidenceV1<Value>(input: Readonly<{
  evidence: TaskRuntimeRunResultReadEvidenceInputV1;
  signal: AbortSignal;
  now(): number;
  execute(evidence: TaskRuntimeRunResultReadEvidenceV1): Value | PromiseLike<Value>;
}>): Promise<Value> {
  const evidence = snapshotTaskRuntimeRunResultReadEvidenceV1(input.evidence);
  states.set(evidence, { fingerprint: fingerprint(evidence), signal: input.signal, now: input.now });
  try {
    assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence);
    const result = await input.execute(evidence);
    assertAuthenticTaskRuntimeRunResultReadEvidenceV1(evidence);
    return result;
  } finally { states.delete(evidence); }
}
