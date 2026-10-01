import {
  ClassifiedDataOperationError,
  decodeTaskRunResultPayloadV1,
  deriveTaskContentCryptoObjectIdV1,
  encodeTaskRunResultPayloadV1,
  sameTaskContentCoordinateV1,
  type TaskContentPayloadV1,
  type TaskContentReadPortsV1,
  type TaskRunResultPayloadV1,
} from "@nautilo/lattice-bridge";

export type ProtectedTaskRunResultInspectionSnapshot = Readonly<{
  task: Readonly<{
    id: string;
    ownerId: string;
    requestorId: string;
    agentId: string;
    contentRepresentation: "ordinary" | "dual" | "protected";
    contentNamespaceId: string | null;
    contentRevision: number;
    cryptoObjectId: string | null;
    cryptoAccessRevision: number;
    cryptoRequiredNamespaceFingerprint: Uint8Array | null;
    cryptoMappingState: string;
  }>;
  run: Readonly<{
    id: string;
    taskId: string;
    status: string;
    resultRepresentation: "ordinary" | "dual" | "protected";
    resultContentNamespaceId: string | null;
    resultRevision: number;
    resultCryptoObjectId: string | null;
    resultCryptoAccessRevision: number;
    resultCryptoRequiredNamespaceFingerprint: Uint8Array | null;
    resultCryptoMappingState: string;
  }>;
}>;

export type ProtectedTaskRunResultInspection =
  | Readonly<{
      status: "ready";
      section: "result";
      taskId: string;
      taskRunId: string;
      payload: TaskRunResultPayloadV1;
    }>
  | Readonly<{
      status: "waiting";
      section: "result";
      reason: "result_not_mapped" | "authority_not_ready";
    }>
  | Readonly<{
      status: "unavailable";
      section: "result";
      reason:
        | "task_not_found"
        | "result_not_protected"
        | "authority_changed"
        | "unsupported_crypto_access_revision"
        | "integrity_failure";
    }>;

export type ProtectedTaskRunResultInspectionPorts = Readonly<{
  /** Must resolve the exact owner-visible Task and TaskRun from current state. */
  inspectCurrent(input: Readonly<{
    ownerId: string;
    agentId: string;
    taskId: string;
    taskRunId: string;
  }>): Promise<ProtectedTaskRunResultInspectionSnapshot | null>;
  /** Exact protected-object opener. The ordinary sibling is never supplied. */
  openProtected: TaskContentReadPortsV1["readProtected"];
}>;

type InspectionRequest = Readonly<{
  ownerId: string;
  agentId: string;
  taskId: string;
  taskRunId: string;
}>;

const waiting = (
  reason: Extract<ProtectedTaskRunResultInspection, { status: "waiting" }>["reason"],
): ProtectedTaskRunResultInspection => Object.freeze({
  status: "waiting" as const,
  section: "result" as const,
  reason,
});

const unavailable = (
  reason: Extract<ProtectedTaskRunResultInspection, { status: "unavailable" }>["reason"],
): ProtectedTaskRunResultInspection => Object.freeze({
  status: "unavailable" as const,
  section: "result" as const,
  reason,
});

function sameSnapshot(
  left: ProtectedTaskRunResultInspectionSnapshot,
  right: ProtectedTaskRunResultInspectionSnapshot,
): boolean {
  return left.task.id === right.task.id
    && left.task.ownerId === right.task.ownerId
    && left.task.requestorId === right.task.requestorId
    && left.task.agentId === right.task.agentId
    && left.task.contentRepresentation === right.task.contentRepresentation
    && left.task.contentNamespaceId === right.task.contentNamespaceId
    && left.task.contentRevision === right.task.contentRevision
    && left.task.cryptoObjectId === right.task.cryptoObjectId
    && left.task.cryptoAccessRevision === right.task.cryptoAccessRevision
    && sameNullableBytes(
      left.task.cryptoRequiredNamespaceFingerprint,
      right.task.cryptoRequiredNamespaceFingerprint,
    )
    && left.task.cryptoMappingState === right.task.cryptoMappingState
    && left.run.id === right.run.id
    && left.run.taskId === right.run.taskId
    && left.run.status === right.run.status
    && left.run.resultRepresentation === right.run.resultRepresentation
    && left.run.resultContentNamespaceId === right.run.resultContentNamespaceId
    && left.run.resultRevision === right.run.resultRevision
    && left.run.resultCryptoObjectId === right.run.resultCryptoObjectId
    && left.run.resultCryptoAccessRevision
      === right.run.resultCryptoAccessRevision
    && sameNullableBytes(
      left.run.resultCryptoRequiredNamespaceFingerprint,
      right.run.resultCryptoRequiredNamespaceFingerprint,
    )
    && left.run.resultCryptoMappingState === right.run.resultCryptoMappingState;
}

function sameNullableBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.length === right.length
      && left.every((value, index) => value === right[index]);
}

function ownedSnapshot(
  value: ProtectedTaskRunResultInspectionSnapshot,
): ProtectedTaskRunResultInspectionSnapshot {
  return Object.freeze({
    task: Object.freeze({
      ...value.task,
      cryptoRequiredNamespaceFingerprint:
        value.task.cryptoRequiredNamespaceFingerprint?.slice() ?? null,
    }),
    run: Object.freeze({
      ...value.run,
      resultCryptoRequiredNamespaceFingerprint:
        value.run.resultCryptoRequiredNamespaceFingerprint?.slice() ?? null,
    }),
  });
}

