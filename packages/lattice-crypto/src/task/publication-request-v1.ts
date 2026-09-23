import type { LatticeCrypto } from "../crypto/index.ts";
import {
  concatV2, decodeExact, encodeU32, encodeU64, frame, frameText,
} from "../format/v2-primitives.ts";
import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";

export const HUMAN_TASK_PUBLICATION_REQUEST_DOMAIN_V1 =
  "nautilo/lattice-crypto/human-task-publication-request/v1";
/** A publication attempt is short-lived; durable retry uses its operation id. */
export const HUMAN_TASK_PUBLICATION_REQUEST_MAX_TTL_MS_V1 = 30_000;

export interface HumanTaskPublicationRequestUnsignedV1 {
  readonly formatVersion: 1;
  readonly purpose: "task.publish";
  readonly operation: "create" | "update";
  readonly operationId: string;
  readonly taskId: string;
  readonly cryptoObjectId: string;
  readonly expectedContentRevision: number;
  readonly nextContentRevision: number;
  readonly expectedCryptoAccessRevision: number;
  readonly resultCryptoAccessRevision: 0;
  readonly planDigest: Uint8Array;
  readonly operationalFieldsDigest: Uint8Array;
  readonly subjectHumanId: string;
  readonly committerDeviceId: string;
  readonly hostAuthorizationRevision: number;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly expectedNamespaceAccessRevision: number;
  readonly expectedPolicyRevision: number;
  readonly bindingHash: Uint8Array;
  readonly keyGeneration: number;
  readonly payloadHash: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly envelopeHash: Uint8Array;
  readonly issuedAt: number;
  readonly deadlineAt: number;
}

export interface HumanTaskPublicationRequestV1
  extends HumanTaskPublicationRequestUnsignedV1 {
  readonly signature: Uint8Array;
}

export type PrepareHumanTaskPublicationRequestInputV1 = Omit<
  HumanTaskPublicationRequestUnsignedV1, "formatVersion" | "purpose"
> & Readonly<{
  committerSigningPublicKey: Uint8Array;
  committerSigningPrivateKey: Uint8Array;
}>;

const ID_FIELDS = [
  "operationId", "taskId", "cryptoObjectId", "subjectHumanId",
  "committerDeviceId", "namespaceId", "domainId",
] as const;
const COUNTER_FIELDS = [
  "expectedContentRevision", "nextContentRevision", "expectedCryptoAccessRevision",
  "resultCryptoAccessRevision", "hostAuthorizationRevision",
  "expectedNamespaceAccessRevision", "expectedPolicyRevision", "keyGeneration",
  "issuedAt", "deadlineAt",
] as const;
const HASH_FIELDS = [
  "planDigest", "operationalFieldsDigest", "bindingHash", "payloadHash",
  "manifestHash", "envelopeHash",
] as const;
const UNSIGNED_FIELDS = [
  "formatVersion", "purpose", "operation", ...ID_FIELDS, ...COUNTER_FIELDS,
  ...HASH_FIELDS,
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function exactFields(value: object, fields: readonly string[]): void {
  if (typeof value !== "object" || value === null
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== fields.length
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
    || fields.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })) throw new TypeError("Task publication fields are invalid");
}

function exactBytes(value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError("Task publication byte length is invalid");
  }
  return Uint8Array.from(value);
}

