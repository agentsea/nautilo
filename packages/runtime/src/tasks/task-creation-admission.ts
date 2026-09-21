import type { DirectDatabase } from "@nautilo/db";
import type { AcceptedInvocationAuthority } from "@nautilo/trust";
import {
  TASK_CONTENT_AUTHORITY_RESOLVER_VERSION_V1,
  encodeTaskPayloadV1,
  resolveTaskContentAuthorityV1,
  type RequesterPrivateNamespaceFactV1,
  type TaskContentAuthorityV1,
  type TaskExecutionDeliveryShapeV1,
  type TaskPayloadV1,
} from "@nautilo/lattice-bridge";
import {
  classifyProtectedTaskMetadataV1,
  type ProtectedTaskMetadataProjectionV1,
} from "@nautilo/types";
import type { TaskCreateInput } from "./create-task";

export type TaskCreationEntrypoint =
  | "foreground.main"
  | "foreground.fork"
  | "foreground.task_report_back"
  | "background.task"
  | "foreground.subagent";

export type TaskCreationProvenance =
  | Readonly<{
      kind: "human_api";
      ownerId: string;
      requestedParentTaskId: string | null;
    }>
  | Readonly<{
      kind: "agent_turn";
      ownerId: string;
      roomId: string | null;
      entrypoint: TaskCreationEntrypoint | null;
      parentTaskId: string | null;
      parentTaskRunId: string | null;
    }>
  | Readonly<{
      kind: "artifact_event";
      ownerId: string;
      artifactId: string;
      roomId: string | null;
    }>;

const recognizedProvenance = new WeakSet<object>();

function recognized<Value extends TaskCreationProvenance>(value: Value): Value {
  recognizedProvenance.add(value);
  return value;
}

function required(label: string, value: string): string {
  if (!value) throw new TypeError(`${label} is required`);
  return value;
}

export function createHumanApiTaskCreationProvenance(input: Readonly<{
  ownerId: string;
  requestedParentTaskId?: string | null;
}>): TaskCreationProvenance {
  return recognized(Object.freeze({
    kind: "human_api" as const,
    ownerId: required("Task creation owner", input.ownerId),
    requestedParentTaskId: input.requestedParentTaskId ?? null,
  }));
}

export function createAgentTurnTaskCreationProvenance(input: Readonly<{
  ownerId: string;
  invocation: Readonly<{
    ownerId: string;
    roomId: string | null;
    entrypoint: TaskCreationEntrypoint;
    taskId?: string;
    taskRunId?: string;
  }> | null;
}>): TaskCreationProvenance {
  const ownerId = required("Task creation owner", input.ownerId);
  if (input.invocation !== null && input.invocation.ownerId !== ownerId) {
    throw new TypeError("Task creation provenance owner mismatch");
  }
  return recognized(Object.freeze({
    kind: "agent_turn" as const,
    ownerId,
    roomId: input.invocation?.roomId ?? null,
    entrypoint: input.invocation?.entrypoint ?? null,
    parentTaskId: input.invocation?.entrypoint === "background.task"
      ? input.invocation.taskId ?? null
      : null,
    parentTaskRunId: input.invocation?.entrypoint === "background.task"
      ? input.invocation.taskRunId ?? null
      : null,
  }));
}

export function createArtifactEventTaskCreationProvenance(input: Readonly<{
  ownerId: string;
  artifactId: string;
  roomId?: string | null;
}>): TaskCreationProvenance {
  return recognized(Object.freeze({
    kind: "artifact_event" as const,
    ownerId: required("Task creation owner", input.ownerId),
    artifactId: required("Task creation Artifact", input.artifactId),
    roomId: input.roomId ?? null,
  }));
}

export function assertTaskCreationProvenance(
  value: TaskCreationProvenance,
  ownerId: string,
): void {
  if (!recognizedProvenance.has(value) || value.ownerId !== ownerId) {
    throw new TypeError("Task creation requires server-authored provenance");
  }
}

