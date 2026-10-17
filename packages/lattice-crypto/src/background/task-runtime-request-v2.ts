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
import { agentRuntimeObjectSignerKeyIdV1 } from "../agent-runtime/object-signer-v1.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import type { BackgroundAuthorizationIssuerV2 } from "./processor-authorization-v2.ts";
import type { TaskRuntimeExecutionNamespaceAuthorityV1 } from
  "./task-runtime-execution-evidence-v1.ts";
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
const MAX_OPERATION_BYTES = utf8V2("decrypt").length;
const MAX_ID_FRAME_BYTES = 4 + V2_LIMITS.idBytes;
const MAX_NAMESPACE_REQUIREMENT_BYTES = 8 + MAX_ID_FRAME_BYTES * 2
  + 4 + 2 * (4 + MAX_OPERATION_BYTES) + 8 + 8;

export const MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V2 =
  4 + utf8V2(REQUEST_DOMAIN).length + 4
  + 4 + utf8V2(TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2).length
  + 4 + MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_WIRE_BYTES_V1
  + MAX_ID_FRAME_BYTES * 4 + 8 + 4 + HASH_BYTES
  + MAX_ID_FRAME_BYTES * 2 + 8 + 4 + V2_LIMITS.signingPublicKeyBytes
  + MAX_ID_FRAME_BYTES + 8 + 8 + 4 + HASH_BYTES + 4 + HASH_BYTES
  + 4 + V2_LIMITS.agentGrantNamespaces * MAX_NAMESPACE_REQUIREMENT_BYTES;

export type TaskRuntimeExecutionWorkBindingV2 = Readonly<{
  taskId: string;
  taskRunId: string;
  inputObjectId: string;
  resultObjectId: string;
  executionSegment: 1;
  workIdentityHash: Uint8Array;
}>;

export type TaskRuntimeEphemeralSignerV2 = Readonly<{
  agentId: string;
  runtimeGeneration: 0;
  signerKeyId: string;
  signerPublicKey: Uint8Array;
}>;

export type TaskRuntimeDeviceGroupHeadV2 = Readonly<{
  serverInstanceId: string;
  lineageGeneration: number;
  epoch: number;
  headDigest: Uint8Array;
  signingPublicKeyHash: Uint8Array;
}>;

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