function normalizeUnsigned(
  value: HumanTaskPublicationRequestUnsignedV1,
): HumanTaskPublicationRequestUnsignedV1 {
  exactFields(value, UNSIGNED_FIELDS);
  if (value.formatVersion !== 1 || value.purpose !== "task.publish"
    || (value.operation !== "create" && value.operation !== "update")) {
    throw new TypeError("Task publication version, purpose or operation is invalid");
  }
  for (const field of ID_FIELDS) assertPortableId(field, value[field]);
  for (const field of COUNTER_FIELDS) assertU64Counter(field, value[field]);
  if (!UUID.test(value.taskId)
    || value.nextContentRevision !== value.expectedContentRevision + 1
    || value.resultCryptoAccessRevision !== 0
    || value.expectedPolicyRevision < 1
    || (value.operation === "create"
      ? value.expectedContentRevision !== 0 || value.expectedCryptoAccessRevision !== 0
      : value.expectedContentRevision < 1)
    || value.deadlineAt <= value.issuedAt
    || value.deadlineAt - value.issuedAt > HUMAN_TASK_PUBLICATION_REQUEST_MAX_TTL_MS_V1) {
    throw new TypeError("Task publication coordinates or deadline are invalid");
  }
  return Object.freeze({
    ...value,
    planDigest: exactBytes(value.planDigest, 32),
    operationalFieldsDigest: exactBytes(value.operationalFieldsDigest, 32),
    bindingHash: exactBytes(value.bindingHash, 32),
    payloadHash: exactBytes(value.payloadHash, 32),
    manifestHash: exactBytes(value.manifestHash, 32),
    envelopeHash: exactBytes(value.envelopeHash, 32),
  });
}

function unsignedSigningBytes(value: HumanTaskPublicationRequestUnsignedV1): Uint8Array {
  return concatV2(
    frameText(HUMAN_TASK_PUBLICATION_REQUEST_DOMAIN_V1),
    encodeU32(value.formatVersion), frameText(value.purpose), frameText(value.operation),
    ...ID_FIELDS.map((field) => frameText(value[field])),
    ...COUNTER_FIELDS.map((field) => encodeU64(value[field])),
    ...HASH_FIELDS.map((field) => frame(value[field])),
  );
}

export function humanTaskPublicationRequestSigningBytesV1(
  value: HumanTaskPublicationRequestUnsignedV1,
): Uint8Array {
  return unsignedSigningBytes(normalizeUnsigned(value));
}

export function encodeHumanTaskPublicationRequestV1(
  value: HumanTaskPublicationRequestV1,
): Uint8Array {
  exactFields(value, [...UNSIGNED_FIELDS, "signature"]);
  const { signature, ...unsigned } = value;
  return concatV2(humanTaskPublicationRequestSigningBytesV1(unsigned),
    frame(exactBytes(signature, V2_LIMITS.signatureBytes)));
}

export function decodeHumanTaskPublicationRequestV1(
  bytes: Uint8Array,
): HumanTaskPublicationRequestV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length > V2_LIMITS.plaintextBytes) {
    throw new TypeError("Task publication wire size is invalid");
  }
  const request = decodeExact(bytes, (reader) => {
    if (reader.readText(HUMAN_TASK_PUBLICATION_REQUEST_DOMAIN_V1.length)
      !== HUMAN_TASK_PUBLICATION_REQUEST_DOMAIN_V1) {
      throw new TypeError("Task publication domain mismatch");
    }
    const formatVersion = reader.readVersion(1) as 1;
    const purpose = reader.readText("task.publish".length) as "task.publish";
    const operation = reader.readText("create".length) as "create" | "update";
    const ids = Object.fromEntries(ID_FIELDS.map((field) =>
      [field, reader.readText(V2_LIMITS.idBytes)]));
    const counters = Object.fromEntries(COUNTER_FIELDS.map((field) => [field, reader.readU64()]));
    const hashes = Object.fromEntries(HASH_FIELDS.map((field) => [field, reader.readFrame(32)]));
    const unsigned = normalizeUnsigned({
      formatVersion, purpose, operation, ...ids, ...counters, ...hashes,
    } as HumanTaskPublicationRequestUnsignedV1);
    return Object.freeze({
      ...unsigned,
      signature: exactBytes(reader.readFrame(V2_LIMITS.signatureBytes), V2_LIMITS.signatureBytes),
    });
  });
  const canonical = encodeHumanTaskPublicationRequestV1(request);
  if (canonical.length !== bytes.length
    || !canonical.every((byte, index) => byte === bytes[index])) {
    throw new TypeError("Task publication is noncanonical");
  }
  return request;
}