export type TaskCreationAdmissionResult<Prepared = never> =
  | Readonly<{ kind: "ordinary"; candidate: TaskCreateInput }>
  | Readonly<{ kind: "protected"; prepared: Prepared }>
  | Readonly<{
      kind: "unavailable";
      reason:
        | "creation_origin_unavailable"
        | "nested_task_unsupported"
        | "content_namespace_unavailable"
        | "execution_namespace_unavailable"
        | "metadata_unsupported"
        | "task_shape_unsupported";
    }>;

export type TaskCreationAdmissionInput = Readonly<{
  db: DirectDatabase;
  candidate: TaskCreateInput;
  provenance: TaskCreationProvenance;
  invocationAuthority: AcceptedInvocationAuthority;
}>;

export interface TaskCreationAdmissionPort<Prepared = never> {
  admit(input: TaskCreationAdmissionInput): Promise<
    TaskCreationAdmissionResult<Prepared>
  >;
}

export type ProtectedTaskExecutionShapeResolutionV1 =
  | Readonly<{
      status: "resolved";
      shape: TaskExecutionDeliveryShapeV1;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "execution_namespace_unavailable" | "task_shape_unsupported";
    }>;

export type ProtectedTaskCreationResolutionInputV1 = Readonly<{
  db: DirectDatabase;
  ownerId: string;
  requestorId: string;
  agentId: string;
  preset: NonNullable<TaskCreateInput["preset"]>;
  callingRoomId: string | null;
  targetChat: NonNullable<TaskCreateInput["targetChat"]>;
  targetChatHandle: string | null;
  targetRoomId: string | null;
  targetUserIds: readonly string[];
  useScope: boolean;
  scopeId: string | null;
  operationalMetadata: ProtectedTaskMetadataProjectionV1;
  provenance: TaskCreationProvenance;
  invocationAuthority: AcceptedInvocationAuthority;
}>;

export interface ProtectedTaskCreationAuthorityPortsV1 {
  /**
   * Read-only product resolution. Implementations must prove the requested
   * Scope/private-wide/multi-user shape without minting or substituting a
   * Namespace.
   */
  resolveExecutionShape(input: ProtectedTaskCreationResolutionInputV1): Promise<
    ProtectedTaskExecutionShapeResolutionV1
  >;
  /** Resolve the exact existing requester-private Namespace and current facts. */
  resolveRequesterPrivateNamespace(
    input: ProtectedTaskCreationResolutionInputV1,
  ): Promise<RequesterPrivateNamespaceFactV1>;
}

export type ProtectedTaskCreationPlanV1 = Readonly<{
  authority: TaskContentAuthorityV1;
  shape: TaskExecutionDeliveryShapeV1;
  payload: TaskPayloadV1;
  operationalMetadata: ProtectedTaskMetadataProjectionV1;
}>;

function isNestedTaskCreation(
  candidate: TaskCreateInput,
  provenance: TaskCreationProvenance,
): boolean {
  if (candidate.parentTaskId != null || (candidate.depth ?? 0) > 0) return true;
  if (provenance.kind === "human_api") {
    return provenance.requestedParentTaskId !== null;
  }
  if (provenance.kind !== "agent_turn") return false;
  return provenance.entrypoint === "background.task"
    || provenance.entrypoint === "foreground.task_report_back"
    || provenance.entrypoint === "foreground.subagent"
    || provenance.parentTaskId !== null
    || provenance.parentTaskRunId !== null;
}

/**
 * Dark protected admission for the first Task-encryption phase. It resolves
 * and classifies a root Task, but `createTask` cannot persist the returned plan
 * until the protected Task repository exists.
 */
