import {
  and,
  eq,
  taskRuns,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import type {
  TaskContentAuthorityV1,
  TaskContentCoordinateV1,
} from "@nautilo/lattice-bridge";
import type {
  ConversationProductCanonicalTransactionRunner,
  TaskRuntimeAuthoritySubject,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskOccurrence,
} from "@nautilo/runtime";

import { getServerDirectDb } from "../lib/server-direct-db";
import { createProtectedTaskResultContentAuthorityResolver } from "./protected-task-result-content-authority";
import {
  createCurrentProtectedTaskRuntimeAuthorityPort,
  type CurrentProtectedTaskRuntimeAuthorityPort,
  type HeldProtectedTaskRuntimeAuthority,
} from "./task-runtime-current-authority";

type RunResultCoordinate = Extract<
  TaskContentCoordinateV1,
  { kind: "run_result" }
>;

type ExpectedTaskResultAuthority = Readonly<{
  requesterHumanId: string;
  namespaceId: string;
}>;

type TaskResultAuthorityResolver = (
  expected: ExpectedTaskResultAuthority,
) => Promise<TaskContentAuthorityV1 | null>;

type TaskResultPhase = "running" | "terminal" | "unavailable";

export type ProtectedTaskResultPhaseAuthorityInput = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  subject: TaskRuntimeAuthoritySubject;
  runner: ConversationProductCanonicalTransactionRunner;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  coordinate: RunResultCoordinate;
  now(): number;
  signal?: AbortSignal;
}>;

export type ProtectedTaskResultPhaseAuthorityDependencies = Readonly<{
  db: DirectDatabase;
  readPhase(taskId: string, taskRunId: string): Promise<TaskResultPhase>;
  withCurrentAuthority: CurrentProtectedTaskRuntimeAuthorityPort;
  createTerminalResolver(
    coordinate: RunResultCoordinate,
  ): TaskResultAuthorityResolver;
}>;

function exactAcceptedCoordinates(
  input: ProtectedTaskResultPhaseAuthorityInput,
): boolean {
  const { coordinate, occurrence, record, request, subject } = input;
  const recipient = record.snapshot.recipient;
  const accepted = record.snapshot.acceptedResponse;
  return (
    coordinate.kind === "run_result" &&
    coordinate.taskId === occurrence.task.id &&
    coordinate.taskRunId === occurrence.run.id &&
    coordinate.contentRevision === 1 &&
    occurrence.run.taskId === occurrence.task.id &&
    subject.userId === occurrence.task.requestorId &&
    subject.humanActorId.length > 0 &&
    subject.deviceId.length > 0 &&
    record.snapshot.formatVersion === 3 &&
    record.snapshot.credentialSubject.kind === "runtime" &&
    record.snapshot.credentialSubject.runtimeKind === "task" &&
    record.snapshot.credentialSubject.runtimeVersion === 1 &&
    record.snapshot.workId === occurrence.run.id &&
    record.snapshot.namespaceId === occurrence.task.contentNamespaceId &&
    record.workKind === "task.execute" &&
    record.purpose === "task.execute" &&
    record.descriptorBytes !== null &&
    record.snapshot.descriptorDigest !== null &&
    recipient !== null &&
    accepted !== null &&
    accepted.kind === "runtime" &&
    record.acceptedMaterial !== null &&
    request.formatVersion === 1 &&
    request.purpose ===
      TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1 &&
    request.requestId === record.snapshot.requestId &&
    request.workId === occurrence.run.id &&
    request.workKind === "task.execute" &&
    request.workPurpose === "task.execute" &&
    request.recipientGeneration === record.snapshot.recipientGeneration &&
    request.recipientGeneration === accepted.recipientGeneration &&
    request.recipientKeyId === recipient.recipientKeyId &&
    request.recipientKeyId.length > 0 &&
    request.sourceRoomId.length > 0 &&
    accepted.issuingHumanId === subject.humanActorId &&
    accepted.issuingDeviceId === subject.deviceId
  );
}

