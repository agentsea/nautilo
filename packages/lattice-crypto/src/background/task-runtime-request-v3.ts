import type { LatticeCrypto } from "../crypto/index.ts";
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
  type StrictDecoder,
  utf8V2,
} from "../format/v2-primitives.ts";
import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import type { BackgroundAuthorizationIssuerV2 } from
  "./processor-authorization-v2.ts";
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

export const TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V3 =
  3 as const;
export const TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V3 =
  "task.runtime.background_authorization_request" as const;

const REQUEST_DOMAIN =
  "nautilo/lattice-crypto/task-runtime-background-authorization-request/v3";
const REQUEST_DOMAIN_PREFIX = frameText(REQUEST_DOMAIN);
const HASH_BYTES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MESSAGE_OBJECT_ID = /^message:v2:[0-9a-f]{64}$/u;
const MAX_ID_FRAME_BYTES = 4 + V2_LIMITS.idBytes;
export const MAX_TASK_RUNTIME_PUBLICATION_WORK_BINDING_WIRE_BYTES_V3 =
  4 + MAX_ID_FRAME_BYTES * 3 + 8 + 4 + HASH_BYTES;

export const MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V3 =
  4 + utf8V2(REQUEST_DOMAIN).length + 4
  + 4 + utf8V2(TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V3).length
  + 4 + MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1
  + MAX_TASK_RUNTIME_PUBLICATION_WORK_BINDING_WIRE_BYTES_V3
  + MAX_TASK_RUNTIME_REQUEST_AUTHORITY_WIRE_BYTES_V2;

type TaskRuntimePublicationWorkBindingCommonV3 = Readonly<{
  taskId: string;
  taskRunId: string;
  contentRevision: 1 | 2;
  workIdentityHash: Uint8Array;
}>;

export type TaskRuntimePublicationWorkBindingV3 =
  | (TaskRuntimePublicationWorkBindingCommonV3 & Readonly<{
    kind: "task.cancel_result";
    contentRevision: 2;
  }>)
  | (TaskRuntimePublicationWorkBindingCommonV3 & Readonly<{
    kind: "task.deliver_result";
    contentRevision: 1;
  }>)
  | (TaskRuntimePublicationWorkBindingCommonV3 & Readonly<{
    kind: "task.deliver_message";
    contentRevision: 2;
    messageObjectId: string;
  }>)
  | (TaskRuntimePublicationWorkBindingCommonV3 & Readonly<{
    kind: "task.delivery_wake";
    jobId: string;
  }>);

