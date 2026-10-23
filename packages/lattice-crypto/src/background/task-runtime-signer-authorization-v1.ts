import { ed25519 } from "@noble/curves/ed25519.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationV2,
  verifyDomainForegroundAuthorizationV2,
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2,
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
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV2,
  destroyTaskRuntimeBackgroundAuthorizationRequestV2,
  taskRuntimeBackgroundAuthorizationIssuerV2,
  type TaskRuntimeBackgroundAuthorizationRequestV2,
} from "./task-runtime-request-v2.ts";

import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV3,
  destroyTaskRuntimeBackgroundAuthorizationRequestV3,
  isTaskRuntimeBackgroundAuthorizationRequestV3Carrier,
  taskRuntimeBackgroundAuthorizationIssuerV3,
  encodeTaskRuntimePublicationWorkBindingV3,
  readTaskRuntimePublicationWorkBindingV3,
  type TaskRuntimeBackgroundAuthorizationRequestV3,
  type TaskRuntimePublicationWorkBindingV3,
} from "./task-runtime-request-v3.ts";

export const TASK_RUNTIME_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1 = 1 as const;
export const TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1 =
  "task.runtime.signer_authorization" as const;

const CERTIFICATE_DOMAIN =
  "nautilo/lattice-crypto/task-runtime-signer-authorization/v1";
const PROJECTION_DOMAIN =
  "nautilo/lattice-crypto/task-runtime-signer-authorization-projection/v1";
const SIGNING_DOMAIN =
  "nautilo/lattice-crypto/task-runtime-signer-authorization-signature/v1";
const RESPONSE_DOMAIN =
  "nautilo/lattice-crypto/task-runtime-background-authorization-response/v2";
const CERTIFICATE_DOMAIN_V2 =
  "nautilo/lattice-crypto/task-runtime-signer-authorization/v2";
const PROJECTION_DOMAIN_V2 =
  "nautilo/lattice-crypto/task-runtime-signer-authorization-projection/v2";
const SIGNING_DOMAIN_V2 =
  "nautilo/lattice-crypto/task-runtime-signer-authorization-signature/v2";
export const TASK_RUNTIME_SIGNER_AUTHORIZATION_FORMAT_VERSION_V2 = 2 as const;
const HASH_BYTES = 32;
const MAX_ID_FRAME_BYTES = 4 + V2_LIMITS.idBytes;

export const MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V1 =
  4 + utf8V2(PROJECTION_DOMAIN).length + 4
  + 4 + utf8V2(TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1).length
  + 11 * MAX_ID_FRAME_BYTES + 10 * 8 + 6 * (4 + HASH_BYTES);

export const MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1 =
  4 + utf8V2(CERTIFICATE_DOMAIN).length + 4
  + 4 + utf8V2(TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1).length
  + 4 + MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V1
  + 4 + V2_LIMITS.signatureBytes;

// Publication replaces one bounded ID frame with a closed U32 work kind.
export const MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V2 =
  MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V1
  - MAX_ID_FRAME_BYTES + 4;
export const MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V2 =
  MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1 - MAX_ID_FRAME_BYTES + 4;

export const MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2 =
  4 + utf8V2(RESPONSE_DOMAIN).length + 4
  + 4 + DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2
  + 4 + MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1;

export interface TaskRuntimeSignerAuthorizationV1 {
  readonly formatVersion:
    typeof TASK_RUNTIME_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1;
  readonly purpose: typeof TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1;
  readonly projectionBytes: Uint8Array;
  readonly signature: Uint8Array;
}

export interface TaskRuntimeSignerAuthorizationProjectionV1 {
  readonly formatVersion: 1;
  readonly purpose: typeof TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1;
  readonly issuer: BackgroundAuthorizationIssuerV2;
  readonly request: Readonly<{
    requestId: string;
    recipientGeneration: number;
    recipientKeyId: string;
    policyRevision: number;
    issuedAt: number;
    deadlineAt: number;
    requestHash: Uint8Array;
    authorizationHash: Uint8Array;
  }>;
  readonly signer: Readonly<{
    agentId: string;
    runtimeGeneration: 0;
    signerKeyId: string;
    signerPublicKey: Uint8Array;
  }>;
  readonly work: Readonly<{
    taskId: string;
    taskRunId: string;
    inputObjectId: string;
    resultObjectId: string;
    executionSegment: number;
    workIdentityHash: Uint8Array;
  }>;
}

export type TaskRuntimeSignerAuthorizationIssuerContextV1 = Readonly<{
  issuer: BackgroundAuthorizationIssuerV2;
  projection: TaskRuntimeSignerAuthorizationProjectionV1;
}>;

export type ResolveCurrentTaskRuntimeSignerAuthorizationIssuerV1 = (
  context: TaskRuntimeSignerAuthorizationIssuerContextV1,
) => Promise<Uint8Array | null> | Uint8Array | null;

export type ResolveHistoricalTaskRuntimeSignerAuthorizationIssuerV1 = (
  context: TaskRuntimeSignerAuthorizationIssuerContextV1,
) => Uint8Array | null;

interface VerifiedTaskRuntimeSignerAuthorizationBaseV1 {
  readonly certificate: TaskRuntimeSignerAuthorizationV1;
  readonly certificateBytes: Uint8Array;
  readonly certificateHash: Uint8Array;
  readonly projection: TaskRuntimeSignerAuthorizationProjectionV1;
  readonly issuer: BackgroundAuthorizationIssuerV2;
}