export function createProtectedTaskCreationAdmissionV1(
  ports: ProtectedTaskCreationAuthorityPortsV1,
): TaskCreationAdmissionPort<ProtectedTaskCreationPlanV1> {
  return Object.freeze({
    async admit(
      input: TaskCreationAdmissionInput,
    ): Promise<TaskCreationAdmissionResult<ProtectedTaskCreationPlanV1>> {
      const { candidate, provenance } = input;
      if (isNestedTaskCreation(candidate, provenance)) {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: "nested_task_unsupported" as const,
        });
      }
      if (
        provenance.kind === "agent_turn"
        && provenance.entrypoint !== "foreground.main"
        && provenance.entrypoint !== "foreground.fork"
      ) {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: "creation_origin_unavailable" as const,
        });
      }
      // Artifact-backed Task input remains gated until Artifact protection is
      // available; accepting it here would persist a protected Task whose
      // source content still depends on an ordinary Artifact route.
      if (provenance.kind === "artifact_event") {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: "task_shape_unsupported" as const,
        });
      }
      if (
        candidate.ownerId !== candidate.requestorId
        || candidate.lastError != null
      ) {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: "task_shape_unsupported" as const,
        });
      }

      const metadata = classifyProtectedTaskMetadataV1(candidate.metadata ?? {});
      if (metadata.status === "unsupported") {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: "metadata_unsupported" as const,
        });
      }
      if (
        Object.hasOwn(metadata.protectedContent, "artifactRefs")
        || Object.hasOwn(metadata.protectedContent, "artifactOperationId")
        || Object.hasOwn(metadata.protectedContent, "artifactId")
      ) {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: "task_shape_unsupported" as const,
        });
      }
      const resolutionInput = Object.freeze({
        db: input.db,
        ownerId: candidate.ownerId,
        requestorId: candidate.requestorId,
        agentId: candidate.agentId,
        preset: candidate.preset ?? "task",
        callingRoomId: candidate.callingRoomId ?? null,
        targetChat: candidate.targetChat ?? "orphan",
        targetChatHandle: candidate.targetChatHandle ?? null,
        targetRoomId: candidate.targetRoomId ?? null,
        targetUserIds: Object.freeze([...(candidate.targetUserIds ?? [])]),
        useScope: candidate.useScope ?? false,
        scopeId: candidate.scopeId ?? null,
        operationalMetadata: metadata.operational,
        provenance,
        invocationAuthority: input.invocationAuthority,
      });
      const shape = await ports.resolveExecutionShape(resolutionInput);
      if (shape.status === "unavailable") {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: shape.reason,
        });
      }
      const requesterPrivateNamespace =
        await ports.resolveRequesterPrivateNamespace(resolutionInput);
      const authority = resolveTaskContentAuthorityV1({
        resolverVersion: TASK_CONTENT_AUTHORITY_RESOLVER_VERSION_V1,
        requesterHumanId: candidate.requestorId,
        requesterPrivateNamespace,
        shape: shape.shape,
      });
      if (authority.status === "unavailable") {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: "content_namespace_unavailable" as const,
        });
      }
      const payload = Object.freeze({
        formatVersion: 1 as const,
        prompt: candidate.prompt,
        expectedOutput: candidate.expectedOutput ?? null,
        protectedMetadata: metadata.protectedContent,
      });
      try {
        const validation = encodeTaskPayloadV1(payload);
        validation.fill(0);
      } catch {
        return Object.freeze({
          kind: "unavailable" as const,
          reason: "task_shape_unsupported" as const,
        });
      }
      return Object.freeze({
        kind: "protected" as const,
        prepared: Object.freeze({
          authority: authority.authority,
          shape: shape.shape,
          payload,
          operationalMetadata: metadata.operational,
        }),
      });
    },
  });
}

const plaintextTaskCreationAdmission: TaskCreationAdmissionPort = Object.freeze({
  admit(input: TaskCreationAdmissionInput) {
    return Promise.resolve(Object.freeze({
      kind: "ordinary" as const,
      candidate: input.candidate,
    }));
  },
});

/** Plain's inert admission port. It returns the exact candidate reference. */
export function getPlaintextTaskCreationAdmission(): TaskCreationAdmissionPort {
  return plaintextTaskCreationAdmission;
}

export class TaskCreationUnavailableError extends Error {
  override readonly name = "TaskCreationUnavailableError";

  constructor(readonly reason: Exclude<
    TaskCreationAdmissionResult,
    { kind: "ordinary" | "protected" }
  >["reason"]) {
    super(`Task creation unavailable (${reason})`);
  }
}
