import type { LatticeCrypto } from "../crypto/index.ts";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
  type DomainForegroundAuthorizationPlanV2,
} from "../format/domain-foreground-authorization-v2.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  type StrictDecoder,
  utf8V2,
} from "../format/v2-primitives.ts";
import { agentRuntimeObjectSignerKeyIdV1 } from
  "../agent-runtime/object-signer-v1.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import type { BackgroundAuthorizationIssuerV2 } from
  "./processor-authorization-v2.ts";
import type { TaskRuntimeExecutionNamespaceAuthorityV1 } from
  "./task-runtime-execution-evidence-v1.ts";
import type { TaskRuntimeBackgroundAuthorizationRequestV1 } from
  "./task-runtime-request-v1.ts";

const HASH_BYTES = 32;
const MAX_OPERATION_BYTES = utf8V2("decrypt").length;
const MAX_ID_FRAME_BYTES = 4 + V2_LIMITS.idBytes;
const MAX_NAMESPACE_REQUIREMENT_BYTES = 8 + MAX_ID_FRAME_BYTES * 2
  + 4 + 2 * (4 + MAX_OPERATION_BYTES) + 8 + 8;

export const MAX_TASK_RUNTIME_REQUEST_AUTHORITY_WIRE_BYTES_V2 =
  MAX_ID_FRAME_BYTES * 2 + 8 + 4 + V2_LIMITS.signingPublicKeyBytes
  + MAX_ID_FRAME_BYTES + 8 + 8 + 4 + HASH_BYTES + 4 + HASH_BYTES
  + 4 + V2_LIMITS.agentGrantNamespaces * MAX_NAMESPACE_REQUIREMENT_BYTES;

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

export type TaskRuntimeRequestAuthorityV2 = Readonly<{
  signer: TaskRuntimeEphemeralSignerV2;
  deviceGroupHead: TaskRuntimeDeviceGroupHeadV2;
  namespaceRequirements: readonly TaskRuntimeExecutionNamespaceAuthorityV1[];
}>;

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

export function normalizeTaskRuntimeRequestAuthorityV2(
  crypto: Pick<LatticeCrypto, "hash">,
  plan: DomainForegroundAuthorizationPlanV2,
  value: TaskRuntimeRequestAuthorityV2,
): TaskRuntimeRequestAuthorityV2 {
  let signerPublicKey: Uint8Array | undefined;
  let headDigest: Uint8Array | undefined;
  let signingPublicKeyHash: Uint8Array | undefined;
  const requirements: TaskRuntimeExecutionNamespaceAuthorityV1[] = [];
  try {
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
          !plan.operations.includes(operation))) {
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
    signerPublicKey?.fill(0);
    headDigest?.fill(0);
    signingPublicKeyHash?.fill(0);
    throw error;
  }
}

export function encodeTaskRuntimeRequestAuthorityV2(
  value: TaskRuntimeRequestAuthorityV2,
): Uint8Array {
  return concatV2(
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
}

export function readTaskRuntimeRequestAuthorityV2(
  reader: StrictDecoder,
): TaskRuntimeRequestAuthorityV2 {
  return {
    signer: {
      agentId: reader.readText(V2_LIMITS.idBytes),
      runtimeGeneration: reader.readU64() as 0,
      signerKeyId: reader.readText(V2_LIMITS.idBytes),
      signerPublicKey: reader.readFrame(V2_LIMITS.signingPublicKeyBytes),
    },
    deviceGroupHead: {
      serverInstanceId: reader.readText(V2_LIMITS.idBytes),
      lineageGeneration: reader.readU64(),
      epoch: reader.readU64(),
      headDigest: reader.readFrame(HASH_BYTES),
      signingPublicKeyHash: reader.readFrame(HASH_BYTES),
    },
    namespaceRequirements: Array.from(
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
    ),
  };
}

export function taskRuntimeRequestAuthorityIssuerV2(
  baseRequest: TaskRuntimeBackgroundAuthorizationRequestV1,
  value: TaskRuntimeRequestAuthorityV2,
): BackgroundAuthorizationIssuerV2 {
  const plan = parseDomainForegroundAuthorizationPlanV2(
    baseRequest.authorizationPlanBytes,
  );
  if (plan === null) throw new TypeError("Task Runtime authorization plan is invalid");
  let headDigest: Uint8Array | undefined;
  let signingPublicKeyHash: Uint8Array | undefined;
  try {
    headDigest = bytes(
      "Task Runtime Device Group head digest", value.deviceGroupHead.headDigest,
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

export function destroyTaskRuntimeRequestAuthorityV2(
  value: TaskRuntimeRequestAuthorityV2,
): void {
  value.signer.signerPublicKey.fill(0);
  value.deviceGroupHead.headDigest.fill(0);
  value.deviceGroupHead.signingPublicKeyHash.fill(0);
}