export interface VerifiedCurrentTaskRuntimeSignerAuthorizationV1
  extends VerifiedTaskRuntimeSignerAuthorizationBaseV1 {
  readonly request: TaskRuntimeBackgroundAuthorizationRequestV2;
  readonly requestHash: Uint8Array;
}

export type VerifiedHistoricalTaskRuntimeSignerAuthorizationV1 =
  VerifiedTaskRuntimeSignerAuthorizationBaseV1;

export type VerifiedTaskRuntimeSignerAuthorizationV1 =
  | VerifiedCurrentTaskRuntimeSignerAuthorizationV1
  | VerifiedHistoricalTaskRuntimeSignerAuthorizationV1;

export type TaskRuntimeSignerAuthorizationV2 =
  Omit<TaskRuntimeSignerAuthorizationV1, "formatVersion"> & Readonly<{ formatVersion: 2 }>;
export type TaskRuntimeSignerAuthorizationProjectionV2 =
  Omit<TaskRuntimeSignerAuthorizationProjectionV1, "formatVersion" | "work">
  & Readonly<{ formatVersion: 2; work: TaskRuntimePublicationWorkBindingV3 }>;
export type TaskRuntimeSignerAuthorization =
  | TaskRuntimeSignerAuthorizationV1 | TaskRuntimeSignerAuthorizationV2;
export type TaskRuntimeSignerAuthorizationProjection =
  | TaskRuntimeSignerAuthorizationProjectionV1 | TaskRuntimeSignerAuthorizationProjectionV2;
export type TaskRuntimeCertifiedBackgroundAuthorizationRequest =
  | TaskRuntimeBackgroundAuthorizationRequestV2 | TaskRuntimeBackgroundAuthorizationRequestV3;
type CertifiedRequest = TaskRuntimeCertifiedBackgroundAuthorizationRequest;
export type TaskRuntimeSignerAuthorizationIssuerContext = Readonly<{
  issuer: BackgroundAuthorizationIssuerV2;
  projection: TaskRuntimeSignerAuthorizationProjection;
}>;
export type ResolveCurrentTaskRuntimeSignerAuthorizationIssuer = (
  context: TaskRuntimeSignerAuthorizationIssuerContext,
) => Promise<Uint8Array | null> | Uint8Array | null;
export type ResolveHistoricalTaskRuntimeSignerAuthorizationIssuer = (
  context: TaskRuntimeSignerAuthorizationIssuerContext,
) => Uint8Array | null;
export interface VerifiedHistoricalTaskRuntimeSignerAuthorization {
  readonly certificate: TaskRuntimeSignerAuthorization;
  readonly certificateBytes: Uint8Array;
  readonly certificateHash: Uint8Array;
  readonly projection: TaskRuntimeSignerAuthorizationProjection;
  readonly issuer: BackgroundAuthorizationIssuerV2;
}
export interface VerifiedCurrentTaskRuntimeSignerAuthorization
  extends VerifiedHistoricalTaskRuntimeSignerAuthorization {
  readonly request: CertifiedRequest;
  readonly requestHash: Uint8Array;
}
export type VerifiedTaskRuntimeSignerAuthorization =
  | VerifiedCurrentTaskRuntimeSignerAuthorization | VerifiedHistoricalTaskRuntimeSignerAuthorization;

function destroyRequest(request: CertifiedRequest): void {
  if (request.formatVersion === 3) destroyTaskRuntimeBackgroundAuthorizationRequestV3(request);
  else destroyTaskRuntimeBackgroundAuthorizationRequestV2(request);
}
function requestIssuer(request: CertifiedRequest): BackgroundAuthorizationIssuerV2 {
  return request.formatVersion === 3
    ? taskRuntimeBackgroundAuthorizationIssuerV3(request)
    : taskRuntimeBackgroundAuthorizationIssuerV2(request);
}
function decodeRequest(crypto: Pick<LatticeCrypto, "hash">, bytes: Uint8Array): CertifiedRequest | null {
  return isTaskRuntimeBackgroundAuthorizationRequestV3Carrier(bytes)
    ? decodeTaskRuntimeBackgroundAuthorizationRequestV3(crypto, bytes)
    : decodeTaskRuntimeBackgroundAuthorizationRequestV2(crypto, bytes);
}

