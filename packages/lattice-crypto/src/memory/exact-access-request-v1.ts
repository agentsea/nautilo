import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  CanonicalDecodingError,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import {
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type HumanId,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const HUMAN_MEMORY_EXACT_ACCESS_REQUEST_FORMAT_VERSION_V2 = 1 as const;
export const HUMAN_MEMORY_EXACT_ACCESS_REQUEST_DOMAIN_V2 =
  "nautilo/lattice-crypto/human-memory-exact-access-request/v2";
export const HUMAN_MEMORY_EXACT_ACCESS_REQUEST_PURPOSE_V2 =
  "memory.exact_access_update" as const;
export const HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2 = 30_000;
export const HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2 =
  V2_LIMITS.namespaceEnvelopesPerManifest;

const HASH_BYTES = 32;
const FRAME_LENGTH_BYTES = 4;
const U32_BYTES = 4;
const U64_BYTES = 8;
const MEMORY_ID_BYTES = 36;
const framedBytes = (payloadBytes: number) => FRAME_LENGTH_BYTES + payloadBytes;
const MAX_EXACT_ACCESS_ENTRY_WIRE_BYTES =
  framedBytes(V2_LIMITS.idBytes) + 2 * U64_BYTES + 5 * framedBytes(HASH_BYTES);
const MAX_EXACT_ACCESS_AUTHORITY_ENTRY_WIRE_BYTES =
  framedBytes(V2_LIMITS.idBytes) + 2 * U64_BYTES + 4 * framedBytes(HASH_BYTES);
/** Exact maximum for every canonical scalar plus four complete 256-entry
 * inventories and the framed signature. This preserves the established entry
 * capacity without admitting an independently chosen enclosing ceiling. */
export const MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2 =
  framedBytes(utf8V2(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_DOMAIN_V2).length)
  + U32_BYTES
  + framedBytes(utf8V2(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_PURPOSE_V2).length)
  + 4 * framedBytes(V2_LIMITS.idBytes)
  + framedBytes(MEMORY_ID_BYTES)
  + 3 * framedBytes(HASH_BYTES)
  + 3 * U64_BYTES
  + 4 * U32_BYTES
  + 2 * HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2
    * MAX_EXACT_ACCESS_ENTRY_WIRE_BYTES
  + 2 * HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2
    * MAX_EXACT_ACCESS_AUTHORITY_ENTRY_WIRE_BYTES
  + 3 * U64_BYTES
  + framedBytes(V2_LIMITS.signatureBytes);
const MEMORY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Canonical native Domain V2 authority descriptor shared by Human- and
 * Agent-authored Memory access updates. The signing actor is intentionally
 * absent; each foreground protocol authenticates that separately. */
export interface MemoryNativeNamespaceAccessEntryV1 {
  readonly namespaceId: NamespaceId;
  readonly keyGeneration: number;
  readonly namespaceAccessRevision: number;
  readonly headDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
  readonly publicationSetDigest: Uint8Array;
  readonly audienceFingerprint: Uint8Array;
  readonly envelopeHash: Uint8Array;
}

export type MemoryNativeNamespaceAuthorityEntryV1 = Omit<
  MemoryNativeNamespaceAccessEntryV1,
  "envelopeHash"
>;

export type HumanMemoryExactAccessRequestEntryV2 =
  MemoryNativeNamespaceAccessEntryV1;

export interface HumanMemoryExactAccessRequestUnsignedV2 {
  readonly formatVersion:
    typeof HUMAN_MEMORY_EXACT_ACCESS_REQUEST_FORMAT_VERSION_V2;
  readonly purpose: typeof HUMAN_MEMORY_EXACT_ACCESS_REQUEST_PURPOSE_V2;
  readonly subjectHumanId: HumanId;
  readonly operationId: string;
  readonly memoryId: string;
  readonly cryptoObjectId: ObjectId;
  readonly payloadHash: Uint8Array;
  readonly expectedContentRevision: number;
  readonly expectedAccessRevision: number;
  readonly nextAccessRevision: number;
  readonly currentManifestHash: Uint8Array;
  readonly nextManifestHash: Uint8Array;
  readonly currentEntries: readonly HumanMemoryExactAccessRequestEntryV2[];
  readonly targetEntries: readonly HumanMemoryExactAccessRequestEntryV2[];
  readonly currentAuthorityEntries: readonly MemoryNativeNamespaceAuthorityEntryV1[];
  readonly targetAuthorityEntries: readonly MemoryNativeNamespaceAuthorityEntryV1[];
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface HumanMemoryExactAccessRequestV2
  extends HumanMemoryExactAccessRequestUnsignedV2 {
  readonly signature: Uint8Array;
}

export interface PrepareHumanMemoryExactAccessRequestInputV2
  extends Omit<
    HumanMemoryExactAccessRequestUnsignedV2,
    "formatVersion" | "purpose"
  > {
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export interface CreatedHumanMemoryExactAccessRequestV2 {
  readonly request: HumanMemoryExactAccessRequestV2;
  readonly bytes: Uint8Array;
}

export interface HumanMemoryExactAccessAuthorityContextV2 {
  readonly purpose: "human-memory-exact-access-verify";
  readonly subjectHumanId: HumanId;
  readonly operationId: string;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export type ResolveCurrentHumanMemoryExactAccessAuthorityV2 = (
  context: HumanMemoryExactAccessAuthorityContextV2,
) => Uint8Array | null;

const UNSIGNED_FIELDS = Object.freeze([
  "formatVersion",
  "purpose",
  "subjectHumanId",
  "operationId",
  "memoryId",
  "cryptoObjectId",
  "payloadHash",
  "expectedContentRevision",
  "expectedAccessRevision",
  "nextAccessRevision",
  "currentManifestHash",
  "nextManifestHash",
  "currentEntries",
  "targetEntries",
  "currentAuthorityEntries",
  "targetAuthorityEntries",
  "issuedAt",
  "deadlineAt",
  "committerDeviceId",
  "hostAuthorizationRevision",
] as const);
const SIGNED_FIELDS = Object.freeze([...UNSIGNED_FIELDS, "signature"]);
const ENTRY_FIELDS = Object.freeze([
  "namespaceId",
  "keyGeneration",
  "namespaceAccessRevision",
  "headDigest",
  "publicationDigest",
  "publicationSetDigest",
  "audienceFingerprint",
  "envelopeHash",
] as const);
const AUTHORITY_ENTRY_FIELDS = Object.freeze(
  ENTRY_FIELDS.filter((field) => field !== "envelopeHash"),
);

function assertObject(label: string, value: unknown): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort(compareUnsignedUtf8);
  const wanted = [...expected].sort(compareUnsignedUtf8);
  if (
    actual.length !== wanted.length
    || actual.some((field, index) => field !== wanted[index])
  ) throw new TypeError(`${label} has an invalid field set`);
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function wipeBytes(...values: readonly (Uint8Array | undefined)[]): void {
  values.forEach((value) => value?.fill(0));
}

function exactRevisionStep(expectedValue: unknown, nextValue: unknown): [number, number] {
  assertU64Counter("Human Memory expected access revision", expectedValue as number);
  const expected = expectedValue as number;
  if (!Number.isSafeInteger(expected + 1) || nextValue !== expected + 1) {
    throw new RangeError("Human Memory access revision must advance exactly once");
  }
  return [expected, expected + 1];
}

function normalizeEntries(
  label: string,
  value: unknown,
  allowEmpty: boolean,
): readonly HumanMemoryExactAccessRequestEntryV2[] {
  if (
    !Array.isArray(value)
    || (!allowEmpty && value.length < 1)
    || value.length > HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2
  ) throw new RangeError(`Human Memory ${label} entry inventory is not bounded`);
  const entries: HumanMemoryExactAccessRequestEntryV2[] = [];
  try {
    let previous: string | null = null;
    for (const raw of value) {
      assertObject(`Human Memory ${label} entry`, raw);
      assertExactFields(`Human Memory ${label} entry`, raw, ENTRY_FIELDS);
      const entry = raw as HumanMemoryExactAccessRequestEntryV2;
      const id = namespaceId(entry.namespaceId);
      if (previous !== null && compareUnsignedUtf8(previous, id) >= 0) {
        throw new TypeError(
          `Human Memory ${label} entries must be unique and canonically sorted`,
        );
      }
      previous = id;
      assertU64Counter(
        `Human Memory ${label} key generation`,
        entry.keyGeneration,
      );
      assertU64Counter(
        `Human Memory ${label} Namespace access revision`,
        entry.namespaceAccessRevision,
      );
      entries.push(Object.freeze({
        namespaceId: id,
        keyGeneration: entry.keyGeneration,
        namespaceAccessRevision: entry.namespaceAccessRevision,
        headDigest: exactBytes(`Human Memory ${label} head digest`, entry.headDigest, HASH_BYTES),
        publicationDigest: exactBytes(`Human Memory ${label} publication digest`, entry.publicationDigest, HASH_BYTES),
        publicationSetDigest: exactBytes(`Human Memory ${label} publication-set digest`, entry.publicationSetDigest, HASH_BYTES),
        audienceFingerprint: exactBytes(`Human Memory ${label} audience fingerprint`, entry.audienceFingerprint, HASH_BYTES),
        envelopeHash: exactBytes(
          `Human Memory ${label} envelope hash`,
          entry.envelopeHash,
          HASH_BYTES,
        ),
      }));
    }
    return Object.freeze(entries);
  } catch (error) {
    destroyEntries(entries);
    throw error;
  }
}

function normalizeAuthorityEntries(
  label: string,
  values: unknown,
  allowEmpty: boolean,
): readonly MemoryNativeNamespaceAuthorityEntryV1[] {
  if (!Array.isArray(values)) {
    throw new TypeError(`Human Memory ${label} authority entries are invalid`);
  }
  const augmented = values.map((value) => {
    assertObject(`Human Memory ${label} authority entry`, value);
    assertExactFields(
      `Human Memory ${label} authority entry`, value, AUTHORITY_ENTRY_FIELDS,
    );
    return { ...value, envelopeHash: new Uint8Array(HASH_BYTES) };
  });
  const normalized = normalizeEntries(label, augmented, allowEmpty);
  return Object.freeze(normalized.map(({ envelopeHash, ...entry }) => {
    envelopeHash.fill(0);
    return Object.freeze(entry);
  }));
}

function destroyEntries(entries: readonly HumanMemoryExactAccessRequestEntryV2[]): void {
  entries.forEach((entry) => wipeBytes(entry.headDigest, entry.publicationDigest,
    entry.publicationSetDigest, entry.audienceFingerprint, entry.envelopeHash));
}

function destroyAuthorityEntries(
  entries: readonly MemoryNativeNamespaceAuthorityEntryV1[],
): void {
  entries.forEach((entry) => wipeBytes(entry.headDigest, entry.publicationDigest,
    entry.publicationSetDigest, entry.audienceFingerprint));
}

function normalizeUnsigned(
  value: HumanMemoryExactAccessRequestUnsignedV2,
): HumanMemoryExactAccessRequestUnsignedV2 {
  assertObject("Human Memory exact-access request", value);
  assertExactFields("Human Memory exact-access request", value, UNSIGNED_FIELDS);
  if (
    value.formatVersion !== HUMAN_MEMORY_EXACT_ACCESS_REQUEST_FORMAT_VERSION_V2
    || value.purpose !== HUMAN_MEMORY_EXACT_ACCESS_REQUEST_PURPOSE_V2
  ) throw new TypeError("Human Memory exact-access request kind is invalid");
  const subjectHumanId = humanId(value.subjectHumanId);
  assertPortableId("Human Memory exact-access operation id", value.operationId);
  if (typeof value.memoryId !== "string" || !MEMORY_ID.test(value.memoryId)) {
    throw new TypeError("Human Memory exact-access Memory ID is invalid");
  }
  const cryptoObjectId = objectId(value.cryptoObjectId);
  assertU64Counter(
    "Human Memory exact-access content revision",
    value.expectedContentRevision,
  );
  const [expectedAccessRevision, nextAccessRevision] = exactRevisionStep(
    value.expectedAccessRevision,
    value.nextAccessRevision,
  );
  let payloadHash: Uint8Array | undefined;
  let currentManifestHash: Uint8Array | undefined;
  let nextManifestHash: Uint8Array | undefined;
  let currentEntries: readonly HumanMemoryExactAccessRequestEntryV2[] | undefined;
  let targetEntries: readonly HumanMemoryExactAccessRequestEntryV2[] | undefined;
  let currentAuthorityEntries: readonly MemoryNativeNamespaceAuthorityEntryV1[] | undefined;
  let targetAuthorityEntries: readonly MemoryNativeNamespaceAuthorityEntryV1[] | undefined;
  try {
    payloadHash = exactBytes(
      "Human Memory exact-access payload hash",
      value.payloadHash,
      HASH_BYTES,
    );
    currentManifestHash = exactBytes(
      "Human Memory exact-access current manifest hash",
      value.currentManifestHash,
      HASH_BYTES,
    );
    nextManifestHash = exactBytes(
      "Human Memory exact-access next manifest hash",
      value.nextManifestHash,
      HASH_BYTES,
    );
    currentEntries = normalizeEntries("current", value.currentEntries, false);
    targetEntries = normalizeEntries("target", value.targetEntries, true);
    currentAuthorityEntries = normalizeAuthorityEntries(
      "current", value.currentAuthorityEntries, false);
    targetAuthorityEntries = normalizeAuthorityEntries(
      "target", value.targetAuthorityEntries, true);
    if (!currentEntries.every((entry, index) =>
      entry.namespaceId === currentAuthorityEntries![index]?.namespaceId)
      || !targetEntries.every((entry, index) =>
        entry.namespaceId === targetAuthorityEntries![index]?.namespaceId)
      || currentEntries.length !== currentAuthorityEntries.length
      || targetEntries.length !== targetAuthorityEntries.length) {
      throw new TypeError("Human Memory exact-access authority inventories are not exact");
    }
    const issuedAt = unixTimestamp(value.issuedAt);
    const deadlineAt = unixTimestamp(value.deadlineAt);
    if (
      deadlineAt <= issuedAt
      || deadlineAt - issuedAt > HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2
    ) throw new RangeError("Human Memory exact-access deadline is invalid");
    return Object.freeze({
      formatVersion: HUMAN_MEMORY_EXACT_ACCESS_REQUEST_FORMAT_VERSION_V2,
      purpose: HUMAN_MEMORY_EXACT_ACCESS_REQUEST_PURPOSE_V2,
      subjectHumanId,
      operationId: value.operationId,
      memoryId: value.memoryId,
      cryptoObjectId,
      payloadHash,
      expectedContentRevision: value.expectedContentRevision,
      expectedAccessRevision,
      nextAccessRevision,
      currentManifestHash,
      nextManifestHash,
      currentEntries,
      targetEntries,
      currentAuthorityEntries,
      targetAuthorityEntries,
      issuedAt,
      deadlineAt,
      committerDeviceId: cryptoDeviceId(value.committerDeviceId),
      hostAuthorizationRevision: authorizationRevision(
        value.hostAuthorizationRevision,
      ),
    });
  } catch (error) {
    wipeBytes(payloadHash, currentManifestHash, nextManifestHash);
    if (currentEntries) destroyEntries(currentEntries);
    if (targetEntries) destroyEntries(targetEntries);
    if (currentAuthorityEntries) destroyAuthorityEntries(currentAuthorityEntries);
    if (targetAuthorityEntries) destroyAuthorityEntries(targetAuthorityEntries);
    throw error;
  }
}

function normalizeRequest(
  value: HumanMemoryExactAccessRequestV2,
): HumanMemoryExactAccessRequestV2 {
  assertObject("Human Memory exact-access request", value);
  assertExactFields("Human Memory exact-access request", value, SIGNED_FIELDS);
  const { signature, ...unsignedValue } = value;
  const unsigned = normalizeUnsigned(unsignedValue);
  try {
    return Object.freeze({
      ...unsigned,
      signature: exactBytes(
        "Human Memory exact-access signature",
        signature,
        V2_LIMITS.signatureBytes,
      ),
    });
  } catch (error) {
    destroyUnsigned(unsigned);
    throw error;
  }
}

function destroyUnsigned(value: HumanMemoryExactAccessRequestUnsignedV2): void {
  wipeBytes(value.payloadHash, value.currentManifestHash, value.nextManifestHash);
  destroyEntries(value.currentEntries);
  destroyEntries(value.targetEntries);
  destroyAuthorityEntries(value.currentAuthorityEntries);
  destroyAuthorityEntries(value.targetAuthorityEntries);
}

function destroyRequest(value: HumanMemoryExactAccessRequestV2): void {
  destroyUnsigned(value);
  value.signature.fill(0);
}

function entrySigningParts(
  entry: HumanMemoryExactAccessRequestEntryV2,
): readonly Uint8Array[] {
  return [
    frameText(entry.namespaceId),
    encodeU64(entry.keyGeneration),
    encodeU64(entry.namespaceAccessRevision),
    frame(entry.headDigest),
    frame(entry.publicationDigest),
    frame(entry.publicationSetDigest),
    frame(entry.audienceFingerprint),
    frame(entry.envelopeHash),
  ];
}

function authorityEntrySigningParts(
  entry: MemoryNativeNamespaceAuthorityEntryV1,
): readonly Uint8Array[] {
  return [frameText(entry.namespaceId), encodeU64(entry.keyGeneration),
    encodeU64(entry.namespaceAccessRevision), frame(entry.headDigest),
    frame(entry.publicationDigest), frame(entry.publicationSetDigest),
    frame(entry.audienceFingerprint)];
}

function signingBytesFromNormalized(
  value: HumanMemoryExactAccessRequestUnsignedV2,
): Uint8Array {
  return concatV2(
    frameText(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_DOMAIN_V2),
    encodeU32(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_FORMAT_VERSION_V2),
    frameText(value.purpose),
    frameText(value.subjectHumanId),
    frameText(value.operationId),
    frameText(value.memoryId),
    frameText(value.cryptoObjectId),
    frame(value.payloadHash),
    encodeU64(value.expectedContentRevision),
    encodeU64(value.expectedAccessRevision),
    encodeU64(value.nextAccessRevision),
    frame(value.currentManifestHash),
    frame(value.nextManifestHash),
    encodeU32(value.currentEntries.length),
    ...value.currentEntries.flatMap(entrySigningParts),
    encodeU32(value.targetEntries.length),
    ...value.targetEntries.flatMap(entrySigningParts),
    encodeU32(value.currentAuthorityEntries.length),
    ...value.currentAuthorityEntries.flatMap(authorityEntrySigningParts),
    encodeU32(value.targetAuthorityEntries.length),
    ...value.targetAuthorityEntries.flatMap(authorityEntrySigningParts),
    encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
    frameText(value.committerDeviceId),
    encodeU64(value.hostAuthorizationRevision),
  );
}

export function humanMemoryExactAccessRequestSigningBytesV2(
  value: HumanMemoryExactAccessRequestUnsignedV2,
): Uint8Array {
  const normalized = normalizeUnsigned(value);
  try {
    return signingBytesFromNormalized(normalized);
  } finally {
    destroyUnsigned(normalized);
  }
}

export function encodeHumanMemoryExactAccessRequestV2(
  value: HumanMemoryExactAccessRequestV2,
): Uint8Array {
  const normalized = normalizeRequest(value);
  try {
    const bytes = concatV2(
      signingBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (bytes.length > MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2) {
      bytes.fill(0);
      throw new RangeError("Human Memory exact-access request exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyRequest(normalized);
  }
}

function readEntries(
  reader: Parameters<Parameters<typeof decodeExact>[1]>[0],
): HumanMemoryExactAccessRequestEntryV2[] {
  const count = reader.readCount(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2);
  return Array.from({ length: count }, () => ({
    namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
    keyGeneration: reader.readU64(),
    namespaceAccessRevision: reader.readU64(),
    headDigest: reader.readFrame(HASH_BYTES),
    publicationDigest: reader.readFrame(HASH_BYTES),
    publicationSetDigest: reader.readFrame(HASH_BYTES),
    audienceFingerprint: reader.readFrame(HASH_BYTES),
    envelopeHash: reader.readFrame(HASH_BYTES),
  }));
}

function readAuthorityEntries(
  reader: Parameters<Parameters<typeof decodeExact>[1]>[0],
): MemoryNativeNamespaceAuthorityEntryV1[] {
  const count = reader.readCount(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2);
  return Array.from({ length: count }, () => ({
    namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
    keyGeneration: reader.readU64(),
    namespaceAccessRevision: reader.readU64(),
    headDigest: reader.readFrame(HASH_BYTES),
    publicationDigest: reader.readFrame(HASH_BYTES),
    publicationSetDigest: reader.readFrame(HASH_BYTES),
    audienceFingerprint: reader.readFrame(HASH_BYTES),
  }));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function decodeHumanMemoryExactAccessRequestV2(
  bytes: Uint8Array,
): HumanMemoryExactAccessRequestV2 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Human Memory exact-access request bytes must be Uint8Array");
  }
  if (bytes.length > MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2) {
    throw new RangeError("Human Memory exact-access request exceeds its wire limit");
  }
  const raw = decodeExact(bytes, (reader): HumanMemoryExactAccessRequestV2 => {
    const domain = reader.readText(utf8V2(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_DOMAIN_V2).length);
    if (domain !== HUMAN_MEMORY_EXACT_ACCESS_REQUEST_DOMAIN_V2) {
      throw new CanonicalDecodingError("Human Memory exact-access request domain mismatch");
    }
    const formatVersion = reader.readVersion(
      HUMAN_MEMORY_EXACT_ACCESS_REQUEST_FORMAT_VERSION_V2,
    ) as typeof HUMAN_MEMORY_EXACT_ACCESS_REQUEST_FORMAT_VERSION_V2;
    const purpose = reader.readText(
      utf8V2(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_PURPOSE_V2).length,
    ) as typeof HUMAN_MEMORY_EXACT_ACCESS_REQUEST_PURPOSE_V2;
    return {
      formatVersion,
      purpose,
      subjectHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      operationId: reader.readText(V2_LIMITS.idBytes),
      memoryId: reader.readText(36),
      cryptoObjectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      payloadHash: reader.readFrame(HASH_BYTES),
      expectedContentRevision: reader.readU64(),
      expectedAccessRevision: reader.readU64(),
      nextAccessRevision: reader.readU64(),
      currentManifestHash: reader.readFrame(HASH_BYTES),
      nextManifestHash: reader.readFrame(HASH_BYTES),
      currentEntries: readEntries(reader),
      targetEntries: readEntries(reader),
      currentAuthorityEntries: readAuthorityEntries(reader),
      targetAuthorityEntries: readAuthorityEntries(reader),
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let normalized: HumanMemoryExactAccessRequestV2 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeRequest(raw);
    canonical = encodeHumanMemoryExactAccessRequestV2(normalized);
    if (!equalBytes(canonical, bytes)) {
      throw new CanonicalDecodingError("Human Memory exact-access request is noncanonical");
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyRequest(raw);
    if (normalized) destroyRequest(normalized);
    canonical?.fill(0);
  }
}

export function prepareHumanMemoryExactAccessRequestV2(
  crypto: LatticeCrypto,
  input: PrepareHumanMemoryExactAccessRequestInputV2,
): CreatedHumanMemoryExactAccessRequestV2 {
  const {
    committerSigningPublicKey: rawPublicKey,
    committerSigningPrivateKey: rawPrivateKey,
    ...unsignedInput
  } = input;
  const unsigned = normalizeUnsigned({
    ...unsignedInput,
    formatVersion: HUMAN_MEMORY_EXACT_ACCESS_REQUEST_FORMAT_VERSION_V2,
    purpose: HUMAN_MEMORY_EXACT_ACCESS_REQUEST_PURPOSE_V2,
  });
  let publicKey: Uint8Array | undefined;
  let privateKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    publicKey = exactBytes(
      "Human Memory exact-access signing public key",
      rawPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    privateKey = exactBytes(
      "Human Memory exact-access signing private key",
      rawPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    signingBytes = signingBytesFromNormalized(unsigned);
    signature = exactBytes(
      "Human Memory exact-access signature",
      crypto.sign(privateKey, signingBytes),
      V2_LIMITS.signatureBytes,
    );
    if (!crypto.verify(publicKey, signingBytes, signature)) {
      throw new TypeError("Human Memory exact-access signing keys do not match");
    }
    const bytes = encodeHumanMemoryExactAccessRequestV2({ ...unsigned, signature });
    return Object.freeze({
      request: decodeHumanMemoryExactAccessRequestV2(bytes),
      bytes,
    });
  } finally {
    destroyUnsigned(unsigned);
    wipeBytes(publicKey, privateKey, signingBytes, signature);
  }
}

export function verifyHumanMemoryExactAccessRequestV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly requestBytes: Uint8Array;
    readonly now: UnixTimestamp;
    readonly resolveCurrentAuthority:
      ResolveCurrentHumanMemoryExactAccessAuthorityV2;
  }>,
): HumanMemoryExactAccessRequestV2 {
  const request = decodeHumanMemoryExactAccessRequestV2(input.requestBytes);
  let publicKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let verified = false;
  try {
    const resolved = input.resolveCurrentAuthority(Object.freeze({
      purpose: "human-memory-exact-access-verify" as const,
      subjectHumanId: request.subjectHumanId,
      operationId: request.operationId,
      committerDeviceId: request.committerDeviceId,
      hostAuthorizationRevision: request.hostAuthorizationRevision,
    }));
    if (resolved === null) {
      throw new TypeError("Human Memory exact-access authority is unavailable");
    }
    publicKey = exactBytes(
      "Human Memory exact-access authority public key",
      resolved,
      V2_LIMITS.signingPublicKeyBytes,
    );
    signingBytes = signingBytesFromNormalized(request);
    if (!crypto.verify(publicKey, signingBytes, request.signature)) {
      throw new TypeError("Human Memory exact-access request signature is invalid");
    }
    const now = unixTimestamp(input.now);
    if (now < request.issuedAt || now >= request.deadlineAt) {
      throw new TypeError("Human Memory exact-access request is not currently valid");
    }
    verified = true;
    return request;
  } finally {
    wipeBytes(publicKey, signingBytes);
    if (!verified) destroyRequest(request);
  }
}