function belongsToRequest(
  request: InspectionRequest,
  snapshot: ProtectedTaskRunResultInspectionSnapshot,
): boolean {
  return snapshot.task.id === request.taskId
    && snapshot.task.ownerId === request.ownerId
    && snapshot.task.requestorId === request.ownerId
    && snapshot.task.agentId === request.agentId
    && snapshot.run.id === request.taskRunId
    && snapshot.run.taskId === request.taskId;
}

function canonicalResult(
  expected: Readonly<{
    kind: "run_result";
    taskId: string;
    taskRunId: string;
    contentRevision: number;
  }>,
  content: TaskContentPayloadV1,
): TaskRunResultPayloadV1 | null {
  if (content.coordinate.kind !== "run_result"
    || !sameTaskContentCoordinateV1(expected, content.coordinate)) return null;
  try {
    return decodeTaskRunResultPayloadV1(encodeTaskRunResultPayloadV1(
      content.payload as TaskRunResultPayloadV1,
    ));
  } catch {
    return null;
  }
}

/**
 * Dark protected-only result inspection. It checks the exact owner, Agent and
 * current TaskRun before and after opening the protected object. Dual rows are
 * also opened through their protected representation; this adapter has no
 * ordinary read port and persists no decrypted content.
 */
export function createProtectedTaskRunResultInspectionAdapter(
  ports: ProtectedTaskRunResultInspectionPorts,
) {
  return async (
    request: InspectionRequest,
  ): Promise<ProtectedTaskRunResultInspection> => {
    const inspected = await ports.inspectCurrent(request);
    if (inspected === null || !belongsToRequest(request, inspected)) {
      return unavailable("task_not_found");
    }
    const before = ownedSnapshot(inspected);
    if ((before.task.contentRepresentation !== "protected"
        && before.task.contentRepresentation !== "dual")
      || before.task.contentNamespaceId === null) {
      return unavailable("result_not_protected");
    }
    if (before.task.cryptoMappingState !== "verified") {
      return unavailable("authority_changed");
    }

    const pristine = before.run.resultRepresentation === "ordinary"
      && before.run.resultContentNamespaceId === null
      && before.run.resultRevision === 0
      && before.run.resultCryptoObjectId === null
      && before.run.resultCryptoAccessRevision === 0
      && before.run.resultCryptoRequiredNamespaceFingerprint === null
      && before.run.resultCryptoMappingState === "unmapped";
    if (pristine) {
      return before.run.status === "completed"
          || before.run.status === "errored"
          || before.run.status === "cancelled"
        ? unavailable("result_not_protected")
        : waiting("result_not_mapped");
    }
    if (before.run.resultCryptoAccessRevision !== 0) {
      return unavailable("unsupported_crypto_access_revision");
    }

    const coordinate = Object.freeze({
      kind: "run_result" as const,
      taskId: request.taskId,
      taskRunId: request.taskRunId,
      contentRevision: 1,
    });
    let expectedObjectId: string;
    let expectedDefinitionObjectId: string;
    try {
      expectedObjectId = deriveTaskContentCryptoObjectIdV1(coordinate);
      expectedDefinitionObjectId = deriveTaskContentCryptoObjectIdV1({
        kind: "definition",
        taskId: request.taskId,
        contentRevision: before.task.contentRevision,
      });
    } catch {
      return unavailable("integrity_failure");
    }
    if (before.task.contentRevision < 1
      || before.task.cryptoObjectId !== expectedDefinitionObjectId
      || before.task.cryptoAccessRevision < 0
      || before.task.cryptoRequiredNamespaceFingerprint?.length !== 32
      || (before.run.resultRepresentation !== "protected"
        && before.run.resultRepresentation !== "dual")
      || before.run.resultRepresentation !== before.task.contentRepresentation
      || before.run.resultContentNamespaceId
        !== before.task.contentNamespaceId
      || before.run.resultRevision !== coordinate.contentRevision
      || before.run.resultCryptoObjectId !== expectedObjectId
      || before.run.resultCryptoRequiredNamespaceFingerprint?.length !== 32
      || !sameNullableBytes(
        before.task.cryptoRequiredNamespaceFingerprint,
        before.run.resultCryptoRequiredNamespaceFingerprint,
      )
      || before.run.resultCryptoMappingState !== "verified"
      || (before.run.status !== "completed"
        && before.run.status !== "errored")) {
      return unavailable("integrity_failure");
    }

    let opened: TaskContentPayloadV1;
    try {
      opened = await ports.openProtected(coordinate);
    } catch (error) {
      if (!(error instanceof ClassifiedDataOperationError)) throw error;
      if (error.failureClass === "key_waiting") {
        return waiting("authority_not_ready");
      }
      return unavailable(error.failureClass === "integrity"
        ? "integrity_failure"
        : error.failureClass === "unsupported"
        ? "result_not_protected"
        : "authority_changed");
    }
    const payload = canonicalResult(coordinate, opened);
    if (payload === null) return unavailable("integrity_failure");

    const inspectedAfter = await ports.inspectCurrent(request);
    if (inspectedAfter === null
      || !belongsToRequest(request, inspectedAfter)
      || !sameSnapshot(before, ownedSnapshot(inspectedAfter))) {
      return unavailable("authority_changed");
    }
    return Object.freeze({
      status: "ready" as const,
      section: "result" as const,
      taskId: request.taskId,
      taskRunId: request.taskRunId,
      payload,
    });
  };
}