function runningAuthority(
  current: HeldProtectedTaskRuntimeAuthority,
  input: ProtectedTaskResultPhaseAuthorityInput,
  expected: ExpectedTaskResultAuthority,
): TaskContentAuthorityV1 | null {
  if (
    expected.requesterHumanId !== input.subject.humanActorId ||
    expected.namespaceId !== input.occurrence.task.contentNamespaceId ||
    current.foreground.subjectHumanId !== expected.requesterHumanId ||
    current.foreground.policyRevision !== input.record.expectedPolicyRevision ||
    current.foreground.recipientKind !== "runtime" ||
    current.foreground.recipientPrincipalId !== "nautilo_task_runtime"
  ) {
    return null;
  }
  const requirements = current.namespaceRequirements.filter(
    (requirement) => requirement.namespaceId === expected.namespaceId,
  );
  const requirement = requirements[0];
  if (
    requirements.length !== 1 ||
    requirement === undefined ||
    !requirement.operations.includes("encrypt") ||
    requirement.expectedPolicyRevision !== current.foreground.policyRevision ||
    !Number.isSafeInteger(requirement.expectedAccessRevision) ||
    requirement.expectedAccessRevision < 0
  )
    return null;
  const domains = current.foreground.domains.filter(
    (domain) => domain.domainId === requirement.domainId,
  );
  const domain = domains[0];
  if (domains.length !== 1 || domain === undefined || domain.keyClass !== "ai")
    return null;
  return Object.freeze({
    authorityVersion: 1,
    kind: "requester_private_namespace",
    keyClass: "ai",
    requesterHumanId: expected.requesterHumanId,
    namespaceId: requirement.namespaceId,
    domainId: domain.domainId,
    expectedAccessRevision: requirement.expectedAccessRevision,
    expectedPolicyRevision: requirement.expectedPolicyRevision,
  });
}

/**
 * Dark phase router for protected Task result repository authority. The phase
 * selects exactly one authority owner; a failed running proof never falls back
 * to terminal authority.
 */
export function createProtectedTaskResultPhaseAuthorityResolver(
  input: ProtectedTaskResultPhaseAuthorityInput,
  overrides: Partial<ProtectedTaskResultPhaseAuthorityDependencies> = {},
): TaskResultAuthorityResolver {
  if (!exactAcceptedCoordinates(input)) {
    throw new TypeError(
      "Protected Task result authority coordinates are invalid",
    );
  }
  const db = overrides.db ?? getServerDirectDb();
  const readPhase =
    overrides.readPhase ??
    (async (taskId, taskRunId) => {
      const rows = await db
        .select({ status: taskRuns.status })
        .from(taskRuns)
        .where(and(eq(taskRuns.id, taskRunId), eq(taskRuns.taskId, taskId)))
        .limit(2);
      if (rows.length !== 1) return "unavailable";
      const status = rows[0]!.status;
      return status === "running"
        ? "running"
        : status === "completed" || status === "errored"
          ? "terminal"
          : "unavailable";
    });
  const withCurrentAuthority =
    overrides.withCurrentAuthority ??
    createCurrentProtectedTaskRuntimeAuthorityPort();
  const createTerminalResolver =
    overrides.createTerminalResolver ??
    ((coordinate) =>
      createProtectedTaskResultContentAuthorityResolver(coordinate));

  return async (expected) => {
    input.signal?.throwIfAborted();
    const phase = await readPhase(
      input.coordinate.taskId,
      input.coordinate.taskRunId,
    );
    if (phase === "running") {
      return withCurrentAuthority({
        runner: input.runner,
        restricted: input.restricted,
        crypto: input.crypto,
        serverScope: input.serverScope,
        subject: input.subject,
        occurrence: input.occurrence,
        record: input.record,
        request: input.request,
        now: input.now,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        use: (current) => runningAuthority(current, input, expected),
      });
    }
    if (phase === "terminal") {
      const authority = await createTerminalResolver(input.coordinate)(
        expected,
      );
      input.signal?.throwIfAborted();
      return authority;
    }
    return null;
  };
}