function operations(
  value: readonly ("decrypt" | "encrypt")[],
): readonly ("decrypt" | "encrypt")[] {
  if (!Array.isArray(value as unknown)
    || (value.length !== 1 && value.length !== 2)
    || (value.length === 1
      && value[0] !== "decrypt" && value[0] !== "encrypt")
    || (value.length === 2
      && (value[0] !== "decrypt" || value[1] !== "encrypt"))) {
    throw new TypeError("Task Runtime Namespace operations are invalid");
  }
  return Object.freeze([...value]);
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
  let signerPublicKey: Uint8Array | undefined;
  let headDigest: Uint8Array | undefined;
  let signingPublicKeyHash: Uint8Array | undefined;
  const requirements: TaskRuntimeExecutionNamespaceAuthorityV1[] = [];
  try {
    if (plan === null || baseRequest.workKind !== "task.execute"
      || baseRequest.workPurpose !== "task.execute") {
      throw new TypeError("Task Runtime V2 supports only task.execute");
    }
    exactFields("Task Runtime work binding", value.work, [
      "taskId", "taskRunId", "inputObjectId", "resultObjectId",
      "executionSegment", "workIdentityHash",
    ]);
    const resultDigest = crypto.hash(new TextEncoder().encode(
      `${TASK_RUN_RESULT_OBJECT_ID_DOMAIN}\n${value.work.taskId}\n${value.work.taskRunId}\n1`,
    ));
    const expectedResultObjectId = `task-run-result:v1:${bytesToHex(resultDigest)}`;
    resultDigest.fill(0);
    if (value.work.executionSegment !== 1
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
    exactFields("Task Runtime ephemeral signer", value.signer, [
      "agentId", "runtimeGeneration", "signerKeyId", "signerPublicKey",
    ]);
    if (value.signer.runtimeGeneration !== 0) {
      throw new TypeError("Task Runtime ephemeral signer generation is unsupported");
    }
    signerPublicKey = bytes(
      "Task Runtime signer public key",
      value.signer.signerPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    if (value.signer.signerKeyId
      !== agentRuntimeObjectSignerKeyIdV1(crypto, signerPublicKey)) {
      throw new TypeError("Task Runtime signer key ID disagrees with its public key");
    }
    exactFields("Task Runtime Device Group head", value.deviceGroupHead, [
      "serverInstanceId", "lineageGeneration", "epoch", "headDigest",
      "signingPublicKeyHash",
    ]);
    headDigest = bytes(
      "Task Runtime Device Group head digest",
      value.deviceGroupHead.headDigest,
      HASH_BYTES,
    );
    signingPublicKeyHash = bytes(
      "Task Runtime Device signing public key hash",
      value.deviceGroupHead.signingPublicKeyHash,
      HASH_BYTES,
    );
    if (!Array.isArray(value.namespaceRequirements as unknown)
      || value.namespaceRequirements.length < 1
      || value.namespaceRequirements.length > V2_LIMITS.agentGrantNamespaces) {
      throw new RangeError("Task Runtime Namespace requirements exceed capacity");
    }
    for (const [index, requirement] of value.namespaceRequirements.entries()) {
      exactFields("Task Runtime Namespace requirement", requirement, [
        "ordinal", "namespaceId", "domainId", "operations",
        "expectedAccessRevision", "expectedPolicyRevision",
      ]);
      const selectedOperations = operations(requirement.operations);
      if (requirement.ordinal !== index
        || (index > 0 && compareUnsignedUtf8(
          value.namespaceRequirements[index - 1]!.namespaceId,
          requirement.namespaceId,
        ) >= 0)
        || requirement.expectedPolicyRevision !== plan.policyRevision
        || !plan.domains.some((domain) => domain.domainId === requirement.domainId)
        || selectedOperations.some((operation) =>
          !plan!.operations.includes(operation))) {
        throw new TypeError("Task Runtime Namespace requirement exceeds its Domain plan");
      }
      requirements.push(Object.freeze({
        ordinal: counter("Task Runtime Namespace ordinal", requirement.ordinal),
        namespaceId: portable("Task Runtime Namespace ID", requirement.namespaceId),
        domainId: portable("Task Runtime Namespace Domain ID", requirement.domainId),
        operations: selectedOperations,
        expectedAccessRevision: counter(
          "Task Runtime Namespace access revision",
          requirement.expectedAccessRevision,
        ),
        expectedPolicyRevision: counter(
          "Task Runtime Namespace policy revision",
          requirement.expectedPolicyRevision,
        ),
      }));
    }
    if (new Set(requirements.map((entry) => entry.namespaceId)).size
      !== requirements.length) {
      throw new TypeError("Task Runtime Namespace requirements must be unique");
    }
    return Object.freeze({
      formatVersion: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V2,
      purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2,
      baseRequest,
      work: Object.freeze({
        taskId: portable("Task Runtime Task ID", value.work.taskId),
        taskRunId: portable("Task Runtime Task Run ID", value.work.taskRunId),
        inputObjectId: portable("Task Runtime input object ID", value.work.inputObjectId),
        resultObjectId: portable("Task Runtime result object ID", value.work.resultObjectId),
        executionSegment: 1,
        workIdentityHash,
      }),
      signer: Object.freeze({
        agentId: portable("Task Runtime signer Agent ID", value.signer.agentId),
        runtimeGeneration: 0,
        signerKeyId: portable("Task Runtime signer key ID", value.signer.signerKeyId),
        signerPublicKey,
      }),
      deviceGroupHead: Object.freeze({
        serverInstanceId: portable(
          "Task Runtime server instance ID", value.deviceGroupHead.serverInstanceId,
        ),
        lineageGeneration: counter(
          "Task Runtime lineage generation", value.deviceGroupHead.lineageGeneration,
        ),
        epoch: counter("Task Runtime Device Group epoch", value.deviceGroupHead.epoch),
        headDigest,
        signingPublicKeyHash,
      }),
      namespaceRequirements: Object.freeze(requirements),
    });
  } catch (error) {
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(baseRequest);
    workIdentityHash?.fill(0);
    signerPublicKey?.fill(0);
    headDigest?.fill(0);
    signingPublicKeyHash?.fill(0);
    throw error;
  } finally {
    if (plan !== null) destroyDomainForegroundAuthorizationPlanV2(plan);
    plan = null;
  }
}

function requestBytes(value: TaskRuntimeBackgroundAuthorizationRequestV2): Uint8Array {
  const baseBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(value.baseRequest);
  try {
    return concatV2(
      frameText(REQUEST_DOMAIN), encodeU32(value.formatVersion),
      frameText(value.purpose), frame(baseBytes),
      frameText(value.work.taskId), frameText(value.work.taskRunId),
      frameText(value.work.inputObjectId), frameText(value.work.resultObjectId),
      encodeU64(value.work.executionSegment),
      frame(value.work.workIdentityHash),
      frameText(value.signer.agentId), encodeU64(value.signer.runtimeGeneration),
      frameText(value.signer.signerKeyId), frame(value.signer.signerPublicKey),
      frameText(value.deviceGroupHead.serverInstanceId),
      encodeU64(value.deviceGroupHead.lineageGeneration),
      encodeU64(value.deviceGroupHead.epoch), frame(value.deviceGroupHead.headDigest),
      frame(value.deviceGroupHead.signingPublicKeyHash),
      encodeU32(value.namespaceRequirements.length),
      ...value.namespaceRequirements.flatMap((entry) => [
        encodeU64(entry.ordinal), frameText(entry.namespaceId), frameText(entry.domainId),
        encodeU32(entry.operations.length), ...entry.operations.map(frameText),
        encodeU64(entry.expectedAccessRevision),
        encodeU64(entry.expectedPolicyRevision),
      ]),
    );
  } finally {
    baseBytes.fill(0);
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
      try {
        const work = {
          taskId: reader.readText(V2_LIMITS.idBytes),
          taskRunId: reader.readText(V2_LIMITS.idBytes),
          inputObjectId: reader.readText(V2_LIMITS.idBytes),
          resultObjectId: reader.readText(V2_LIMITS.idBytes),
          executionSegment: reader.readU64() as 1,
          workIdentityHash: reader.readFrame(HASH_BYTES),
        };
        const signer = {
          agentId: reader.readText(V2_LIMITS.idBytes),
          runtimeGeneration: reader.readU64() as 0,
          signerKeyId: reader.readText(V2_LIMITS.idBytes),
          signerPublicKey: reader.readFrame(V2_LIMITS.signingPublicKeyBytes),
        };
        const deviceGroupHead = {
          serverInstanceId: reader.readText(V2_LIMITS.idBytes),
          lineageGeneration: reader.readU64(), epoch: reader.readU64(),
          headDigest: reader.readFrame(HASH_BYTES),
          signingPublicKeyHash: reader.readFrame(HASH_BYTES),
        };
        const namespaceRequirements = Array.from(
          { length: reader.readCount(V2_LIMITS.agentGrantNamespaces) },
          () => ({
            ordinal: reader.readU64(),
            namespaceId: reader.readText(V2_LIMITS.idBytes),
            domainId: reader.readText(V2_LIMITS.idBytes),
            operations: Array.from({ length: reader.readCount(2) }, () =>
              reader.readText(MAX_OPERATION_BYTES) as "decrypt" | "encrypt"),
            expectedAccessRevision: reader.readU64(),
            expectedPolicyRevision: reader.readU64(),
          }),
        );
        return normalize(crypto, {
          formatVersion: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_FORMAT_VERSION_V2,
          purpose: TASK_RUNTIME_BACKGROUND_AUTHORIZATION_REQUEST_PURPOSE_V2,
          baseRequest, work, signer, deviceGroupHead, namespaceRequirements,
        });
      } finally {
        destroyTaskRuntimeBackgroundAuthorizationRequestV1(baseRequest);
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
  const plan = parseDomainForegroundAuthorizationPlanV2(
    value.baseRequest.authorizationPlanBytes,
  );
  if (plan === null) throw new TypeError("Task Runtime authorization plan is invalid");
  let headDigest: Uint8Array | undefined;
  let signingPublicKeyHash: Uint8Array | undefined;
  try {
    headDigest = bytes(
      "Task Runtime Device Group head digest",
      value.deviceGroupHead.headDigest,
      HASH_BYTES,
    );
    signingPublicKeyHash = bytes(
      "Task Runtime Device signing public key hash",
      value.deviceGroupHead.signingPublicKeyHash,
      HASH_BYTES,
    );
    return Object.freeze({
      humanId: plan.subjectHumanId,
      deviceId: plan.committerDeviceId,
      deviceGeneration: plan.committerDeviceSigningGeneration,
      serverInstanceId: portable(
        "Task Runtime server instance ID", value.deviceGroupHead.serverInstanceId,
      ),
      lineageGeneration: counter(
        "Task Runtime lineage generation", value.deviceGroupHead.lineageGeneration,
      ),
      epoch: counter("Task Runtime Device Group epoch", value.deviceGroupHead.epoch),
      securityRevision: plan.hostAuthorizationRevision,
      headDigest,
      signingPublicKeyHash,
    });
  } catch (error) {
    headDigest?.fill(0);
    signingPublicKeyHash?.fill(0);
    throw error;
  } finally {
    destroyDomainForegroundAuthorizationPlanV2(plan);
  }
}

export function destroyTaskRuntimeBackgroundAuthorizationRequestV2(
  value: TaskRuntimeBackgroundAuthorizationRequestV2,
): void {
  destroyTaskRuntimeBackgroundAuthorizationRequestV1(value.baseRequest);
  value.work.workIdentityHash.fill(0);
  value.signer.signerPublicKey.fill(0);
  value.deviceGroupHead.headDigest.fill(0);
  value.deviceGroupHead.signingPublicKeyHash.fill(0);
}
