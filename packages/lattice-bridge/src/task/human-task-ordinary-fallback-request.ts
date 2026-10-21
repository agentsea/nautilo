import { sha256 } from "@noble/hashes/sha2.js";
import {
  LATTICE_LIMITS,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import { HUMAN_TASK_PUBLICATION_REQUEST_MAX_TTL_MS_V1 } from
  "@nautilo/lattice-crypto/wire";
import { decodeTaskDefinitionContent } from "./task-payload-v1.ts";

const DOMAIN = "nautilo/task/human-ordinary-fallback/v1";
const PLAN_DOMAIN = "nautilo/task/human-ordinary-fallback-plan/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface HumanTaskOrdinaryFallbackUnsignedRequestV1 {
  readonly formatVersion: 1;
  readonly purpose:
    | "task.ordinary_fallback.create"
    | "task.ordinary_fallback.update";
  readonly reason: "target_encryption_not_ready";
  readonly operationId: string;
  readonly taskId: string;
  readonly planDigest: Uint8Array;
  readonly sourceDigest: Uint8Array;
  readonly operationalFieldsDigest: Uint8Array;
  readonly expectedContentRevision: number;
  readonly expectedCryptoAccessRevision: number;
  readonly expectedUpdatedAt: string | null;
  readonly taskDefinitionContentDigest: Uint8Array;
  readonly policyRevision: number;
  readonly subjectHumanId: string;
  readonly committerDeviceId: string;
  readonly committerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: number;
  readonly planIssuedAt: number;
  readonly planDeadlineAt: number;
  readonly issuedAt: number;
  readonly deadlineAt: number;
}

export type HumanTaskOrdinaryFallbackPlanV1 = Readonly<Omit<
  HumanTaskOrdinaryFallbackUnsignedRequestV1,
  | "planDigest"
  | "taskDefinitionContentDigest"
  | "issuedAt"
  | "deadlineAt"
>>;

export interface HumanTaskOrdinaryFallbackRequestV1
  extends HumanTaskOrdinaryFallbackUnsignedRequestV1 {
  readonly signature: Uint8Array;
}

export type AuthenticatedHumanTaskOrdinaryFallbackRequestV1 = Readonly<{
  request: HumanTaskOrdinaryFallbackRequestV1;
  requestDigest: Uint8Array;
}>;

declare const replayAdmissionBrand: unique symbol;
export type HumanTaskOrdinaryFallbackReplayAdmissionV1 = Readonly<{
  [replayAdmissionBrand]: true;
}>;

const replayAdmissions = new WeakMap<object, Readonly<{
  operationId: string;
  taskId: string;
  requestDigest: Uint8Array;
}>>();

const UNSIGNED_FIELDS = [
  "formatVersion", "purpose", "reason", "operationId", "taskId",
  "planDigest", "sourceDigest", "operationalFieldsDigest",
  "expectedContentRevision", "expectedCryptoAccessRevision",
  "expectedUpdatedAt", "taskDefinitionContentDigest", "policyRevision",
  "subjectHumanId", "committerDeviceId",
  "committerDeviceSigningKeyGeneration", "hostAuthorizationRevision",
  "planIssuedAt", "planDeadlineAt", "issuedAt", "deadlineAt",
] as const;
const PLAN_FIELDS = UNSIGNED_FIELDS.filter((field) =>
  field !== "planDigest"
  && field !== "taskDefinitionContentDigest"
  && field !== "issuedAt"
  && field !== "deadlineAt"
);

export function createHumanTaskOrdinaryFallbackReplayAdmissionV1(
  input: Readonly<{
    operationId: string;
    taskId: string;
    requestDigest: Uint8Array;
  }>,
): HumanTaskOrdinaryFallbackReplayAdmissionV1 {
  if (!validPortable(input.operationId) || !validUuid(input.taskId)
    || !(input.requestDigest instanceof Uint8Array)
    || input.requestDigest.length !== 32) {
    throw new TypeError("Human Task ordinary fallback replay admission is invalid");
  }
  const token = Object.freeze({}) as HumanTaskOrdinaryFallbackReplayAdmissionV1;
  replayAdmissions.set(token, Object.freeze({
    operationId: input.operationId,
    taskId: input.taskId,
    requestDigest: input.requestDigest.slice(),
  }));
  return token;
}

