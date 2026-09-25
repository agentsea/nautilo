import { createHash } from "node:crypto";

import {
  encodeTaskRunResultPayloadV1,
  prepareTaskRuntimeRunResult,
  type PrepareTaskRuntimeRunResultInput,
} from "@nautilo/lattice-bridge";

import {
  publishProtectedOrDualTaskRunResult,
  type ProtectedTaskRunResultPublicationReceipt,
  type PublishProtectedOrDualTaskRunResultInput,
} from "./protected-task-result-publication";

export type CompleteProtectedTaskRunResultInput = Readonly<
  PrepareTaskRuntimeRunResultInput &
  Pick<
    PublishProtectedOrDualTaskRunResultInput,
    | "repository"
    | "terminal"
    | "dualTerminal"
    | "owner"
    | "reference"
    | "scheduleKind"
    | "completedAt"
  > & { signal: AbortSignal }
>;

export type CompleteProtectedTaskRunResultDependencies = Readonly<{
  prepare: typeof prepareTaskRuntimeRunResult;
  publish: typeof publishProtectedOrDualTaskRunResult;
}>;

const productionDependencies: CompleteProtectedTaskRunResultDependencies =
  Object.freeze({
    prepare: prepareTaskRuntimeRunResult,
    publish: publishProtectedOrDualTaskRunResult,
  });

/**
 * Prepares and publishes one Task result while its Task-owned Runtime grant is
 * live. The repository selects Full or Shadow; neither route enters ordinary
 * Task report-back or writes result text into operational rows.
 */
export async function completeProtectedTaskRunResult(
  input: CompleteProtectedTaskRunResultInput,
  dependencies: CompleteProtectedTaskRunResultDependencies = productionDependencies,
): Promise<ProtectedTaskRunResultPublicationReceipt> {
  input.signal.throwIfAborted();
  const result = input.evidence.result;
  if (
    result.taskId !== input.reference.taskId
    || result.taskRunId !== input.reference.taskRunId
    || result.objectId !== input.reference.resultObjectId
    || input.evidence.requestId !== input.reference.authorizationRequestId
    || input.evidence.policyRevision !== input.reference.policyRevision
    || result.namespace.namespaceId !== input.authority.namespaceId
  ) {
    throw new TypeError("Protected Task result disagrees with its grant");
  }

  const canonical = encodeTaskRunResultPayloadV1(input.payload);
  let requestDigest: Uint8Array;
  try {
    requestDigest = createHash("sha256").update(canonical).digest();
  } finally {
    canonical.fill(0);
  }
  const prepared = dependencies.prepare(input);
  if (prepared.coordinate.kind !== "run_result") {
    throw new TypeError("Protected Task result has no run coordinate");
  }
  input.signal.throwIfAborted();
  return dependencies.publish({
    repository: input.repository,
    terminal: input.terminal,
    dualTerminal: input.dualTerminal,
    owner: input.owner,
    reference: input.reference,
    authority: input.authority,
    prepared,
    requestDigest,
    outcome: input.payload.lastError === null ? "completed" : "errored",
    scheduleKind: input.scheduleKind,
    completedAt: input.completedAt,
    ordinaryContent: Object.freeze({
      coordinate: prepared.coordinate,
      payload: input.payload,
    }),
  });
}
