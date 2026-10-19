import type { LatticeCrypto } from "../crypto/index.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
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
import type { BackgroundAuthorizationIssuerV2 } from "./processor-authorization-v2.ts";
import type { TaskRuntimeExecutionNamespaceAuthorityV1 } from
  "./task-runtime-execution-evidence-v1.ts";
import {
  destroyTaskRuntimeRequestAuthorityV2,
  encodeTaskRuntimeRequestAuthorityV2,
  MAX_TASK_RUNTIME_REQUEST_AUTHORITY_WIRE_BYTES_V2,
  normalizeTaskRuntimeRequestAuthorityV2,
  readTaskRuntimeRequestAuthorityV2,
  taskRuntimeRequestAuthorityIssuerV2,
  type TaskRuntimeDeviceGroupHeadV2,
  type TaskRuntimeEphemeralSignerV2,
  type TaskRuntimeRequestAuthorityV2,
} from "./task-runtime-request-authority.ts";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "./task-runtime-request-v1.ts";

export const TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V2 =
  2 as const;
export const TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2 =
  "task.runtime.background_authorization_request" as const;

const REQUEST_DOMAIN =
  "nautilo/lattice-crypto/task-runtime-background-authorization-request/v2";
const REQUEST_DOMAIN_PREFIX = frameText(REQUEST_DOMAIN);
const HASH_BYTES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TASK_DEFINITION_OBJECT_ID =
  /^(?:task-definition|task-historical):v1:[0-9a-f]{64}$/u;
const TASK_RUN_RESULT_OBJECT_ID_DOMAIN =
  "nautilo/task-run-result-crypto-object/v1";
const MAX_ID_FRAME_BYTES = 4 + V2_LIMITS.idBytes;

export const MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V2 =
  4 + utf8V2(REQUEST_DOMAIN).length + 4
  + 4 + utf8V2(TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2).length
  + 4 + MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1
  + MAX_ID_FRAME_BYTES * 4 + 8 + 4 + HASH_BYTES
  + MAX_TASK_RUNTIME_REQUEST_AUTHORITY_WIRE_BYTES_V2;

export type TaskRuntimeExecutionWorkBindingV2 = Readonly<{
  taskId: string;
  taskRunId: string;
  inputObjectId: string;
  resultObjectId: string;
  executionSegment: number;
  workIdentityHash: Uint8Array;
}>;

export type {
  TaskRuntimeDeviceGroupHeadV2,
  TaskRuntimeEphemeralSignerV2,
} from "./task-runtime-request-authority.ts";

