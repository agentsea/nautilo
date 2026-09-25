import {
  prepareTaskRuntimeResultObject,
  type LatticeCrypto,
  type PrepareTaskRuntimeResultObjectInput,
  type TaskRuntimeExecutionEvidence,
  type TaskRuntimeResultNamespaceSource,
} from "@nautilo/lattice-crypto";

import type { TaskContentAuthorityV1 } from
  "./task-content-authority-v1.ts";
import {
  createPreparedTaskRuntimeResultContentCryptoRevisionV1,
} from "./task-content-prepared-revision.ts";
import {
  deriveTaskContentCryptoObjectIdV1,
  TASK_RUN_RESULT_OBJECT_TYPE_V1,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskRunResultContentCoordinateV1,
} from "./task-content-repository.ts";
import {
  encodeTaskRunResultPayloadV1,
  type TaskRunResultPayloadV1,
} from "./task-payload-v1.ts";

export type PrepareTaskRuntimeRunResultInput = Readonly<{
  crypto: LatticeCrypto;
  evidence: TaskRuntimeExecutionEvidence;
  payload: TaskRunResultPayloadV1;
  authority: TaskContentAuthorityV1;
  createdAt: number;
  namespace: TaskRuntimeResultNamespaceSource;
  agentAuthorizationRevision: number;
  runtime: PrepareTaskRuntimeResultObjectInput["runtime"];
  signerPublication: PrepareTaskRuntimeResultObjectInput["signerPublication"];
  resolveHistoricalSignerPublicationManager:
    PrepareTaskRuntimeResultObjectInput[
      "resolveHistoricalSignerPublicationManager"
    ];
}>;

/**
 * Canonicalizes and prepares one protected TaskRun result while the Task-owned
 * execution evidence and its opened Domain authority are still live.
 */
export function prepareTaskRuntimeRunResult(
  input: PrepareTaskRuntimeRunResultInput,
): PreparedTaskContentCryptoRevisionV1 {
  const result = input.evidence.result;
  const coordinate: TaskRunResultContentCoordinateV1 = Object.freeze({
    kind: "run_result",
    taskId: result.taskId,
    taskRunId: result.taskRunId,
    contentRevision: result.contentRevision,
  });
  const objectId = deriveTaskContentCryptoObjectIdV1(coordinate);
  if (
    objectId !== result.objectId
    || input.authority.keyClass !== "ai"
    || input.authority.namespaceId !== result.namespace.namespaceId
    || input.authority.domainId !== result.namespace.domainId
    || input.authority.expectedAccessRevision
      !== result.namespace.expectedAccessRevision
    || input.authority.expectedPolicyRevision
      !== result.namespace.expectedPolicyRevision
  ) throw new TypeError("Task Runtime result coordinate or authority disagrees");

  const plaintext = encodeTaskRunResultPayloadV1(input.payload);
  try {
    const prepared = prepareTaskRuntimeResultObject(input.crypto, {
      evidence: input.evidence,
      plaintext,
      objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1,
      createdAt: input.createdAt,
      namespace: input.namespace,
      agentAuthorizationRevision: input.agentAuthorizationRevision,
      runtime: input.runtime,
      signerPublication: input.signerPublication,
      resolveHistoricalSignerPublicationManager:
        input.resolveHistoricalSignerPublicationManager,
    });
    return createPreparedTaskRuntimeResultContentCryptoRevisionV1({
      coordinate,
      authority: input.authority,
      prepared,
    });
  } finally {
    plaintext.fill(0);
  }
}
