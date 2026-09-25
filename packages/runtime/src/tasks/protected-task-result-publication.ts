import {
  ClassifiedDataOperationError,
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  TASK_RUN_RESULT_OBJECT_TYPE_V1,
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityV1,
  sameTaskContentCoordinateV1,
  type EncryptionDataOperationOwner,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentAuthorityV1,
  type TaskRunResultContentCoordinateV1,
} from "@nautilo/lattice-bridge";
import type {
  DurableTaskContentRepositoryV1,
} from "@nautilo/lattice-bridge/server";

import {
  assertProtectedTaskJobReferenceV1,
  type ProtectedTaskJobReferenceV1,
} from "./protected-task-job-reference";

const RESULT_REVISION = 1 as const;

export type ProtectedTaskRunResultOutcome = "completed" | "errored";

export type ProtectedTaskRunTerminalRejection =
  | "authority_changed"
  | "conflict"
  | "not_found"
  | "not_running"
  | "run_terminal"
  | "task_terminal";

export type ProtectedTaskRunTerminalResult =
  | Readonly<{ status: "transitioned" | "exact_replay" }>
  | Readonly<{
      status: "rejected";
      reason: ProtectedTaskRunTerminalRejection;
    }>;

/**
 * Content-free terminal product write performed between result reservation and
 * protected crypto completion. Implementations own the Task/TaskRun CAS and
 * must return `exact_replay` only after verifying the existing result ledger
 * operation ID, digest, coordinate, and object. A same-terminal TaskRun status
 * by itself is not an exact replay receipt.
 */
export interface ProtectedTaskRunTerminalPort {
  terminalize(input: Readonly<{
    taskId: string;
    taskRunId: string;
    /** Verify the persisted Task schedule and its matching live status. */
    scheduleKind: "now" | "one_shot" | "cron";
    operationId: string;
    requestDigest: Uint8Array;
    resultObjectId: string;
    resultRevision: typeof RESULT_REVISION;
    resultRepresentation: "protected";
    outcome: ProtectedTaskRunResultOutcome;
    completedAt: Date;
    /** The exact run must be running even while a cron parent stays pending. */
    requiredRunStatus: "running";
    policyRevalidationToken: number;
  }>): Promise<ProtectedTaskRunTerminalResult>;
}

export type ProtectedTaskRunResultPublicationReceipt = Readonly<{
  status: "mapped" | "replayed";
  taskId: string;
  taskRunId: string;
  resultObjectId: string;
  resultRevision: typeof RESULT_REVISION;
}>;

type ProtectedTaskRunResultRepository = Pick<
  DurableTaskContentRepositoryV1<ProtectedTaskRunTerminalResult>,
  "publishPrepared"
>;

