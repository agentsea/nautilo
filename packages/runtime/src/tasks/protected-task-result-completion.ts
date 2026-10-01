import {
  prepareTaskRuntimeRunResult,
  taskRuntimePreparedResultDigestV1,
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

export type PublishPreparedProtectedTaskRunResultInput = Readonly<
  Omit<
    PublishProtectedOrDualTaskRunResultInput,
    "requestDigest" | "outcome"
  > & {
    evidence: PrepareTaskRuntimeRunResultInput["evidence"];
    signal: AbortSignal;
  }
>;

export type PublishPreparedProtectedTaskRunResultDependencies = Readonly<{
  digestPrepared: typeof taskRuntimePreparedResultDigestV1;
  publish: typeof publishProtectedOrDualTaskRunResult;
}>;

export type CompleteProtectedTaskRunResultDependencies = Readonly<{
  prepare: typeof prepareTaskRuntimeRunResult;
}> & PublishPreparedProtectedTaskRunResultDependencies;

const productionDependencies: CompleteProtectedTaskRunResultDependencies =
  Object.freeze({
    prepare: prepareTaskRuntimeRunResult,
    digestPrepared: taskRuntimePreparedResultDigestV1,
    publish: publishProtectedOrDualTaskRunResult,
  });

function assertExactGrant(input: Readonly<{
  evidence: PrepareTaskRuntimeRunResultInput["evidence"];
  authority: PrepareTaskRuntimeRunResultInput["authority"];
  reference: PublishProtectedOrDualTaskRunResultInput["reference"];
}>): void {
  const { evidence, authority, reference } = input;
  const result = evidence.result;
  const namespace = result.namespace;
  if (
    result.taskId !== reference.taskId
    || result.taskRunId !== reference.taskRunId
    || result.taskRunId !== evidence.workId
    || result.objectId !== reference.resultObjectId
    || evidence.requestId !== reference.authorizationRequestId
    || evidence.policyRevision !== reference.policyRevision
    || namespace.namespaceId !== authority.namespaceId
    || namespace.domainId !== authority.domainId
    || namespace.expectedAccessRevision !== authority.expectedAccessRevision
    || namespace.expectedPolicyRevision !== authority.expectedPolicyRevision
    || namespace.expectedPolicyRevision !== evidence.policyRevision
  ) {
    throw new TypeError("Protected Task result disagrees with its grant");
  }
}

/**
 * Publishes one already-prepared native or legacy Task result while its exact
 * Task-owned Runtime evidence remains live. Preparation stays with the crypto
 * owner; this boundary derives the durable request digest and terminal outcome.
 */
export async function publishPreparedProtectedTaskRunResult(
  input: PublishPreparedProtectedTaskRunResultInput,
  dependencies: PublishPreparedProtectedTaskRunResultDependencies =
    productionDependencies,
): Promise<ProtectedTaskRunResultPublicationReceipt> {
  input.signal.throwIfAborted();
  assertExactGrant(input);
  const result = input.evidence.result;
  const preparedCoordinate = input.prepared.coordinate;
  const ordinaryCoordinate = input.ordinaryContent.coordinate;
  if (
    preparedCoordinate.kind !== "run_result"
    || preparedCoordinate.taskId !== result.taskId
    || preparedCoordinate.taskRunId !== result.taskRunId
    || preparedCoordinate.contentRevision !== result.contentRevision
    || input.prepared.objectId !== result.objectId
    || ordinaryCoordinate.kind !== "run_result"
    || ordinaryCoordinate.taskId !== preparedCoordinate.taskId
    || ordinaryCoordinate.taskRunId !== preparedCoordinate.taskRunId
    || ordinaryCoordinate.contentRevision !== preparedCoordinate.contentRevision
  ) {
    throw new TypeError("Prepared protected Task result coordinates disagree");
  }
  const requestDigest = dependencies.digestPrepared(input.prepared);
  input.signal.throwIfAborted();
  return dependencies.publish({
    repository: input.repository,
    terminal: input.terminal,
    dualTerminal: input.dualTerminal,
    owner: input.owner,
    reference: input.reference,
    authority: input.authority,
    prepared: input.prepared,
    requestDigest,
    outcome: input.ordinaryContent.payload.lastError === null
      ? "completed"
      : "errored",
    scheduleKind: input.scheduleKind,
    completedAt: input.completedAt,
    ordinaryContent: input.ordinaryContent,
  });
}

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
  assertExactGrant(input);

  const prepared = dependencies.prepare(input);
  if (prepared.coordinate.kind !== "run_result") {
    throw new TypeError("Protected Task result has no run coordinate");
  }
  return publishPreparedProtectedTaskRunResult({
    repository: input.repository,
    terminal: input.terminal,
    dualTerminal: input.dualTerminal,
    owner: input.owner,
    reference: input.reference,
    authority: input.authority,
    prepared,
    evidence: input.evidence,
    signal: input.signal,
    scheduleKind: input.scheduleKind,
    completedAt: input.completedAt,
    ordinaryContent: Object.freeze({
      coordinate: prepared.coordinate,
      payload: input.payload,
    }),
  }, dependencies);
}