function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validPortable(value: unknown): value is string {
  return typeof value === "string" && PORTABLE.test(value)
    && encoder.encode(value).length <= LATTICE_LIMITS.idBytes;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function exactFields(value: object, fields: readonly string[]): void {
  if (typeof value !== "object" || value === null
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== fields.length
    || Reflect.ownKeys(value).some((key) =>
      typeof key !== "string" || !fields.includes(key))
    || fields.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !descriptor.enumerable
        || !("value" in descriptor);
    })) {
    throw new TypeError("Human Task ordinary fallback fields are invalid");
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(value: unknown, length: number): Uint8Array {
  if (typeof value !== "string" || value.length !== length * 2
    || !/^[0-9a-f]+$/u.test(value)) {
    throw new TypeError("Human Task ordinary fallback bytes are invalid");
  }
  return Uint8Array.from({ length }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function exactBytes(value: unknown, length: number): boolean {
  return value instanceof Uint8Array && value.length === length;
}

export function fingerprintHumanTaskOrdinaryFallbackPlanV1(
  plan: HumanTaskOrdinaryFallbackPlanV1,
): Uint8Array {
  exactFields(plan, PLAN_FIELDS);
  assertRequest({
    ...plan,
    planDigest: new Uint8Array(32),
    taskDefinitionContentDigest: new Uint8Array(32),
    issuedAt: plan.planIssuedAt,
    deadlineAt: plan.planDeadlineAt,
    signature: new Uint8Array(64),
  });
  return sha256(encoder.encode(JSON.stringify([
    PLAN_DOMAIN, plan.formatVersion, plan.purpose, plan.reason,
    plan.operationId, plan.taskId, hex(plan.sourceDigest),
    hex(plan.operationalFieldsDigest), plan.expectedContentRevision,
    plan.expectedCryptoAccessRevision, plan.expectedUpdatedAt,
    plan.policyRevision, plan.subjectHumanId, plan.committerDeviceId,
    plan.committerDeviceSigningKeyGeneration, plan.hostAuthorizationRevision,
    plan.planIssuedAt, plan.planDeadlineAt,
  ])));
}

export function fingerprintHumanTaskOrdinaryFallbackContentV1(
  contentBytes: Uint8Array,
): Uint8Array {
  try {
    decodeTaskDefinitionContent(contentBytes);
  } catch {
    throw new TypeError("Human Task ordinary fallback content is invalid");
  }
  return sha256(contentBytes);
}

function assertRequest(value: HumanTaskOrdinaryFallbackRequestV1): void {
  exactFields(value, [...UNSIGNED_FIELDS, "signature"]);
  const create = value.purpose === "task.ordinary_fallback.create";
  if (value.formatVersion !== 1
    || (!create && value.purpose !== "task.ordinary_fallback.update")
    || value.reason !== "target_encryption_not_ready"
    || !validPortable(value.operationId) || !validUuid(value.taskId)
    || !exactBytes(value.planDigest, 32) || !exactBytes(value.sourceDigest, 32)
    || !exactBytes(value.operationalFieldsDigest, 32)
    || !exactBytes(value.taskDefinitionContentDigest, 32)
    || !validCounter(value.expectedContentRevision)
    || !validCounter(value.expectedCryptoAccessRevision)
    || (create && (value.expectedContentRevision !== 0
      || value.expectedCryptoAccessRevision !== 0
      || value.expectedUpdatedAt !== null))
    || (!create && !validIsoTimestamp(value.expectedUpdatedAt))
    || !validCounter(value.policyRevision) || value.policyRevision < 1
    || !validPortable(value.subjectHumanId)
    || !validPortable(value.committerDeviceId)
    || !validCounter(value.committerDeviceSigningKeyGeneration)
    || value.committerDeviceSigningKeyGeneration < 1
    || !validCounter(value.hostAuthorizationRevision)
    || !validCounter(value.planIssuedAt) || !validCounter(value.planDeadlineAt)
    || value.planDeadlineAt <= value.planIssuedAt
    || value.planDeadlineAt - value.planIssuedAt
      > HUMAN_TASK_PUBLICATION_REQUEST_MAX_TTL_MS_V1
    || !validCounter(value.issuedAt) || !validCounter(value.deadlineAt)
    || value.deadlineAt <= value.issuedAt
    || value.deadlineAt - value.issuedAt
      > HUMAN_TASK_PUBLICATION_REQUEST_MAX_TTL_MS_V1
    || value.issuedAt < value.planIssuedAt
    || value.deadlineAt > value.planDeadlineAt
    || !exactBytes(value.signature, 64)) {
    throw new TypeError("Human Task ordinary fallback request is invalid");
  }
}

function wire(value: HumanTaskOrdinaryFallbackRequestV1): readonly unknown[] {
  return [DOMAIN, value.formatVersion, value.purpose, value.reason,
    value.operationId, value.taskId, hex(value.planDigest),
    hex(value.sourceDigest), hex(value.operationalFieldsDigest),
    value.expectedContentRevision, value.expectedCryptoAccessRevision,
    value.expectedUpdatedAt, hex(value.taskDefinitionContentDigest),
    value.policyRevision, value.subjectHumanId, value.committerDeviceId,
    value.committerDeviceSigningKeyGeneration, value.hostAuthorizationRevision,
    value.planIssuedAt, value.planDeadlineAt, value.issuedAt, value.deadlineAt,
    hex(value.signature)];
}

function signingBytes(
  value: HumanTaskOrdinaryFallbackUnsignedRequestV1,
): Uint8Array {
  return encoder.encode(JSON.stringify(wire({
    ...value,
    signature: new Uint8Array(64),
  }).slice(0, -1)));
}

export function encodeHumanTaskOrdinaryFallbackRequestV1(
  value: HumanTaskOrdinaryFallbackRequestV1,
): Uint8Array {
  assertRequest(value);
  const bytes = encoder.encode(JSON.stringify(wire(value)));
  if (bytes.length > LATTICE_LIMITS.plaintextBytes) {
    bytes.fill(0);
    throw new RangeError(
      "Human Task ordinary fallback request exceeds its wire limit",
    );
  }
  return bytes;
}

export function decodeHumanTaskOrdinaryFallbackRequestV1(
  bytes: Uint8Array,
): HumanTaskOrdinaryFallbackRequestV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0
    || bytes.length > LATTICE_LIMITS.plaintextBytes) {
    throw new TypeError("Human Task ordinary fallback wire is invalid");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new TypeError("Human Task ordinary fallback wire is invalid");
  }
  if (!Array.isArray(raw) || raw.length !== 23 || raw[0] !== DOMAIN) {
    throw new TypeError("Human Task ordinary fallback wire is invalid");
  }
  const fields = raw as readonly unknown[];
  const value = {
    formatVersion: fields[1], purpose: fields[2], reason: fields[3],
    operationId: fields[4], taskId: fields[5],
    planDigest: fromHex(fields[6], 32), sourceDigest: fromHex(fields[7], 32),
    operationalFieldsDigest: fromHex(fields[8], 32),
    expectedContentRevision: fields[9], expectedCryptoAccessRevision: fields[10],
    expectedUpdatedAt: fields[11],
    taskDefinitionContentDigest: fromHex(fields[12], 32),
    policyRevision: fields[13], subjectHumanId: fields[14],
    committerDeviceId: fields[15], committerDeviceSigningKeyGeneration: fields[16],
    hostAuthorizationRevision: fields[17], planIssuedAt: fields[18],
    planDeadlineAt: fields[19], issuedAt: fields[20], deadlineAt: fields[21],
    signature: fromHex(fields[22], 64),
  } as HumanTaskOrdinaryFallbackRequestV1;
  assertRequest(value);
  const canonical = encodeHumanTaskOrdinaryFallbackRequestV1(value);
  if (canonical.length !== bytes.length
    || canonical.some((entry, index) => entry !== bytes[index])) {
    throw new TypeError("Human Task ordinary fallback wire is noncanonical");
  }
  return Object.freeze({
    ...value,
    planDigest: value.planDigest.slice(),
    sourceDigest: value.sourceDigest.slice(),
    operationalFieldsDigest: value.operationalFieldsDigest.slice(),
    taskDefinitionContentDigest: value.taskDefinitionContentDigest.slice(),
    signature: value.signature.slice(),
  });
}

export function digestHumanTaskOrdinaryFallbackRequestV1(
  bytes: Uint8Array,
): Uint8Array {
  decodeHumanTaskOrdinaryFallbackRequestV1(bytes);
  return sha256(bytes);
}

export function prepareHumanTaskOrdinaryFallbackRequestV1(
  crypto: LatticeCrypto,
  input: HumanTaskOrdinaryFallbackUnsignedRequestV1 & Readonly<{
    signingPrivateKey: Uint8Array;
  }>,
): Readonly<{ request: HumanTaskOrdinaryFallbackRequestV1; bytes: Uint8Array }> {
  const { signingPrivateKey, ...unsigned } = input;
  const signed = signingBytes(unsigned);
  try {
    const request = {
      ...unsigned,
      planDigest: unsigned.planDigest.slice(),
      sourceDigest: unsigned.sourceDigest.slice(),
      operationalFieldsDigest: unsigned.operationalFieldsDigest.slice(),
      taskDefinitionContentDigest: unsigned.taskDefinitionContentDigest.slice(),
      signature: crypto.sign(signingPrivateKey, signed),
    };
    const bytes = encodeHumanTaskOrdinaryFallbackRequestV1(request);
    return Object.freeze({
      request: decodeHumanTaskOrdinaryFallbackRequestV1(bytes),
      bytes,
    });
  } finally {
    signed.fill(0);
  }
}

export function verifyHumanTaskOrdinaryFallbackRequestV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    signingPublicKey: Uint8Array;
    now: number;
    replayAdmission?: HumanTaskOrdinaryFallbackReplayAdmissionV1;
  }>,
): AuthenticatedHumanTaskOrdinaryFallbackRequestV1 {
  const request = decodeHumanTaskOrdinaryFallbackRequestV1(input.requestBytes);
  const requestDigest = sha256(input.requestBytes);
  const replay = input.replayAdmission === undefined ? undefined
    : replayAdmissions.get(input.replayAdmission);
  const signed = signingBytes(request);
  try {
    if (input.replayAdmission !== undefined && (replay === undefined
      || replay.operationId !== request.operationId
      || replay.taskId !== request.taskId
      || replay.requestDigest.some((byte, index) =>
        byte !== requestDigest[index]))) {
      throw new TypeError("Human Task ordinary fallback replay admission disagrees");
    }
    if (!crypto.verify(input.signingPublicKey, signed, request.signature)) {
      throw new TypeError("Human Task ordinary fallback signature is invalid");
    }
    const verificationTime = replay === undefined ? input.now : request.issuedAt;
    if (!validCounter(verificationTime) || verificationTime < request.issuedAt
      || verificationTime >= request.deadlineAt) {
      throw new TypeError(
        "Human Task ordinary fallback request is not currently valid",
      );
    }
    return Object.freeze({ request, requestDigest });
  } finally {
    signed.fill(0);
  }
}