export interface TaskRuntimeBackgroundAuthorizationRequestV3 {
  readonly formatVersion:
    typeof TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V3;
  readonly purpose:
    typeof TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V3;
  readonly baseRequest: TaskRuntimeBackgroundAuthorizationRequestV1;
  readonly work: TaskRuntimePublicationWorkBindingV3;
  readonly signer: TaskRuntimeEphemeralSignerV2;
  readonly deviceGroupHead: TaskRuntimeDeviceGroupHeadV2;
  readonly namespaceRequirements:
    readonly TaskRuntimeExecutionNamespaceAuthorityV1[];
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function revision(value: unknown): 1 | 2 {
  assertU64Counter("Task Runtime publication content revision", value);
  if (value !== 1 && value !== 2) {
    throw new RangeError("Task Runtime publication content revision is unsupported");
  }
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

function exactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  if (actual.length !== fields.length
    || actual.some((field, index) => field !== fields[index])) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function workKindDiscriminator(
  kind: TaskRuntimePublicationWorkBindingV3["kind"],
): number {
  switch (kind) {
    case "task.cancel_result": return 1;
    case "task.deliver_message": return 2;
    case "task.deliver_result": return 3;
    case "task.delivery_wake": return 4;
  }
}

function workKind(discriminator: number): TaskRuntimePublicationWorkBindingV3["kind"] {
  switch (discriminator) {
    case 1: return "task.cancel_result";
    case 2: return "task.deliver_message";
    case 3: return "task.deliver_result";
    case 4: return "task.delivery_wake";
    default: throw new TypeError("Task Runtime publication work kind is unsupported");
  }
}

export function normalizeTaskRuntimePublicationWorkBindingV3(
  value: TaskRuntimePublicationWorkBindingV3,
): TaskRuntimePublicationWorkBindingV3 {
  const commonFields = [
    "kind", "taskId", "taskRunId", "contentRevision", "workIdentityHash",
  ];
  const expected = value.kind === "task.deliver_message"
    ? [...commonFields, "messageObjectId"]
    : value.kind === "task.delivery_wake"
      ? [...commonFields, "jobId"]
      : commonFields;
  exactFields("Task Runtime publication work binding", value, expected);
  if (!UUID.test(value.taskId) || !UUID.test(value.taskRunId)) {
    throw new TypeError("Task Runtime publication Task coordinates are invalid");
  }
  const contentRevision = revision(value.contentRevision);
  if ((value.kind === "task.cancel_result" && contentRevision !== 2)
    || (value.kind === "task.deliver_result" && contentRevision !== 1)
    || (value.kind === "task.deliver_message" && contentRevision !== 2)) {
    throw new TypeError("Task Runtime publication revision disagrees with its work kind");
  }
  const workIdentityHash = bytes(
    "Task Runtime work identity hash", value.workIdentityHash, HASH_BYTES,
  );
  try {
    const common = {
      kind: value.kind,
      taskId: portable("Task Runtime Task ID", value.taskId),
      taskRunId: portable("Task Runtime Task Run ID", value.taskRunId),
      contentRevision,
      workIdentityHash,
    };
    if (value.kind === "task.deliver_message") {
      if (!MESSAGE_OBJECT_ID.test(value.messageObjectId)) {
        throw new TypeError("Task Runtime publication Message object ID is invalid");
      }
      return Object.freeze({
        ...common,
        kind: value.kind,
        contentRevision: 2,
        messageObjectId: portable(
          "Task Runtime publication Message object ID", value.messageObjectId,
        ),
      });
    }
    if (value.kind === "task.delivery_wake") {
      if (!UUID.test(value.jobId)) {
        throw new TypeError("Task Runtime publication Job ID is invalid");
      }
      return Object.freeze({
        ...common,
        kind: value.kind,
        jobId: portable("Task Runtime publication Job ID", value.jobId),
      });
    }
    if (value.kind === "task.cancel_result") {
      return Object.freeze({ ...common, kind: value.kind, contentRevision: 2 });
    }
    if (value.kind === "task.deliver_result") {
      return Object.freeze({ ...common, kind: value.kind, contentRevision: 1 });
    }
    throw new TypeError("Task Runtime publication work kind is unsupported");
  } catch (error) {
    workIdentityHash.fill(0);
    throw error;
  }
}

export function assertTaskRuntimePublicationWorkMatchesBaseRequestV3(
  baseRequest: TaskRuntimeBackgroundAuthorizationRequestV1,
  work: TaskRuntimePublicationWorkBindingV3,
): void {
  if (baseRequest.workKind !== work.kind
    || baseRequest.workPurpose !== work.kind
    || baseRequest.workId !== (work.kind === "task.delivery_wake"
      ? work.jobId
      : work.taskRunId)) {
    throw new TypeError(
      "Task Runtime publication work binding disagrees with its base request",
    );
  }
}

function publicationWorkBytes(
  value: TaskRuntimePublicationWorkBindingV3,
): Uint8Array {
  return concatV2(
    encodeU32(workKindDiscriminator(value.kind)),
    frameText(value.taskId),
    frameText(value.taskRunId),
    encodeU64(value.contentRevision),
    frame(value.workIdentityHash),
    ...(value.kind === "task.deliver_message"
      ? [frameText(value.messageObjectId)]
      : value.kind === "task.delivery_wake"
        ? [frameText(value.jobId)]
        : []),
  );
}

export function encodeTaskRuntimePublicationWorkBindingV3(
  value: TaskRuntimePublicationWorkBindingV3,
): Uint8Array {
  const normalized = normalizeTaskRuntimePublicationWorkBindingV3(value);
  try {
    return publicationWorkBytes(normalized);
  } finally {
    destroyTaskRuntimePublicationWorkBindingV3(normalized);
  }
}

export function readTaskRuntimePublicationWorkBindingV3(
  reader: StrictDecoder,
): TaskRuntimePublicationWorkBindingV3 {
  const kind = workKind(reader.readU32());
  const taskId = reader.readText(V2_LIMITS.idBytes);
  const taskRunId = reader.readText(V2_LIMITS.idBytes);
  const contentRevision = reader.readU64() as 1 | 2;
  const workIdentityHash = reader.readFrame(HASH_BYTES);
  try {
    if (kind === "task.deliver_message") {
      return normalizeTaskRuntimePublicationWorkBindingV3({
        kind, taskId, taskRunId, contentRevision: contentRevision as 2,
        workIdentityHash,
        messageObjectId: reader.readText(V2_LIMITS.idBytes),
      });
    }
    if (kind === "task.delivery_wake") {
      return normalizeTaskRuntimePublicationWorkBindingV3({
        kind, taskId, taskRunId, contentRevision, workIdentityHash,
        jobId: reader.readText(V2_LIMITS.idBytes),
      });
    }
    return normalizeTaskRuntimePublicationWorkBindingV3({
      kind, taskId, taskRunId,
      contentRevision,
      workIdentityHash,
    } as TaskRuntimePublicationWorkBindingV3);
  } finally {
    workIdentityHash.fill(0);
  }
}

function normalize(
  crypto: Pick<LatticeCrypto, "hash">,
  value: TaskRuntimeBackgroundAuthorizationRequestV3,
): TaskRuntimeBackgroundAuthorizationRequestV3 {
  exactFields("Task Runtime V3 request", value, [
    "formatVersion", "purpose", "baseRequest", "work", "signer",
    "deviceGroupHead", "namespaceRequirements",
  ]);
  if (value.formatVersion
      !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V3
    || value.purpose
      !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V3) {
    throw new TypeError("Task Runtime V3 request version or purpose is unsupported");
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
  let work: TaskRuntimePublicationWorkBindingV3 | undefined;
  let authority: TaskRuntimeRequestAuthorityV2 | undefined;
  try {
    if (plan === null) throw new TypeError("Task Runtime authorization plan is invalid");
    work = normalizeTaskRuntimePublicationWorkBindingV3(value.work);
    assertTaskRuntimePublicationWorkMatchesBaseRequestV3(baseRequest, work);
    authority = normalizeTaskRuntimeRequestAuthorityV2(crypto, plan, value);
    return Object.freeze({
      formatVersion: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V3,
      purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V3,
      baseRequest,
      work,
      ...authority,
    });
  } catch (error) {
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(baseRequest);
    if (work !== undefined) destroyTaskRuntimePublicationWorkBindingV3(work);
    if (authority !== undefined) destroyTaskRuntimeRequestAuthorityV2(authority);
    throw error;
  } finally {
    if (plan !== null) destroyDomainForegroundAuthorizationPlanV2(plan);
    plan = null;
  }
}

function requestBytes(value: TaskRuntimeBackgroundAuthorizationRequestV3): Uint8Array {
  const baseBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(value.baseRequest);
  const workBytes = publicationWorkBytes(value.work);
  const authorityBytes = encodeTaskRuntimeRequestAuthorityV2(value);
  try {
    return concatV2(
      frameText(REQUEST_DOMAIN), encodeU32(value.formatVersion),
      frameText(value.purpose), frame(baseBytes), workBytes, authorityBytes,
    );
  } finally {
    baseBytes.fill(0);
    workBytes.fill(0);
    authorityBytes.fill(0);
  }
}

export function encodeTaskRuntimeBackgroundAuthorizationRequestV3(
  crypto: Pick<LatticeCrypto, "hash">,
  value: TaskRuntimeBackgroundAuthorizationRequestV3,
): Uint8Array {
  const normalized = normalize(crypto, value);
  try {
    const encoded = requestBytes(normalized);
    if (encoded.length
      > MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V3) {
      encoded.fill(0);
      throw new RangeError("Task Runtime V3 request exceeds its wire bound");
    }
    return encoded;
  } finally {
    destroyTaskRuntimeBackgroundAuthorizationRequestV3(normalized);
  }
}

export function decodeTaskRuntimeBackgroundAuthorizationRequestV3(
  crypto: Pick<LatticeCrypto, "hash">,
  encoded: Uint8Array,
): TaskRuntimeBackgroundAuthorizationRequestV3 | null {
  if (!(encoded instanceof Uint8Array) || encoded.length < 1
    || encoded.length
      > MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V3) return null;
  let value: TaskRuntimeBackgroundAuthorizationRequestV3 | null = null;
  try {
    value = decodeExact(encoded, reader => {
      if (reader.readText(utf8V2(REQUEST_DOMAIN).length) !== REQUEST_DOMAIN) {
        throw new TypeError("Task Runtime V3 request domain is invalid");
      }
      reader.readVersion(TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V3);
      if (reader.readText(utf8V2(TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V3).length)
        !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V3) {
        throw new TypeError("Task Runtime V3 request purpose is invalid");
      }
      const baseBytes = reader.readFrame(
        MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1,
      );
      const baseRequest = decodeTaskRuntimeBackgroundAuthorizationRequestV1(baseBytes);
      baseBytes.fill(0);
      if (baseRequest === null) throw new TypeError("Task Runtime base request is invalid");
      let work: TaskRuntimePublicationWorkBindingV3 | undefined;
      let authority: TaskRuntimeRequestAuthorityV2 | undefined;
      try {
        work = readTaskRuntimePublicationWorkBindingV3(reader);
        authority = readTaskRuntimeRequestAuthorityV2(reader);
        return normalize(crypto, {
          formatVersion: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V3,
          purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V3,
          baseRequest, work, ...authority,
        });
      } finally {
        destroyTaskRuntimeBackgroundAuthorizationRequestV1(baseRequest);
        if (work !== undefined) destroyTaskRuntimePublicationWorkBindingV3(work);
        if (authority !== undefined) destroyTaskRuntimeRequestAuthorityV2(authority);
      }
    });
    const canonical = requestBytes(value);
    const valid = same(canonical, encoded);
    canonical.fill(0);
    if (!valid) {
      destroyTaskRuntimeBackgroundAuthorizationRequestV3(value);
      value = null;
    }
    return value;
  } catch {
    if (value !== null) destroyTaskRuntimeBackgroundAuthorizationRequestV3(value);
    return null;
  }
}

/** Recognizes routing ownership only; decoding still performs all acceptance. */
export function isTaskRuntimeBackgroundAuthorizationRequestV3Carrier(
  encoded: Uint8Array,
): boolean {
  if (!(encoded instanceof Uint8Array)
    || encoded.length < REQUEST_DOMAIN_PREFIX.length) return false;
  for (let index = 0; index < REQUEST_DOMAIN_PREFIX.length; index += 1) {
    if (encoded[index] !== REQUEST_DOMAIN_PREFIX[index]) return false;
  }
  return true;
}

export function createTaskRuntimeBackgroundAuthorizationRequestV3(
  crypto: Pick<LatticeCrypto, "hash">,
  input: Omit<TaskRuntimeBackgroundAuthorizationRequestV3,
    "formatVersion" | "purpose">,
): TaskRuntimeBackgroundAuthorizationRequestV3 {
  return normalize(crypto, {
    ...input,
    formatVersion: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V3,
    purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V3,
  });
}

export function taskRuntimeBackgroundAuthorizationIssuerV3(
  value: TaskRuntimeBackgroundAuthorizationRequestV3,
): BackgroundAuthorizationIssuerV2 {
  if (value.formatVersion
      !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V3
    || value.purpose
      !== TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V3) {
    throw new TypeError("Task Runtime V3 request version or purpose is unsupported");
  }
  const baseBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
    value.baseRequest,
  );
  baseBytes.fill(0);
  return taskRuntimeRequestAuthorityIssuerV2(value.baseRequest, value);
}

export function destroyTaskRuntimePublicationWorkBindingV3(
  value: TaskRuntimePublicationWorkBindingV3,
): void {
  value.workIdentityHash.fill(0);
}

export function destroyTaskRuntimeBackgroundAuthorizationRequestV3(
  value: TaskRuntimeBackgroundAuthorizationRequestV3,
): void {
  destroyTaskRuntimeBackgroundAuthorizationRequestV1(value.baseRequest);
  destroyTaskRuntimePublicationWorkBindingV3(value.work);
  destroyTaskRuntimeRequestAuthorityV2(value);
}