export class TaskRuntimeSignerAuthorizationErrorV1 extends Error {
  override readonly name = "TaskRuntimeSignerAuthorizationErrorV1";
  constructor(readonly code: "invalid" | "expired" | "authority_unavailable") {
    super(`Task Runtime signer authorization ${code}`);
  }
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function ownedBytes(value: unknown, length?: number): Uint8Array {
  if (!(value instanceof Uint8Array)
    || (length !== undefined && value.length !== length)) {
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
  return copyOwnedBytesV2(value);
}

function signingBytes(projectionHash: Uint8Array, version: 1 | 2): Uint8Array {
  if (projectionHash.length !== HASH_BYTES) {
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
  return concatV2(
    frameText(version === 1 ? SIGNING_DOMAIN : SIGNING_DOMAIN_V2),
    encodeU32(version),
    frameText(TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1),
    frame(projectionHash),
  );
}

function projectionBytes(
  value: TaskRuntimeSignerAuthorizationProjection,
): Uint8Array {
  return concatV2(
    frameText(value.formatVersion === 1 ? PROJECTION_DOMAIN : PROJECTION_DOMAIN_V2), encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.issuer.humanId), frameText(value.issuer.deviceId),
    encodeU64(value.issuer.deviceGeneration),
    frameText(value.issuer.serverInstanceId),
    encodeU64(value.issuer.lineageGeneration), encodeU64(value.issuer.epoch),
    encodeU64(value.issuer.securityRevision), frame(value.issuer.headDigest),
    frame(value.issuer.signingPublicKeyHash),
    frameText(value.request.requestId),
    encodeU64(value.request.recipientGeneration),
    frameText(value.request.recipientKeyId),
    encodeU64(value.request.policyRevision), encodeU64(value.request.issuedAt),
    encodeU64(value.request.deadlineAt), frame(value.request.requestHash),
    frame(value.request.authorizationHash),
    frameText(value.signer.agentId), encodeU64(value.signer.runtimeGeneration),
    frameText(value.signer.signerKeyId), frame(value.signer.signerPublicKey),
    ...(value.formatVersion === 1 ? [
      frameText(value.work.taskId), frameText(value.work.taskRunId),
      frameText(value.work.inputObjectId), frameText(value.work.resultObjectId),
      encodeU64(value.work.executionSegment), frame(value.work.workIdentityHash),
    ] : [encodeTaskRuntimePublicationWorkBindingV3(value.work)]),
  );
}

function portable(value: string): string {
  assertPortableId("Task Runtime signer projection ID", value);
  return value;
}

function counter(value: number): number {
  assertU64Counter("Task Runtime signer projection counter", value);
  return value;
}

export function decodeTaskRuntimeSignerAuthorizationProjection(
  bytes: Uint8Array,
): TaskRuntimeSignerAuthorizationProjection {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1
    || bytes.length
      > MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V1) {
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
  try {
    const value = decodeExact(bytes, reader => {
      const domain = reader.readText(utf8V2(PROJECTION_DOMAIN).length);
      const version = domain === PROJECTION_DOMAIN ? 1
        : domain === PROJECTION_DOMAIN_V2 ? 2 : null;
      if (version === null) throw new Error("domain");
      reader.readVersion(version);
      if (reader.readText(utf8V2(TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1).length)
        !== TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1) throw new Error("purpose");
      const issuer = Object.freeze({
        humanId: portable(reader.readText(V2_LIMITS.idBytes)),
        deviceId: portable(reader.readText(V2_LIMITS.idBytes)),
        deviceGeneration: counter(reader.readU64()),
        serverInstanceId: portable(reader.readText(V2_LIMITS.idBytes)),
        lineageGeneration: counter(reader.readU64()),
        epoch: counter(reader.readU64()),
        securityRevision: counter(reader.readU64()),
        headDigest: reader.readFrame(HASH_BYTES),
        signingPublicKeyHash: reader.readFrame(HASH_BYTES),
      });
      const request = Object.freeze({
        requestId: portable(reader.readText(V2_LIMITS.idBytes)),
        recipientGeneration: counter(reader.readU64()),
        recipientKeyId: portable(reader.readText(V2_LIMITS.idBytes)),
        policyRevision: counter(reader.readU64()),
        issuedAt: counter(reader.readU64()), deadlineAt: counter(reader.readU64()),
        requestHash: reader.readFrame(HASH_BYTES),
        authorizationHash: reader.readFrame(HASH_BYTES),
      });
      const signer = Object.freeze({
        agentId: portable(reader.readText(V2_LIMITS.idBytes)),
        runtimeGeneration: counter(reader.readU64()),
        signerKeyId: portable(reader.readText(V2_LIMITS.idBytes)),
        signerPublicKey: reader.readFrame(V2_LIMITS.signingPublicKeyBytes),
      });
      const work = version === 2 ? readTaskRuntimePublicationWorkBindingV3(reader) : Object.freeze({
        taskId: portable(reader.readText(V2_LIMITS.idBytes)),
        taskRunId: portable(reader.readText(V2_LIMITS.idBytes)),
        inputObjectId: portable(reader.readText(V2_LIMITS.idBytes)),
        resultObjectId: portable(reader.readText(V2_LIMITS.idBytes)),
        executionSegment: counter(reader.readU64()),
        workIdentityHash: reader.readFrame(HASH_BYTES),
      });
      if ([issuer.headDigest, issuer.signingPublicKeyHash,
        request.requestHash, request.authorizationHash,
        signer.signerPublicKey, work.workIdentityHash].some(
        value => value.length !== HASH_BYTES,
      ) || signer.runtimeGeneration !== 0
        || ("executionSegment" in work && work.executionSegment < 1)
        || request.issuedAt >= request.deadlineAt) throw new Error("semantics");
      const common = { purpose: TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1,
        issuer, request, signer: Object.freeze({ ...signer, runtimeGeneration: 0 as const }) };
      if (version === 2 && "kind" in work) {
        return Object.freeze({ ...common, formatVersion: 2 as const, work });
      }
      if (version === 1 && "executionSegment" in work) {
        return Object.freeze({ ...common, formatVersion: 1 as const, work });
      }
      throw new Error("work version");
    });
    if (value.formatVersion === 2 && bytes.length
      > MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V2) throw new Error("size");
    const canonical = projectionBytes(value);
    const valid = same(canonical, bytes); canonical.fill(0);
    if (!valid) { destroyTaskRuntimeSignerAuthorizationProjection(value); throw new Error("canonical"); }
    return value;
  } catch (error) {
    if (error instanceof TaskRuntimeSignerAuthorizationErrorV1) throw error;
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
}

function certificateBytes(value: TaskRuntimeSignerAuthorization): Uint8Array {
  return concatV2(
    frameText(value.formatVersion === 1 ? CERTIFICATE_DOMAIN : CERTIFICATE_DOMAIN_V2), encodeU32(value.formatVersion),
    frameText(value.purpose), frame(value.projectionBytes), frame(value.signature),
  );
}

function decodeCertificate(bytes: Uint8Array, expectedVersion?: 1 | 2): TaskRuntimeSignerAuthorization {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1
    || bytes.length > MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1) {
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
  try {
    const value = decodeExact(bytes, reader => {
      const domain = reader.readText(utf8V2(CERTIFICATE_DOMAIN).length);
      const version = domain === CERTIFICATE_DOMAIN ? 1
        : domain === CERTIFICATE_DOMAIN_V2 ? 2 : null;
      if (version === null || (expectedVersion !== undefined && version !== expectedVersion)
        || (version === 2 && bytes.length > MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V2)) {
        throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
      }
      reader.readVersion(version);
      if (reader.readText(utf8V2(TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1).length)
        !== TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1) {
        throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
      }
      return Object.freeze({
        formatVersion: version,
        purpose: TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1,
        projectionBytes: reader.readFrame(
          version === 1 ? MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V1
            : MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_PROJECTION_WIRE_BYTES_V2,
        ),
        signature: reader.readFrame(V2_LIMITS.signatureBytes),
      });
    });
    const canonical = certificateBytes(value);
    const valid = same(canonical, bytes);
    canonical.fill(0);
    if (!valid) {
      destroyTaskRuntimeSignerAuthorization(value);
      throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
    }
    return value;
  } catch (error) {
    if (error instanceof TaskRuntimeSignerAuthorizationErrorV1) throw error;
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
}

function destroyContext(context: TaskRuntimeSignerAuthorizationIssuerContext): void {
  destroyTaskRuntimeSignerAuthorizationProjection(context.projection);
  context.issuer.headDigest.fill(0); context.issuer.signingPublicKeyHash.fill(0);
}

function copyContext(
  context: TaskRuntimeSignerAuthorizationIssuerContext,
): TaskRuntimeSignerAuthorizationIssuerContext {
  const encoded = projectionBytes(context.projection);
  const projection = decodeTaskRuntimeSignerAuthorizationProjection(encoded);
  encoded.fill(0);
  return Object.freeze({
    issuer: Object.freeze({
      ...context.issuer,
      headDigest: context.issuer.headDigest.slice(),
      signingPublicKeyHash: context.issuer.signingPublicKeyHash.slice(),
    }),
    projection,
  });
}

function verifyWithKey(
  crypto: LatticeCrypto,
  certificate: TaskRuntimeSignerAuthorization,
  projection: TaskRuntimeSignerAuthorizationProjection,
  key: Uint8Array,
): void {
  const publicKey = ownedBytes(key, V2_LIMITS.signingPublicKeyBytes);
  let material: Uint8Array | undefined;
  let keyHash: Uint8Array | undefined;
  try {
    if (certificate.formatVersion !== projection.formatVersion) {
      throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
    }
    keyHash = ownedBytes(crypto.hash(publicKey), HASH_BYTES);
    const encoded = projectionBytes(projection);
    const projectionHash = ownedBytes(crypto.hash(encoded), HASH_BYTES);
    encoded.fill(0);
    material = signingBytes(projectionHash, projection.formatVersion);
    projectionHash.fill(0);
    if (!same(keyHash, projection.issuer.signingPublicKeyHash)
      || !crypto.verify(publicKey, material, certificate.signature)) {
      throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
    }
  } finally {
    publicKey.fill(0);
    material?.fill(0);
    keyHash?.fill(0);
  }
}

function verifiedBase(
  crypto: LatticeCrypto,
  bytes: Uint8Array,
  certificate: TaskRuntimeSignerAuthorization,
  projection: TaskRuntimeSignerAuthorizationProjection,
): VerifiedHistoricalTaskRuntimeSignerAuthorization {
  const certificateBytesCopy = copyOwnedBytesV2(bytes);
  const result = Object.freeze({
    certificate,
    certificateBytes: certificateBytesCopy,
    certificateHash: ownedBytes(crypto.hash(certificateBytesCopy), HASH_BYTES),
    projection,
    issuer: Object.freeze({ ...projection.issuer,
      headDigest: projection.issuer.headDigest.slice(),
      signingPublicKeyHash: projection.issuer.signingPublicKeyHash.slice() }),
  });
  return result;
}

function assertGrantMatches(
  crypto: LatticeCrypto,
  request: CertifiedRequest,
  authorizationBytes: Uint8Array,
  expectedPlanBytes: Uint8Array,
  expectedAuthorizationHash: Uint8Array,
  issuerSigningPublicKey: Uint8Array,
): Uint8Array {
  const authorization = parseDomainForegroundAuthorizationV2(authorizationBytes);
  const expectedPlan = parseDomainForegroundAuthorizationPlanV2(expectedPlanBytes);
  if (authorization === null || expectedPlan === null) {
    if (authorization !== null) destroyDomainForegroundAuthorizationV2(authorization);
    if (expectedPlan !== null) destroyDomainForegroundAuthorizationPlanV2(expectedPlan);
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
  const hash = ownedBytes(crypto.hash(authorizationBytes), HASH_BYTES);
  try {
    const grantVerification = verifyDomainForegroundAuthorizationV2(crypto, {
      authorizationBytes,
      now: expectedPlan.issuedAt,
      expectedOperations: expectedPlan.operations.length === 1
        ? expectedPlan.operations[0] === "encrypt" ? ["encrypt"] : ["decrypt"]
        : ["decrypt", "encrypt"],
      current: {
        authorizationId: expectedPlan.authorizationId,
        policyRevision: expectedPlan.policyRevision,
        sessionId: expectedPlan.sessionId,
        roomId: expectedPlan.roomId,
        subjectHumanId: expectedPlan.subjectHumanId,
        committerDeviceId: expectedPlan.committerDeviceId,
        committerDeviceSigningGeneration:
          expectedPlan.committerDeviceSigningGeneration,
        committerDeviceSigningPublicKey: issuerSigningPublicKey,
        committerDeviceActive: true,
        hostAuthorizationRevision: expectedPlan.hostAuthorizationRevision,
        recipientKind: expectedPlan.recipientKind,
        recipientPrincipalId: expectedPlan.recipientPrincipalId,
        recipientAuthorizationRevision:
          expectedPlan.recipientAuthorizationRevision,
        recipientRuntimeGeneration: expectedPlan.recipientRuntimeGeneration,
        recipientKeyId: expectedPlan.recipientKeyId,
        recipientAuthorized: true,
        domains: expectedPlan.domains,
      },
    });
    if (grantVerification.status !== "verified"
      || authorization.authorizationId !== request.baseRequest.requestId
      || !same(authorization.planBytes, request.baseRequest.authorizationPlanBytes)
      || !same(authorization.planBytes, expectedPlanBytes)
      || !same(hash, expectedAuthorizationHash)) {
      throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
    }
    return hash.slice();
  } finally {
    hash.fill(0);
    destroyDomainForegroundAuthorizationV2(authorization);
    destroyDomainForegroundAuthorizationPlanV2(expectedPlan);
  }
}

function deriveProjection(
  crypto: Pick<LatticeCrypto, "hash">,
  request: CertifiedRequest,
  requestBytes: Uint8Array,
  authorizationHash: Uint8Array,
): TaskRuntimeSignerAuthorizationProjection {
  const plan = parseDomainForegroundAuthorizationPlanV2(
    request.baseRequest.authorizationPlanBytes,
  );
  if (plan === null) throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  try {
    const common = {
      purpose: TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1,
      issuer: requestIssuer(request),
      request: Object.freeze({
        requestId: request.baseRequest.requestId,
        recipientGeneration: request.baseRequest.recipientGeneration,
        recipientKeyId: request.baseRequest.recipientKeyId,
        policyRevision: plan.policyRevision,
        issuedAt: request.baseRequest.issuedAt,
        deadlineAt: request.baseRequest.deadlineAt,
        requestHash: ownedBytes(crypto.hash(requestBytes), HASH_BYTES),
        authorizationHash: ownedBytes(authorizationHash, HASH_BYTES),
      }),
      signer: Object.freeze({
        ...request.signer,
        signerPublicKey: request.signer.signerPublicKey.slice(),
      }),
    };
    return request.formatVersion === 3
      ? Object.freeze({ ...common, formatVersion: 2 as const,
        work: Object.freeze({ ...request.work, workIdentityHash: request.work.workIdentityHash.slice() }) })
      : Object.freeze({ ...common, formatVersion: 1 as const,
        work: Object.freeze({ ...request.work, workIdentityHash: request.work.workIdentityHash.slice() }) });
  } finally {
    destroyDomainForegroundAuthorizationPlanV2(plan);
  }
}

export function createTaskRuntimeSignerAuthorization(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    authorizationBytes: Uint8Array;
    expectedAuthorizationPlanBytes: Uint8Array;
    expectedAuthorizationHash: Uint8Array;
    issuerSigningPrivateKey: Uint8Array;
  }>,
  expectedVersion?: 1 | 2,
): Uint8Array {
  const requestBytes = copyOwnedBytesV2(input.requestBytes);
  const request = decodeRequest(
    crypto,
    requestBytes,
  );
  if (request === null || (expectedVersion !== undefined
    && request.formatVersion !== expectedVersion + 1)) {
    if (request !== null) destroyRequest(request);
    requestBytes.fill(0);
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
  let privateKey: Uint8Array | undefined;
  let authorizationHash: Uint8Array | undefined;
  let projection: TaskRuntimeSignerAuthorizationProjection | undefined;
  let encodedProjection: Uint8Array | undefined;
  let projectionHash: Uint8Array | undefined;
  let material: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  let publicKey: Uint8Array | undefined;
  let publicKeyHash: Uint8Array | undefined;
  try {
    privateKey = ownedBytes(
      input.issuerSigningPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    const issuerPublicKey = ed25519.getPublicKey(privateKey);
    publicKey = ownedBytes(
      issuerPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    authorizationHash = assertGrantMatches(
      crypto,
      request,
      input.authorizationBytes,
      input.expectedAuthorizationPlanBytes,
      input.expectedAuthorizationHash,
      publicKey,
    );
    publicKeyHash = ownedBytes(crypto.hash(publicKey), HASH_BYTES);
    const issuer = requestIssuer(request);
    try {
      if (!same(publicKeyHash, issuer.signingPublicKeyHash)) {
        throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
      }
    } finally {
      issuer.headDigest.fill(0);
      issuer.signingPublicKeyHash.fill(0);
    }
    projection = deriveProjection(
      crypto, request, requestBytes, authorizationHash,
    );
    encodedProjection = projectionBytes(projection);
    projectionHash = ownedBytes(crypto.hash(encodedProjection), HASH_BYTES);
    material = signingBytes(projectionHash, projection.formatVersion);
    signature = ownedBytes(crypto.sign(privateKey, material), V2_LIMITS.signatureBytes);
    const encoded = certificateBytes(Object.freeze({
      formatVersion: projection.formatVersion,
      purpose: TASK_RUNTIME_SIGNER_AUTHORIZATION_PURPOSE_V1,
      projectionBytes: encodedProjection,
      signature,
    }));
    if (encoded.length > MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1) {
      encoded.fill(0);
      throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
    }
    return encoded;
  } finally {
    destroyRequest(request);
    requestBytes.fill(0);
    privateKey?.fill(0);
    authorizationHash?.fill(0);
    if (projection !== undefined) {
      destroyTaskRuntimeSignerAuthorizationProjection(projection);
    }
    encodedProjection?.fill(0);
    projectionHash?.fill(0);
    material?.fill(0);
    signature?.fill(0);
    publicKey?.fill(0);
    publicKeyHash?.fill(0);
  }
}

/**
 * Reads the issuer coordinates needed to locate a retained Device key.
 *
 * The returned tuple is an untrusted, detached hint until a current or
 * historical verifier authenticates the complete certificate with that key.
 */
export function readTaskRuntimeSignerAuthorizationIssuer(
  _crypto: Pick<LatticeCrypto, "hash">,
  certificateBytesInput: Uint8Array,
  expectedVersion?: 1 | 2,
): BackgroundAuthorizationIssuerV2 {
  const certificate = decodeCertificate(certificateBytesInput, expectedVersion);
  let projection: TaskRuntimeSignerAuthorizationProjection | undefined;
  try {
    projection = decodeTaskRuntimeSignerAuthorizationProjection(
      certificate.projectionBytes,
    );
    if (certificate.formatVersion !== projection.formatVersion) {
      throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
    }
    return Object.freeze({ ...projection.issuer,
      headDigest: projection.issuer.headDigest.slice(),
      signingPublicKeyHash: projection.issuer.signingPublicKeyHash.slice() });
  } finally {
    if (projection !== undefined) {
      destroyTaskRuntimeSignerAuthorizationProjection(projection);
    }
    destroyTaskRuntimeSignerAuthorization(certificate);
  }
}

export function verifyHistoricalTaskRuntimeSignerAuthorization(
  crypto: LatticeCrypto,
  input: Readonly<{
    certificateBytes: Uint8Array;
    resolveHistoricalIssuer:
      ResolveHistoricalTaskRuntimeSignerAuthorizationIssuer;
  }>,
  expectedVersion?: 1 | 2,
): VerifiedHistoricalTaskRuntimeSignerAuthorization {
  const bytes = copyOwnedBytesV2(input.certificateBytes);
  let certificate: TaskRuntimeSignerAuthorization | undefined;
  let context: TaskRuntimeSignerAuthorizationIssuerContext | undefined;
  let key: Uint8Array | null = null;
  let callbackContext: TaskRuntimeSignerAuthorizationIssuerContext | undefined;
  try {
    certificate = decodeCertificate(bytes, expectedVersion);
    const projection = decodeTaskRuntimeSignerAuthorizationProjection(
      certificate.projectionBytes,
    );
    context = Object.freeze({ issuer: Object.freeze({ ...projection.issuer,
      headDigest: projection.issuer.headDigest.slice(),
      signingPublicKeyHash: projection.issuer.signingPublicKeyHash.slice() }),
    projection });
    callbackContext = copyContext(context);
    key = input.resolveHistoricalIssuer(callbackContext);
    if (key === null) {
      throw new TaskRuntimeSignerAuthorizationErrorV1("authority_unavailable");
    }
    verifyWithKey(crypto, certificate, context.projection, key);
    const result = verifiedBase(
      crypto, bytes, certificate, context.projection,
    );
    certificate = undefined;
    context.issuer.headDigest.fill(0);
    context.issuer.signingPublicKeyHash.fill(0);
    context = undefined;
    return result;
  } catch (error) {
    if (context !== undefined) destroyContext(context);
    if (certificate !== undefined) {
      destroyTaskRuntimeSignerAuthorization(certificate);
    }
    if (error instanceof TaskRuntimeSignerAuthorizationErrorV1) throw error;
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  } finally {
    if (callbackContext !== undefined) destroyContext(callbackContext);
    bytes.fill(0);
  }
}

export async function verifyCurrentTaskRuntimeSignerAuthorization(
  crypto: LatticeCrypto,
  input: Readonly<{
    certificateBytes: Uint8Array;
    requestBytes: Uint8Array;
    expectedRequestHash?: Uint8Array;
    expectedAuthorizationHash: Uint8Array;
    now: number;
    resolveCurrentIssuer: ResolveCurrentTaskRuntimeSignerAuthorizationIssuer;
  }>,
  expectedVersion?: 1 | 2,
): Promise<VerifiedCurrentTaskRuntimeSignerAuthorization> {
  assertU64Counter("Task Runtime signer authorization verification time", input.now);
  const requestBytes = copyOwnedBytesV2(input.requestBytes);
  const expectedRequestHash = input.expectedRequestHash === undefined
    ? undefined : ownedBytes(input.expectedRequestHash, HASH_BYTES);
  const expectedAuthorizationHash = ownedBytes(
    input.expectedAuthorizationHash, HASH_BYTES,
  );
  const bytes = copyOwnedBytesV2(input.certificateBytes);
  let certificate: TaskRuntimeSignerAuthorization | undefined;
  let context: TaskRuntimeSignerAuthorizationIssuerContext | undefined;
  let callbackContext: TaskRuntimeSignerAuthorizationIssuerContext | undefined;
  let request: CertifiedRequest | null = null;
  let derived: TaskRuntimeSignerAuthorizationProjection | undefined;
  try {
    certificate = decodeCertificate(bytes, expectedVersion);
    const projection = decodeTaskRuntimeSignerAuthorizationProjection(
      certificate.projectionBytes,
    );
    request = decodeRequest(
      crypto, requestBytes,
    );
    if (request === null || certificate.formatVersion !== request.formatVersion - 1) {
      throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
    }
    derived = deriveProjection(
      crypto, request, requestBytes, expectedAuthorizationHash,
    );
    const encodedProjection = projectionBytes(projection);
    const encodedDerived = projectionBytes(derived);
    const sameProjection = same(encodedProjection, encodedDerived);
    encodedProjection.fill(0); encodedDerived.fill(0);
    if (!sameProjection
      || (expectedRequestHash !== undefined
        && !same(derived.request.requestHash, expectedRequestHash))) {
      throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
    }
    destroyTaskRuntimeSignerAuthorizationProjection(derived);
    derived = undefined;
    context = Object.freeze({ issuer: Object.freeze({ ...projection.issuer,
      headDigest: projection.issuer.headDigest.slice(),
      signingPublicKeyHash: projection.issuer.signingPublicKeyHash.slice() }),
    projection });
    if (input.now < projection.request.issuedAt
      || input.now >= projection.request.deadlineAt) {
      throw new TaskRuntimeSignerAuthorizationErrorV1("expired");
    }
    callbackContext = copyContext(context);
    const key = await input.resolveCurrentIssuer(callbackContext);
    if (key === null) {
      throw new TaskRuntimeSignerAuthorizationErrorV1("authority_unavailable");
    }
    verifyWithKey(crypto, certificate, context.projection, key);
    const base = verifiedBase(crypto, bytes, certificate, context.projection);
    const result: VerifiedCurrentTaskRuntimeSignerAuthorization =
      Object.freeze({ ...base, request,
        requestHash: base.projection.request.requestHash.slice() });
    certificate = undefined;
    context.issuer.headDigest.fill(0);
    context.issuer.signingPublicKeyHash.fill(0);
    context = undefined;
    request = null;
    return result;
  } catch (error) {
    if (context !== undefined) destroyContext(context);
    if (certificate !== undefined) {
      destroyTaskRuntimeSignerAuthorization(certificate);
    }
    if (request !== null) destroyRequest(request);
    if (derived !== undefined) {
      destroyTaskRuntimeSignerAuthorizationProjection(derived);
    }
    if (error instanceof TaskRuntimeSignerAuthorizationErrorV1) throw error;
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  } finally {
    if (callbackContext !== undefined) destroyContext(callbackContext);
    bytes.fill(0);
    requestBytes.fill(0);
    expectedRequestHash?.fill(0);
    expectedAuthorizationHash.fill(0);
  }
}

export function encodeTaskRuntimeBackgroundAuthorizationResponseV2(
  value: Readonly<{ authorizationBytes: Uint8Array; certificateBytes: Uint8Array }>,
): Uint8Array {
  if (Object.keys(value).sort().join(",")
      !== "authorizationBytes,certificateBytes"
    || !(value.authorizationBytes instanceof Uint8Array)
    || value.authorizationBytes.length < 1
    || value.authorizationBytes.length
      > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2
    || !(value.certificateBytes instanceof Uint8Array)
    || value.certificateBytes.length < 1
    || value.certificateBytes.length
      > MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1) {
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
  return concatV2(
    frameText(RESPONSE_DOMAIN), encodeU32(2),
    frame(value.authorizationBytes), frame(value.certificateBytes),
  );
}

export function decodeTaskRuntimeBackgroundAuthorizationResponseV2(
  bytes: Uint8Array,
): Readonly<{ authorizationBytes: Uint8Array; certificateBytes: Uint8Array }> {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1
    || bytes.length
      > MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2) {
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
  try {
    const value = decodeExact(bytes, reader => {
      if (reader.readText(utf8V2(RESPONSE_DOMAIN).length) !== RESPONSE_DOMAIN) {
        throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
      }
      reader.readVersion(2);
      return Object.freeze({
        authorizationBytes: reader.readFrame(
          DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2,
        ),
        certificateBytes: reader.readFrame(
          MAX_TASK_RUNTIME_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
        ),
      });
    });
    const canonical = encodeTaskRuntimeBackgroundAuthorizationResponseV2(value);
    const valid = same(canonical, bytes);
    canonical.fill(0);
    if (!valid) {
      value.authorizationBytes.fill(0);
      value.certificateBytes.fill(0);
      throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
    }
    return value;
  } catch (error) {
    if (error instanceof TaskRuntimeSignerAuthorizationErrorV1) throw error;
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
}

function destroyTaskRuntimeSignerAuthorization(
  value: TaskRuntimeSignerAuthorization,
): void {
  value.projectionBytes.fill(0);
  value.signature.fill(0);
}

export function destroyTaskRuntimeSignerAuthorizationProjection(
  value: TaskRuntimeSignerAuthorizationProjection,
): void {
  value.issuer.headDigest.fill(0);
  value.issuer.signingPublicKeyHash.fill(0);
  value.request.requestHash.fill(0);
  value.request.authorizationHash.fill(0);
  value.signer.signerPublicKey.fill(0);
  value.work.workIdentityHash.fill(0);
}

export function destroyVerifiedTaskRuntimeSignerAuthorization(
  value: VerifiedTaskRuntimeSignerAuthorization,
): void {
  destroyTaskRuntimeSignerAuthorization(value.certificate);
  value.certificateBytes.fill(0);
  value.certificateHash.fill(0);
  destroyTaskRuntimeSignerAuthorizationProjection(value.projection);
  if ("request" in value) {
    destroyRequest(value.request);
    value.requestHash.fill(0);
  }
  value.issuer.headDigest.fill(0);
  value.issuer.signingPublicKeyHash.fill(0);
}

// Strict versioned entry points retain the execution-only API and byte contract.
export function decodeTaskRuntimeSignerAuthorizationProjectionV1(bytes: Uint8Array): TaskRuntimeSignerAuthorizationProjectionV1 {
  const value = decodeTaskRuntimeSignerAuthorizationProjection(bytes);
  if (value.formatVersion !== 1) {
    destroyTaskRuntimeSignerAuthorizationProjection(value);
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
  return value;
}
export function decodeTaskRuntimeSignerAuthorizationProjectionV2(bytes: Uint8Array): TaskRuntimeSignerAuthorizationProjectionV2 {
  const value = decodeTaskRuntimeSignerAuthorizationProjection(bytes);
  if (value.formatVersion !== 2) {
    destroyTaskRuntimeSignerAuthorizationProjection(value);
    throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
  }
  return value;
}
export function createTaskRuntimeSignerAuthorizationV1(
  crypto: LatticeCrypto, input: Parameters<typeof createTaskRuntimeSignerAuthorization>[1],
): Uint8Array { return createTaskRuntimeSignerAuthorization(crypto, input, 1); }
export function createTaskRuntimeSignerAuthorizationV2(
  crypto: LatticeCrypto, input: Parameters<typeof createTaskRuntimeSignerAuthorization>[1],
): Uint8Array { return createTaskRuntimeSignerAuthorization(crypto, input, 2); }
export function readTaskRuntimeSignerAuthorizationIssuerV1(
  crypto: Pick<LatticeCrypto, "hash">, bytes: Uint8Array,
): BackgroundAuthorizationIssuerV2 { return readTaskRuntimeSignerAuthorizationIssuer(crypto, bytes, 1); }
export function readTaskRuntimeSignerAuthorizationIssuerV2(
  crypto: Pick<LatticeCrypto, "hash">, bytes: Uint8Array,
): BackgroundAuthorizationIssuerV2 { return readTaskRuntimeSignerAuthorizationIssuer(crypto, bytes, 2); }
export function verifyHistoricalTaskRuntimeSignerAuthorizationV1(
  crypto: LatticeCrypto,
  input: Readonly<{certificateBytes: Uint8Array; resolveHistoricalIssuer: ResolveHistoricalTaskRuntimeSignerAuthorizationIssuerV1}>,
): VerifiedHistoricalTaskRuntimeSignerAuthorizationV1 {
  return verifyHistoricalTaskRuntimeSignerAuthorization(crypto, {
    ...input, resolveHistoricalIssuer: context => {
      if (context.projection.formatVersion !== 1) throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
      return input.resolveHistoricalIssuer({ ...context, projection: context.projection });
    },
  }, 1) as VerifiedHistoricalTaskRuntimeSignerAuthorizationV1;
}
export async function verifyCurrentTaskRuntimeSignerAuthorizationV1(
  crypto: LatticeCrypto,
  input: Omit<Parameters<typeof verifyCurrentTaskRuntimeSignerAuthorization>[1], "resolveCurrentIssuer"> & Readonly<{
    resolveCurrentIssuer: ResolveCurrentTaskRuntimeSignerAuthorizationIssuerV1;
  }>,
): Promise<VerifiedCurrentTaskRuntimeSignerAuthorizationV1> {
  return await verifyCurrentTaskRuntimeSignerAuthorization(crypto, {
    ...input, resolveCurrentIssuer: context => {
      if (context.projection.formatVersion !== 1) throw new TaskRuntimeSignerAuthorizationErrorV1("invalid");
      return input.resolveCurrentIssuer({ ...context, projection: context.projection });
    },
  }, 1) as VerifiedCurrentTaskRuntimeSignerAuthorizationV1;
}
export function destroyTaskRuntimeSignerAuthorizationV1(value: TaskRuntimeSignerAuthorizationV1): void {
  destroyTaskRuntimeSignerAuthorization(value);
}
export function destroyTaskRuntimeSignerAuthorizationProjectionV1(value: TaskRuntimeSignerAuthorizationProjectionV1): void {
  destroyTaskRuntimeSignerAuthorizationProjection(value);
}
export function destroyVerifiedTaskRuntimeSignerAuthorizationV1(value: VerifiedTaskRuntimeSignerAuthorizationV1): void {
  destroyVerifiedTaskRuntimeSignerAuthorization(value);
}