export function prepareHumanTaskPublicationRequestV1(
  crypto: LatticeCrypto,
  input: PrepareHumanTaskPublicationRequestInputV1,
): Readonly<{ request: HumanTaskPublicationRequestV1; bytes: Uint8Array }> {
  const { committerSigningPublicKey, committerSigningPrivateKey, ...rest } = input;
  const unsigned = normalizeUnsigned({ ...rest, formatVersion: 1, purpose: "task.publish" });
  let privateKey: Uint8Array | undefined;
  let publicKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  try {
    privateKey = exactBytes(committerSigningPrivateKey, V2_LIMITS.signingPrivateKeyBytes);
    publicKey = exactBytes(committerSigningPublicKey, V2_LIMITS.signingPublicKeyBytes);
    signingBytes = unsignedSigningBytes(unsigned);
    const signature = crypto.sign(privateKey, signingBytes);
    if (!crypto.verify(publicKey, signingBytes, signature)) {
      throw new TypeError("Task publication signing keys do not match");
    }
    const bytes = encodeHumanTaskPublicationRequestV1({ ...unsigned, signature });
    return Object.freeze({ request: decodeHumanTaskPublicationRequestV1(bytes), bytes });
  } finally {
    privateKey?.fill(0);
    publicKey?.fill(0);
    signingBytes?.fill(0);
  }
}

/** The resolver must authorize all returned publication facts against current state. */
export async function verifyHumanTaskPublicationRequestV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    now: number;
    resolveCurrentAuthority: (
      request: HumanTaskPublicationRequestV1,
    ) => Promise<Uint8Array | null>;
  }>,
): Promise<HumanTaskPublicationRequestV1> {
  const request = decodeHumanTaskPublicationRequestV1(input.requestBytes);
  assertU64Counter("Task publication verification time", input.now);
  if (input.now < request.issuedAt || input.now >= request.deadlineAt) {
    throw new TypeError("Task publication request is not currently valid");
  }
  return verifyCurrentSignature(crypto, request, input.resolveCurrentAuthority);
}

/**
 * Authenticates the exact bytes of an already-admitted durable operation.
 * This grants no fresh admission: the caller must have loaded and authorized
 * the matching Task ledger reservation, and may only finish that reservation
 * or return its already-committed result. The digest must come from the ledger,
 * never the incoming request; it hashes the complete original signed bytes.
 */
export async function verifyHumanTaskPublicationRequestExactReplayV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    expectedRequestDigest: Uint8Array;
    resolveCurrentAuthority: (
      request: HumanTaskPublicationRequestV1,
    ) => Promise<Uint8Array | null>;
  }>,
): Promise<HumanTaskPublicationRequestV1> {
  // Canonical decoding owns the bytes before hashing or crossing an await.
  const request = decodeHumanTaskPublicationRequestV1(input.requestBytes);
  const canonical = encodeHumanTaskPublicationRequestV1(request);
  const expectedDigest = exactBytes(input.expectedRequestDigest, 32);
  const actualDigest = exactBytes(crypto.hash(canonical), 32);
  try {
    if (!actualDigest.every((byte, index) => byte === expectedDigest[index])) {
      throw new TypeError("Task publication durable request digest disagrees");
    }
    return await verifyCurrentSignature(crypto, request, input.resolveCurrentAuthority);
  } finally {
    canonical.fill(0);
    expectedDigest.fill(0);
    actualDigest.fill(0);
  }
}

async function verifyCurrentSignature(
  crypto: LatticeCrypto,
  request: HumanTaskPublicationRequestV1,
  resolveCurrentAuthority: (
    request: HumanTaskPublicationRequestV1,
  ) => Promise<Uint8Array | null>,
): Promise<HumanTaskPublicationRequestV1> {
  // The callback gets its own bytes; mutation across its await cannot change
  // the signed request subsequently used by the importer.
  const key = await resolveCurrentAuthority(
    decodeHumanTaskPublicationRequestV1(encodeHumanTaskPublicationRequestV1(request)),
  );
  if (key === null) throw new TypeError("Task publication authority is unavailable");
  const publicKey = exactBytes(key, V2_LIMITS.signingPublicKeyBytes);
  const { signature, ...unsigned } = request;
  const message = unsignedSigningBytes(unsigned);
  try {
    if (!crypto.verify(publicKey, message, signature)) {
      throw new TypeError("Task publication signature is invalid");
    }
    return request;
  } finally {
    publicKey.fill(0);
    message.fill(0);
  }
}
