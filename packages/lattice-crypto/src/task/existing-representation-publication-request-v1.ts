import type { LatticeCrypto } from "../crypto/index.ts";
import {
  concatV2, decodeExact, encodeU32, encodeU64, frame, frameText,
} from "../format/v2-primitives.ts";
import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";

export const HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_DOMAIN_V1 =
  "nautilo/lattice-crypto/human-existing-task-representation-publication-request/v1";
/** A publication attempt is short-lived; durable retry uses its operation id. */
export const HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1 = 30_000;
/** Existing decoder bound, shared with transport and durable receipt storage. */
export const MAX_HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1 =
  V2_LIMITS.plaintextBytes;

export interface HumanExistingTaskRepresentationPublicationRequestUnsignedV1 {
  readonly formatVersion: 1;
  readonly purpose: "task.existing_representation_publish";
  readonly kind: "definition" | "run_result";
  readonly entityId: string;
  readonly claimId: string;
  readonly sourceDigest: Uint8Array;
  readonly sourcePayloadHash: Uint8Array;
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

export interface HumanExistingTaskRepresentationPublicationRequestV1
  extends HumanExistingTaskRepresentationPublicationRequestUnsignedV1 {
  readonly signature: Uint8Array;
}

export type PrepareHumanExistingTaskRepresentationPublicationRequestInputV1 = Omit<
  HumanExistingTaskRepresentationPublicationRequestUnsignedV1, "formatVersion" | "purpose"
> & Readonly<{
  committerSigningPublicKey: Uint8Array;
  committerSigningPrivateKey: Uint8Array;
}>;

const ID_FIELDS = [
  "operationId", "taskId", "entityId", "claimId", "cryptoObjectId", "subjectHumanId",
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
  "manifestHash", "envelopeHash", "sourceDigest", "sourcePayloadHash",
] as const;
const UNSIGNED_FIELDS = [
  "formatVersion", "purpose", "kind", ...ID_FIELDS, ...COUNTER_FIELDS,
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
    })) throw new TypeError("Historical Task publication fields are invalid");
}

function exactBytes(value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError("Historical Task publication byte length is invalid");
  }
  return Uint8Array.from(value);
}

function normalizeUnsigned(
  value: HumanExistingTaskRepresentationPublicationRequestUnsignedV1,
): HumanExistingTaskRepresentationPublicationRequestUnsignedV1 {
  exactFields(value, UNSIGNED_FIELDS);
  if (value.formatVersion !== 1 || value.purpose !== "task.existing_representation_publish"
    || (value.kind !== "definition" && value.kind !== "run_result")) {
    throw new TypeError("Historical Task publication version, purpose or operation is invalid");
  }
  for (const field of ID_FIELDS) assertPortableId(field, value[field]);
  for (const field of COUNTER_FIELDS) assertU64Counter(field, value[field]);
  if (!UUID.test(value.taskId)
    || value.nextContentRevision !== value.expectedContentRevision + 1
    || value.resultCryptoAccessRevision !== 0
    || value.expectedPolicyRevision < 1
    || !UUID.test(value.entityId) || !UUID.test(value.claimId)
    || value.kind === "definition" && value.entityId !== value.taskId
    || value.expectedContentRevision !== 0
    || value.nextContentRevision !== 1
    || value.expectedCryptoAccessRevision !== 0
    || value.deadlineAt <= value.issuedAt
    || value.deadlineAt - value.issuedAt > HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1) {
    throw new TypeError("Historical Task publication coordinates or deadline are invalid");
  }
  return Object.freeze({
    ...value,
    planDigest: exactBytes(value.planDigest, 32),
    operationalFieldsDigest: exactBytes(value.operationalFieldsDigest, 32),
    bindingHash: exactBytes(value.bindingHash, 32),
    payloadHash: exactBytes(value.payloadHash, 32),
    manifestHash: exactBytes(value.manifestHash, 32),
    envelopeHash: exactBytes(value.envelopeHash, 32),
    sourceDigest: exactBytes(value.sourceDigest, 32),
    sourcePayloadHash: exactBytes(value.sourcePayloadHash, 32),
  });
}

