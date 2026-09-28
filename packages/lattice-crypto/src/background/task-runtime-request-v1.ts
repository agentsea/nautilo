import {
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES_V2,
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationPlanV2,
  type DomainForegroundAuthorizationPlanV2,
} from "../format/domain-foreground-authorization-v2.ts";
import {
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V1 =
  1 as const;
export const TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1 =
  "task.runtime.background_authorization_request" as const;
export type TaskRuntimeBackgroundAuthorizationWorkV1 =
  | "task.dispatch"
  | "task.execute";

const REQUEST_DOMAIN =
  "nautilo/lattice-crypto/task-runtime-background-authorization-request/v1";
const TASK_RUNTIME_PRINCIPAL = "nautilo_task_runtime";

const framedTextBytes = (value: string): number => 4 + utf8V2(value).length;
const REQUEST_DOMAIN_BYTES = utf8V2(REQUEST_DOMAIN).length;
const REQUEST_PURPOSE_BYTES = utf8V2(
  TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1,
).length;
const MAX_TASK_WORK_BYTES = utf8V2("task.dispatch").length;
const MAX_ID_FRAME_BYTES = 4 + V2_LIMITS.idBytes;
const FIXED_AND_BOUNDED_REQUEST_BYTES =
  framedTextBytes(REQUEST_DOMAIN)
  + 4
  + framedTextBytes(TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1)
  + MAX_ID_FRAME_BYTES // requestId
  + MAX_ID_FRAME_BYTES // TaskRun workId
  + framedTextBytes("task.dispatch")
  + framedTextBytes("task.dispatch")
  + 8
  + MAX_ID_FRAME_BYTES // episodeId
  + MAX_ID_FRAME_BYTES // sourceRoomId
  + MAX_ID_FRAME_BYTES // recipientKeyId
  + 4 + V2_LIMITS.hpkePublicKeyBytes
  + 4 // authorizationPlanBytes frame
  + 8
  + 8;

export const MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1 =
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES_V2
  + FIXED_AND_BOUNDED_REQUEST_BYTES;

export interface TaskRuntimeBackgroundAuthorizationRequestV1 {
  readonly formatVersion:
    typeof TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V1;
  readonly purpose:
    typeof TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1;
  readonly requestId: string;
  readonly workId: string;
  readonly workKind: TaskRuntimeBackgroundAuthorizationWorkV1;
  readonly workPurpose: TaskRuntimeBackgroundAuthorizationWorkV1;
  readonly recipientGeneration: number;
  readonly episodeId: string;
  readonly sourceRoomId: string;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly authorizationPlanBytes: Uint8Array;
  readonly issuedAt: number;
  readonly deadlineAt: number;
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function counter(label: string, value: unknown): number {
  assertU64Counter(label, value);
  return value;
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function taskWork(
  label: string,
  value: unknown,
): TaskRuntimeBackgroundAuthorizationWorkV1 {
  if (value !== "task.dispatch" && value !== "task.execute") {
    throw new TypeError(`${label} is unsupported`);
  }
  return value;
}

function assertPlanBindings(
  value: TaskRuntimeBackgroundAuthorizationRequestV1,
  plan: DomainForegroundAuthorizationPlanV2,
): void {
  if (
    plan.authorizationId !== value.requestId
    || plan.sessionId !== value.episodeId
    || plan.roomId !== value.sourceRoomId
    || plan.recipientKind !== "runtime"
    || plan.recipientPrincipalId !== TASK_RUNTIME_PRINCIPAL
    || plan.recipientRuntimeGeneration !== value.recipientGeneration
    || plan.recipientKeyId !== value.recipientKeyId
    || plan.issuedAt !== value.issuedAt
    || plan.deadlineAt !== value.deadlineAt
  ) {
    throw new TypeError("Task Runtime request disagrees with its authorization plan");
  }
}

function normalize(
  value: TaskRuntimeBackgroundAuthorizationRequestV1,
): TaskRuntimeBackgroundAuthorizationRequestV1 {
  if (
    value.formatVersion
      !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V1
    || value.purpose
      !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1
  ) throw new TypeError("Task Runtime request version or purpose is unsupported");

  const workKind = taskWork("Task Runtime work kind", value.workKind);
  const workPurpose = taskWork("Task Runtime work purpose", value.workPurpose);
  if (workKind !== workPurpose) {
    throw new TypeError("Task Runtime work kind and purpose disagree");
  }

  const recipientPublicKey = exactBytes(
    "Task Runtime recipient public key",
    value.recipientPublicKey,
    V2_LIMITS.hpkePublicKeyBytes,
  );
  const authorizationPlanBytes = copyOwnedBytesV2(value.authorizationPlanBytes);
  let plan: DomainForegroundAuthorizationPlanV2 | null = null;
  try {
    if (
      authorizationPlanBytes.length < 1
      || authorizationPlanBytes.length
        > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES_V2
    ) throw new RangeError("Task Runtime authorization plan exceeds its bound");
    plan = parseDomainForegroundAuthorizationPlanV2(authorizationPlanBytes);
    if (plan === null) {
      throw new TypeError("Task Runtime authorization plan is invalid");
    }
    const normalized = Object.freeze({
      formatVersion:
        TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V1,
      purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1,
      requestId: portable("Task Runtime request ID", value.requestId),
      workId: portable("Task Runtime work ID", value.workId),
      workKind,
      workPurpose,
      recipientGeneration: counter(
        "Task Runtime recipient generation",
        value.recipientGeneration,
      ),
      episodeId: portable("Task Runtime episode ID", value.episodeId),
      sourceRoomId: portable("Task Runtime source Room ID", value.sourceRoomId),
      recipientKeyId: portable(
        "Task Runtime recipient key ID",
        value.recipientKeyId,
      ),
      recipientPublicKey,
      authorizationPlanBytes,
      issuedAt: counter("Task Runtime request issued time", value.issuedAt),
      deadlineAt: counter("Task Runtime request deadline", value.deadlineAt),
    });
    assertPlanBindings(normalized, plan);
    return normalized;
  } catch (error) {
    recipientPublicKey.fill(0);
    authorizationPlanBytes.fill(0);
    throw error;
  } finally {
    if (plan !== null) destroyDomainForegroundAuthorizationPlanV2(plan);
  }
}

function requestBytes(
  value: TaskRuntimeBackgroundAuthorizationRequestV1,
): Uint8Array {
  return concatV2(
    frameText(REQUEST_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.requestId),
    frameText(value.workId),
    frameText(value.workKind),
    frameText(value.workPurpose),
    encodeU64(value.recipientGeneration),
    frameText(value.episodeId),
    frameText(value.sourceRoomId),
    frameText(value.recipientKeyId),
    frame(value.recipientPublicKey),
    frame(value.authorizationPlanBytes),
    encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
  );
}

export function encodeTaskRuntimeBackgroundAuthorizationRequestV1(
  value: TaskRuntimeBackgroundAuthorizationRequestV1,
): Uint8Array {
  const normalized = normalize(value);
  try {
    const encoded = requestBytes(normalized);
    if (
      encoded.length
        > MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1
    ) {
      encoded.fill(0);
      throw new RangeError("Task Runtime request exceeds its wire bound");
    }
    return encoded;
  } finally {
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(normalized);
  }
}

export function decodeTaskRuntimeBackgroundAuthorizationRequestV1(
  encoded: Uint8Array,
): TaskRuntimeBackgroundAuthorizationRequestV1 | null {
  if (
    !(encoded instanceof Uint8Array)
    || encoded.length < 1
    || encoded.length
      > MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1
  ) return null;

  let value: TaskRuntimeBackgroundAuthorizationRequestV1 | null = null;
  try {
    value = decodeExact(encoded, (reader) => {
      if (reader.readText(REQUEST_DOMAIN_BYTES) !== REQUEST_DOMAIN) {
        throw new TypeError("Task Runtime request domain is invalid");
      }
      reader.readVersion(
        TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V1,
      );
      if (
        reader.readText(REQUEST_PURPOSE_BYTES)
          !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1
      ) throw new TypeError("Task Runtime request purpose is invalid");
      const requestId = reader.readText(V2_LIMITS.idBytes);
      const workId = reader.readText(V2_LIMITS.idBytes);
      const workKind = reader.readText(MAX_TASK_WORK_BYTES);
      const workPurpose = reader.readText(MAX_TASK_WORK_BYTES);
      const recipientGeneration = reader.readU64();
      const episodeId = reader.readText(V2_LIMITS.idBytes);
      const sourceRoomId = reader.readText(V2_LIMITS.idBytes);
      const recipientKeyId = reader.readText(V2_LIMITS.idBytes);
      const recipientPublicKey = reader.readFrame(V2_LIMITS.hpkePublicKeyBytes);
      const authorizationPlanBytes = reader.readFrame(
        DOMAIN_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES_V2,
      );
      const issuedAt = reader.readU64();
      const deadlineAt = reader.readU64();
      try {
        return normalize({
          formatVersion:
            TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V1,
          purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1,
          requestId,
          workId,
          workKind: workKind as TaskRuntimeBackgroundAuthorizationWorkV1,
          workPurpose: workPurpose as TaskRuntimeBackgroundAuthorizationWorkV1,
          recipientGeneration,
          episodeId,
          sourceRoomId,
          recipientKeyId,
          recipientPublicKey,
          authorizationPlanBytes,
          issuedAt,
          deadlineAt,
        });
      } finally {
        recipientPublicKey.fill(0);
        authorizationPlanBytes.fill(0);
      }
    });
    const canonical = requestBytes(value);
    const valid = same(canonical, encoded);
    canonical.fill(0);
    if (!valid) {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(value);
      value = null;
    }
    return value;
  } catch {
    if (value !== null) destroyTaskRuntimeBackgroundAuthorizationRequestV1(value);
    return null;
  }
}

export function destroyTaskRuntimeBackgroundAuthorizationRequestV1(
  value: TaskRuntimeBackgroundAuthorizationRequestV1,
): void {
  value.recipientPublicKey.fill(0);
  value.authorizationPlanBytes.fill(0);
}

export function createTaskRuntimeBackgroundAuthorizationRequestV1(
  input: Omit<
    TaskRuntimeBackgroundAuthorizationRequestV1,
    "formatVersion" | "purpose" | "authorizationPlanBytes"
  > & Readonly<{ authorizationPlan: DomainForegroundAuthorizationPlanV2 }>,
): TaskRuntimeBackgroundAuthorizationRequestV1 {
  const authorizationPlanBytes = serializeDomainForegroundAuthorizationPlanV2(
    input.authorizationPlan,
  );
  try {
    return normalize({
      ...input,
      formatVersion:
        TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V1,
      purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V1,
      authorizationPlanBytes,
    });
  } finally {
    authorizationPlanBytes.fill(0);
  }
}