export interface TaskRuntimeBackgroundAuthorizationRequestV2 {
  readonly formatVersion:
    typeof TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V2;
  readonly purpose:
    typeof TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2;
  readonly baseRequest: TaskRuntimeBackgroundAuthorizationRequestV1;
  readonly work: TaskRuntimeExecutionWorkBindingV2;
  readonly signer: TaskRuntimeEphemeralSignerV2;
  readonly deviceGroupHead: TaskRuntimeDeviceGroupHeadV2;
  readonly namespaceRequirements:
    readonly TaskRuntimeExecutionNamespaceAuthorityV1[];
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function counter(label: string, value: unknown): number {
  assertU64Counter(label, value);
  return value;
}

function bytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactFields(label: string, value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  if (actual.length !== fields.length
    || actual.some((field, index) => field !== fields[index])) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function normalize(
  crypto: Pick<LatticeCrypto, "hash">,
  value: TaskRuntimeBackgroundAuthorizationRequestV2,
): TaskRuntimeBackgroundAuthorizationRequestV2 {
  exactFields("Task Runtime V2 request", value, [
    "formatVersion", "purpose", "baseRequest", "work", "signer",
    "deviceGroupHead", "namespaceRequirements",
  ]);
  if (value.formatVersion
      !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V2
    || value.purpose
      !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2) {
    throw new TypeError("Task Runtime V2 request version or purpose is unsupported");
  }
  const baseBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
    value.baseRequest,
  );
  const baseRequest = decodeTaskRuntimeBackgroundAuthorizationRequestV1(baseBytes);
  baseBytes.fill(0);
  if (baseRequest === null) throw new TypeError("Task Runtime base request is invalid");
  let plan = parseDomainForegroundAuthorizationPlanV2(
    baseRequest.authorizationPlanBytes,
  );
  let workIdentityHash: Uint8Array | undefined;
  let authority: TaskRuntimeRequestAuthorityV2 | undefined;
  try {
    const executionWorkKind = baseRequest.workKind === "task.execute"
      || baseRequest.workKind === "task.approval_resume"
      || baseRequest.workKind === "task.await_reply_resume";
    if (plan === null || !executionWorkKind
      || baseRequest.workPurpose !== baseRequest.workKind) {
      throw new TypeError("Task Runtime V2 supports only Task execution work");
    }
    exactFields("Task Runtime work binding", value.work, [
      "taskId", "taskRunId", "inputObjectId", "resultObjectId",
      "executionSegment", "workIdentityHash",
    ]);
    const executionSegment = counter(
      "Task Runtime execution segment",
      value.work.executionSegment,
    );
    const resultDigest = crypto.hash(new TextEncoder().encode(
      `${TASK_RUN_RESULT_OBJECT_ID_DOMAIN}\n${value.work.taskId}\n${value.work.taskRunId}\n1`,
    ));
    const expectedResultObjectId = `task-run-result:v1:${bytesToHex(resultDigest)}`;
    resultDigest.fill(0);
    if (executionSegment < 1
      || value.work.taskRunId !== baseRequest.workId
      || !UUID.test(value.work.taskId)
      || !UUID.test(value.work.taskRunId)
      || !TASK_DEFINITION_OBJECT_ID.test(value.work.inputObjectId)
      || value.work.resultObjectId !== expectedResultObjectId) {
      throw new TypeError("Task Runtime work binding disagrees with its base request");
    }
    workIdentityHash = bytes(
      "Task Runtime work identity hash", value.work.workIdentityHash, HASH_BYTES,
    );
    authority = normalizeTaskRuntimeRequestAuthorityV2(crypto, plan, value);
    return Object.freeze({
      formatVersion: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V2,
      purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2,
      baseRequest,
      work: Object.freeze({
        taskId: portable("Task Runtime Task ID", value.work.taskId),
        taskRunId: portable("Task Runtime Task Run ID", value.work.taskRunId),
        inputObjectId: portable("Task Runtime input object ID", value.work.inputObjectId),
        resultObjectId: portable("Task Runtime result object ID", value.work.resultObjectId),
        executionSegment,
        workIdentityHash,
      }),
      ...authority,
    });
  } catch (error) {
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(baseRequest);
    workIdentityHash?.fill(0);
    if (authority !== undefined) destroyTaskRuntimeRequestAuthorityV2(authority);
    throw error;
  } finally {
    if (plan !== null) destroyDomainForegroundAuthorizationPlanV2(plan);
    plan = null;
  }
}

function requestBytes(value: TaskRuntimeBackgroundAuthorizationRequestV2): Uint8Array {
  const baseBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(value.baseRequest);
  const authorityBytes = encodeTaskRuntimeRequestAuthorityV2(value);
  try {
    return concatV2(
      frameText(REQUEST_DOMAIN), encodeU32(value.formatVersion),
      frameText(value.purpose), frame(baseBytes),
      frameText(value.work.taskId), frameText(value.work.taskRunId),
      frameText(value.work.inputObjectId), frameText(value.work.resultObjectId),
      encodeU64(value.work.executionSegment),
      frame(value.work.workIdentityHash),
      authorityBytes,
    );
  } finally {
    baseBytes.fill(0);
    authorityBytes.fill(0);
  }
}

export function encodeTaskRuntimeBackgroundAuthorizationRequestV2(
  crypto: Pick<LatticeCrypto, "hash">,
  value: TaskRuntimeBackgroundAuthorizationRequestV2,
): Uint8Array {
  const normalized = normalize(crypto, value);
  try {
    const encoded = requestBytes(normalized);
    if (encoded.length
      > MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V2) {
      encoded.fill(0);
      throw new RangeError("Task Runtime V2 request exceeds its wire bound");
    }
    return encoded;
  } finally {
    destroyTaskRuntimeBackgroundAuthorizationRequestV2(normalized);
  }
}

export function decodeTaskRuntimeBackgroundAuthorizationRequestV2(
  crypto: Pick<LatticeCrypto, "hash">,
  encoded: Uint8Array,
): TaskRuntimeBackgroundAuthorizationRequestV2 | null {
  if (!(encoded instanceof Uint8Array) || encoded.length < 1
    || encoded.length
      > MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V2) return null;
  let value: TaskRuntimeBackgroundAuthorizationRequestV2 | null = null;
  try {
    value = decodeExact(encoded, reader => {
      if (reader.readText(utf8V2(REQUEST_DOMAIN).length) !== REQUEST_DOMAIN) {
        throw new TypeError("Task Runtime V2 request domain is invalid");
      }
      reader.readVersion(TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V2);
      if (reader.readText(utf8V2(TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2).length)
        !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2) {
        throw new TypeError("Task Runtime V2 request purpose is invalid");
      }
      const baseBytes = reader.readFrame(
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1,
      );
      const baseRequest = decodeTaskRuntimeBackgroundAuthorizationRequestV1(baseBytes);
      baseBytes.fill(0);
      if (baseRequest === null) throw new TypeError("Task Runtime base request is invalid");
      let workIdentityHash: Uint8Array | undefined;
      let authority: TaskRuntimeRequestAuthorityV2 | undefined;
      try {
        const work = {
          taskId: reader.readText(V2_LIMITS.idBytes),
          taskRunId: reader.readText(V2_LIMITS.idBytes),
          inputObjectId: reader.readText(V2_LIMITS.idBytes),
          resultObjectId: reader.readText(V2_LIMITS.idBytes),
          executionSegment: reader.readU64(),
          workIdentityHash: workIdentityHash = reader.readFrame(HASH_BYTES),
        };
        authority = readTaskRuntimeRequestAuthorityV2(reader);
        return normalize(crypto, {
          formatVersion: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V2,
          purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2,
          baseRequest, work, ...authority,
        });
      } finally {
        destroyTaskRuntimeBackgroundAuthorizationRequestV1(baseRequest);
        workIdentityHash?.fill(0);
        if (authority !== undefined) destroyTaskRuntimeRequestAuthorityV2(authority);
      }
    });
    const canonical = requestBytes(value);
    const valid = same(canonical, encoded);
    canonical.fill(0);
    if (!valid) {
      destroyTaskRuntimeBackgroundAuthorizationRequestV2(value);
      value = null;
    }
    return value;
  } catch {
    if (value !== null) destroyTaskRuntimeBackgroundAuthorizationRequestV2(value);
    return null;
  }
}

/** Recognizes routing ownership only; decoding still performs all acceptance. */
export function isTaskRuntimeBackgroundAuthorizationRequestV2Carrier(
  encoded: Uint8Array,
): boolean {
  if (!(encoded instanceof Uint8Array)
    || encoded.length < REQUEST_DOMAIN_PREFIX.length) return false;
  for (let index = 0; index < REQUEST_DOMAIN_PREFIX.length; index += 1) {
    if (encoded[index] !== REQUEST_DOMAIN_PREFIX[index]) return false;
  }
  return true;
}

export function createTaskRuntimeBackgroundAuthorizationRequestV2(
  crypto: Pick<LatticeCrypto, "hash">,
  input: Omit<TaskRuntimeBackgroundAuthorizationRequestV2,
    "formatVersion" | "purpose">,
): TaskRuntimeBackgroundAuthorizationRequestV2 {
  return normalize(crypto, {
    ...input,
    formatVersion: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V2,
    purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2,
  });
}

export function taskRuntimeBackgroundAuthorizationIssuerV2(
  value: TaskRuntimeBackgroundAuthorizationRequestV2,
): BackgroundAuthorizationIssuerV2 {
  if (value.formatVersion
      !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V2
    || value.purpose
      !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2) {
    throw new TypeError("Task Runtime V2 request version or purpose is unsupported");
  }
  const baseBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
    value.baseRequest,
  );
  baseBytes.fill(0);
  return taskRuntimeRequestAuthorityIssuerV2(value.baseRequest, value);
}

export function destroyTaskRuntimeBackgroundAuthorizationRequestV2(
  value: TaskRuntimeBackgroundAuthorizationRequestV2,
): void {
  destroyTaskRuntimeBackgroundAuthorizationRequestV1(value.baseRequest);
  value.work.workIdentityHash.fill(0);
  destroyTaskRuntimeRequestAuthorityV2(value);
}