function unsignedSigningBytes(value: HumanExistingTaskRepresentationPublicationRequestUnsignedV1): Uint8Array {
  return concatV2(
    frameText(HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_DOMAIN_V1),
    encodeU32(value.formatVersion), frameText(value.purpose), frameText(value.kind),
    ...ID_FIELDS.map((field) => frameText(value[field])),
    ...COUNTER_FIELDS.map((field) => encodeU64(value[field])),
    ...HASH_FIELDS.map((field) => frame(value[field])),
  );
}

export function humanExistingTaskRepresentationPublicationRequestSigningBytesV1(
  value: HumanExistingTaskRepresentationPublicationRequestUnsignedV1,
): Uint8Array {
  return unsignedSigningBytes(normalizeUnsigned(value));
}

export function encodeHumanExistingTaskRepresentationPublicationRequestV1(
  value: HumanExistingTaskRepresentationPublicationRequestV1,
): Uint8Array {
  exactFields(value, [...UNSIGNED_FIELDS, "signature"]);
  const { signature, ...unsigned } = value;
  return concatV2(humanExistingTaskRepresentationPublicationRequestSigningBytesV1(unsigned),
    frame(exactBytes(signature, V2_LIMITS.signatureBytes)));
}

export function decodeHumanExistingTaskRepresentationPublicationRequestV1(
  bytes: Uint8Array,
): HumanExistingTaskRepresentationPublicationRequestV1 {
  if (!(bytes instanceof Uint8Array)
    || bytes.length > MAX_HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1) {
    throw new TypeError("Historical Task publication wire size is invalid");
  }
  const request = decodeExact(bytes, (reader) => {
    if (reader.readText(HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_DOMAIN_V1.length)
      !== HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_DOMAIN_V1) {
      throw new TypeError("Historical Task publication domain mismatch");
    }
    const formatVersion = reader.readVersion(1) as 1;
    const purpose = reader.readText("task.existing_representation_publish".length) as "task.existing_representation_publish";
    const kind = reader.readText("definition".length) as "definition" | "run_result";
    const ids = Object.fromEntries(ID_FIELDS.map((field) =>
      [field, reader.readText(V2_LIMITS.idBytes)]));
    const counters = Object.fromEntries(COUNTER_FIELDS.map((field) => [field, reader.readU64()]));
    const hashes = Object.fromEntries(HASH_FIELDS.map((field) => [field, reader.readFrame(32)]));
    const unsigned = normalizeUnsigned({
      formatVersion, purpose, kind, ...ids, ...counters, ...hashes,
    } as HumanExistingTaskRepresentationPublicationRequestUnsignedV1);
    return Object.freeze({
      ...unsigned,
      signature: exactBytes(reader.readFrame(V2_LIMITS.signatureBytes), V2_LIMITS.signatureBytes),
    });
  });
  const canonical = encodeHumanExistingTaskRepresentationPublicationRequestV1(request);
  if (canonical.length !== bytes.length
    || !canonical.every((byte, index) => byte === bytes[index])) {
    throw new TypeError("Historical Task publication is noncanonical");
  }
  return request;
}