export type PublishProtectedTaskRunResultInput = Readonly<{
  repository: ProtectedTaskRunResultRepository;
  terminal: ProtectedTaskRunTerminalPort;
  owner: EncryptionDataOperationOwner;
  reference: ProtectedTaskJobReferenceV1;
  authority: TaskContentAuthorityV1;
  prepared: PreparedTaskContentCryptoRevisionV1;
  requestDigest: Uint8Array;
  outcome: ProtectedTaskRunResultOutcome;
  scheduleKind: "now" | "one_shot" | "cron";
  completedAt: Date;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function operationId(taskRunId: string): string {
  return `task-run-result:${taskRunId}`;
}

function validate(input: PublishProtectedTaskRunResultInput): Readonly<{
  coordinate: TaskRunResultContentCoordinateV1;
  operationId: string;
  requestDigest: Uint8Array;
  resultObjectId: string;
  authority: TaskContentAuthorityV1;
  outcome: ProtectedTaskRunResultOutcome;
  scheduleKind: "now" | "one_shot" | "cron";
  completedAt: Date;
}> {
  assertProtectedTaskJobReferenceV1(input.reference);
  const coordinate = input.prepared.coordinate;
  if (
    coordinate.kind !== "run_result"
    || coordinate.taskId !== input.reference.taskId
    || coordinate.taskRunId !== input.reference.taskRunId
    || coordinate.contentRevision !== RESULT_REVISION
  ) {
    throw new TypeError(
      "Prepared protected Task result disagrees with its exact Task run",
    );
  }
  const expectedObjectId = deriveTaskContentCryptoObjectIdV1(coordinate);
  if (
    input.prepared.objectId !== expectedObjectId
    || input.reference.resultObjectId !== expectedObjectId
    || input.prepared.objectType !== TASK_RUN_RESULT_OBJECT_TYPE_V1
    || input.prepared.payloadVersion !== TASK_CONTENT_PAYLOAD_VERSION_V1
    || input.prepared.namespaceId !== input.authority.namespaceId
    || input.reference.policyRevision !== input.authority.expectedPolicyRevision
    || !sameBytes(
      input.prepared.authorityFingerprint,
      fingerprintTaskContentAuthorityV1(input.authority),
    )
  ) {
    throw new TypeError(
      "Prepared protected Task result authority or object identity disagrees",
    );
  }
  if (
    !(input.requestDigest instanceof Uint8Array)
    || input.requestDigest.length !== 32
  ) {
    throw new TypeError("Protected Task result request digest is invalid");
  }
  if (
    !(input.completedAt instanceof Date)
    || !Number.isFinite(input.completedAt.getTime())
  ) {
    throw new TypeError("Protected Task result completion time is invalid");
  }
  if (input.outcome !== "completed" && input.outcome !== "errored") {
    throw new TypeError("Protected Task result outcome is invalid");
  }
  if (
    input.scheduleKind !== "now"
    && input.scheduleKind !== "one_shot"
    && input.scheduleKind !== "cron"
  ) {
    throw new TypeError("Protected Task result schedule is invalid");
  }
  return Object.freeze({
    coordinate: Object.freeze({ ...coordinate }),
    operationId: operationId(coordinate.taskRunId),
    requestDigest: input.requestDigest.slice(),
    resultObjectId: input.prepared.objectId,
    authority: Object.freeze({ ...input.authority }),
    outcome: input.outcome,
    scheduleKind: input.scheduleKind,
    completedAt: new Date(input.completedAt.getTime()),
  });
}

function terminalRejection(
  result: ProtectedTaskRunTerminalResult,
): never {
  const failureClass = result.status === "rejected"
    && result.reason === "conflict"
    ? "integrity"
    : "stale";
  throw new ClassifiedDataOperationError(
    failureClass,
    "Protected Task result lost its terminal lifecycle CAS",
  );
}

/**
 * Publishes one canonical protected TaskRun result. Plaintext result/error
 * content is absent from this boundary: the caller supplies only an opaque,
 * already-prepared crypto revision and closed terminal facts. The selected
 * policy must be encrypted-only; this owner exposes no ordinary or dual plan.
 */
export async function publishProtectedTaskRunResult(
  input: PublishProtectedTaskRunResultInput,
): Promise<ProtectedTaskRunResultPublicationReceipt> {
  const exact = validate(input);
  const publication = await input.repository.publishPrepared({
    representation: "protected",
    owner: input.owner,
    operationId: exact.operationId,
    requestDigest: exact.requestDigest,
    authority: exact.authority,
    operationalMetadata: null,
    prepared: input.prepared,
    publishProduct: async (context) => {
      const terminal = await input.terminal.terminalize(Object.freeze({
        taskId: exact.coordinate.taskId,
        taskRunId: exact.coordinate.taskRunId,
        scheduleKind: exact.scheduleKind,
        operationId: exact.operationId,
        requestDigest: exact.requestDigest.slice(),
        resultObjectId: exact.resultObjectId,
        resultRevision: RESULT_REVISION,
        resultRepresentation: "protected",
        outcome: exact.outcome,
        completedAt: new Date(exact.completedAt.getTime()),
        requiredRunStatus: "running",
        policyRevalidationToken: context.revalidationToken,
      }));
      if (
        terminal.status !== "transitioned"
        && terminal.status !== "exact_replay"
      ) terminalRejection(terminal);
      return terminal;
    },
  });
  const revision = publication.protectedRevision;
  if (
    publication.representation !== "protected"
    || revision === null
    || revision.status === "orphaned"
    || !sameTaskContentCoordinateV1(revision.coordinate, exact.coordinate)
    || revision.cryptoObjectId !== exact.resultObjectId
  ) {
    throw new ClassifiedDataOperationError(
      "integrity",
      "Protected Task result publication did not map its exact revision",
    );
  }
  return Object.freeze({
    status: revision.status,
    taskId: exact.coordinate.taskId,
    taskRunId: exact.coordinate.taskRunId,
    resultObjectId: revision.cryptoObjectId,
    resultRevision: RESULT_REVISION,
  });
}