export function prepareHumanExistingTaskRepresentationPublicationRequestV1(
  crypto: LatticeCrypto,
  input: PrepareHumanExistingTaskRepresentationPublicationRequestInputV1,
): Readonly<{ request: HumanExistingTaskRepresentationPublicationRequestV1; bytes: Uint8Array }> {
  const { committerSigningPublicKey, committerSigningPrivateKey, ...rest } = input;
  const unsigned = normalizeUnsigned({ ...rest, formatVersion: 1, purpose: "task.existing_representation_publish" });
  let privateKey: Uint8Array | undefined;
  let publicKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  try {
    privateKey = exactBytes(committerSigningPrivateKey, V2_LIMITS.signingPrivateKeyBytes);
    publicKey = exactBytes(committerSigningPublicKey, V2_LIMITS.signingPublicKeyBytes);
    signingBytes = unsignedSigningBytes(unsigned);
    const signature = crypto.sign(privateKey, signingBytes);
    if (!crypto.verify(publicKey, signingBytes, signature)) {
      throw new TypeError("Historical Task publication signing keys do not match");
    }
    const bytes = encodeHumanExistingTaskRepresentationPublicationRequestV1({ ...unsigned, signature });
    return Object.freeze({ request: decodeHumanExistingTaskRepresentationPublicationRequestV1(bytes), bytes });
  } finally {
    privateKey?.fill(0);
    publicKey?.fill(0);
    signingBytes?.fill(0);
  }
}

/** The resolver must authorize all returned publication facts against current state. */
export async function verifyHumanExistingTaskRepresentationPublicationRequestV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    now: number;
    resolveCurrentAuthority: (
      request: HumanExistingTaskRepresentationPublicationRequestV1,
    ) => Promise<Uint8Array | null>;
  }>,
): Promise<HumanExistingTaskRepresentationPublicationRequestV1> {
  const request = decodeHumanExistingTaskRepresentationPublicationRequestV1(input.requestBytes);
  assertU64Counter("Historical Task publication verification time", input.now);
  if (input.now < request.issuedAt || input.now >= request.deadlineAt) {
    throw new TypeError("Historical Task publication request is not currently valid");
  }
  return verifyCurrentSignature(crypto, request, input.resolveCurrentAuthority);
}

/**
 * Authenticates the exact bytes of an already-admitted historical repair operation.
 * This grants no fresh admission: the caller must have loaded and authorized
 * the matching Task ledger reservation, and may only finish that reservation
 * or return its already-committed result. The digest must come from the ledger,
 * never the incoming request; it hashes the complete original signed bytes.
 */
export async function verifyHumanExistingTaskRepresentationPublicationRequestExactReplayV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    expectedRequestDigest: Uint8Array;
    resolveCurrentAuthority: (
      request: HumanExistingTaskRepresentationPublicationRequestV1,
    ) => Promise<Uint8Array | null>;
  }>,
): Promise<HumanExistingTaskRepresentationPublicationRequestV1> {
  // Canonical decoding owns the bytes before hashing or crossing an await.
  const request = decodeHumanExistingTaskRepresentationPublicationRequestV1(input.requestBytes);
  const canonical = encodeHumanExistingTaskRepresentationPublicationRequestV1(request);
  const expectedDigest = exactBytes(input.expectedRequestDigest, 32);
  const actualDigest = exactBytes(crypto.hash(canonical), 32);
  try {
    if (!actualDigest.every((byte, index) => byte === expectedDigest[index])) {
      throw new TypeError("Historical Task publication durable request digest disagrees");
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
  request: HumanExistingTaskRepresentationPublicationRequestV1,
  resolveCurrentAuthority: (
    request: HumanExistingTaskRepresentationPublicationRequestV1,
  ) => Promise<Uint8Array | null>,
): Promise<HumanExistingTaskRepresentationPublicationRequestV1> {
  // The callback gets its own bytes; mutation across its await cannot change
  // the signed request subsequently used by the importer.
  const key = await resolveCurrentAuthority(
    decodeHumanExistingTaskRepresentationPublicationRequestV1(encodeHumanExistingTaskRepresentationPublicationRequestV1(request)),
  );
  if (key === null) throw new TypeError("Historical Task publication authority is unavailable");
  const publicKey = exactBytes(key, V2_LIMITS.signingPublicKeyBytes);
  const { signature, ...unsigned } = request;
  const message = unsignedSigningBytes(unsigned);
  try {
    if (!crypto.verify(publicKey, message, signature)) {
      throw new TypeError("Historical Task publication signature is invalid");
    }
    return request;
  } finally {
    publicKey.fill(0);
    message.fill(0);
  }
}
