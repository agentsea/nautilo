import { ed25519 } from "@noble/curves/ed25519.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import {
  accessRevision,
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
  type AccessRevision,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
  type NamespaceId,
  type ObjectId,
} from "../v2-types/ids.ts";
import { assertV2Range, V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  normalizeProcessorObjectSignerPrincipalV1,
  processorObjectSignerKeyIdV1,
  type ProcessorObjectSignerPrincipalV1,
} from "./processor-object-signer-v1.ts";
import {
  verifyProcessorCredentialV1,
  type ResolveCurrentProcessorCredentialIssuerPublicKeyV1,
  type VerifiedProcessorCredentialV1,
} from "./processor-credential-v1.ts";

export const PROCESSOR_SIGNER_AUTHORIZATION_DOMAIN_V1 =
  "nautilo/lattice-crypto/processor-signer-authorization/v1";
export const PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1 = 1 as const;
export const PROCESSOR_SIGNER_AUTHORIZATION_MAX_TTL_MS_V1 =
  10 * 60 * 1_000;
export const MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1 =
  64 * 1_024;

const HASH_BYTES = 32;

export interface ProcessorSignerAuthorizationUnsignedV1 {
  readonly formatVersion:
    typeof PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1;
  readonly id: string;
  readonly processorKind: "stenographer";
  readonly processorVersion: 1;
  readonly workId: string;
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly namespaceAccessRevision: AccessRevision;
  readonly policyRevision: AuthorizationRevision;
  readonly processorAuthorizationRevision: AuthorizationRevision;
  readonly issuingHumanId: HumanId;
  readonly issuingDeviceId: CryptoDeviceId;
  readonly issuingDeviceAuthorizationRevision: AuthorizationRevision;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly signer: ProcessorObjectSignerPrincipalV1;
  readonly signerPublicKey: Uint8Array;
  readonly workDescriptorHash: Uint8Array;
  readonly credentialHash: Uint8Array;
  readonly outputObjectIds: readonly ObjectId[];
  readonly maxOutputObjects: number;
  readonly maxOutputPlaintextBytes: number;
  readonly maxOutputCiphertextBytes: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ProcessorSignerAuthorizationV1
  extends ProcessorSignerAuthorizationUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface CreatedProcessorSignerAuthorizationV1 {
  readonly authorization: ProcessorSignerAuthorizationV1;
  readonly bytes: Uint8Array;
  readonly hash: Uint8Array;
}

export interface ProcessorSignerAuthorizationAuthorityContextV1
  extends ProcessorSignerAuthorizationUnsignedV1 {
  readonly purpose:
    | "issue-processor-signer-authorization"
    | "verify-historical-processor-signer-authorization";
}

export type ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1 = (
  context: ProcessorSignerAuthorizationAuthorityContextV1,
) => Uint8Array | null;

export type ResolveHistoricalProcessorSignerIssuingDevicePublicKeyV1 = (
  context: ProcessorSignerAuthorizationAuthorityContextV1,
) => Uint8Array | null;

export interface VerifiedProcessorSignerAuthorizationV1 {
  readonly authorization: ProcessorSignerAuthorizationV1;
  readonly authorizationBytes: Uint8Array;
  readonly authorizationHash: Uint8Array;
}

export interface VerifiedProcessorSignerAuthorizationForCredentialV1 {
  readonly signerAuthorization: VerifiedProcessorSignerAuthorizationV1;
  readonly credential: VerifiedProcessorCredentialV1;
}

const UNSIGNED_FIELDS = Object.freeze([
  "formatVersion",
  "id",
  "processorKind",
  "processorVersion",
  "workId",
  "namespaceId",
  "domainId",
  "domainEpoch",
  "namespaceAccessRevision",
  "policyRevision",
  "processorAuthorizationRevision",
  "issuingHumanId",
  "issuingDeviceId",
  "issuingDeviceAuthorizationRevision",
  "issuerSigningPublicKeyHash",
  "signer",
  "signerPublicKey",
  "workDescriptorHash",
  "credentialHash",
  "outputObjectIds",
  "maxOutputObjects",
  "maxOutputPlaintextBytes",
  "maxOutputCiphertextBytes",
  "issuedAt",
  "expiresAt",
] as const);
const SIGNED_FIELDS = Object.freeze([...UNSIGNED_FIELDS, "signature"]);

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
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((field, index) => field !== canonical[index])
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function exactBytes(
  label: string,
  value: unknown,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function copyIssuingDevicePublicKey(value: unknown): Uint8Array {
  return exactBytes(
    "Processor signer authorization issuing device public key",
    value,
    V2_LIMITS.signingPublicKeyBytes,
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function normalizeOutputObjectIds(
  value: readonly ObjectId[],
): readonly ObjectId[] {
  if (!Array.isArray(value as unknown)) {
    throw new TypeError(
      "Processor signer authorization output objects must be an array",
    );
  }
  assertV2Range(
    "Processor signer authorization output object count",
    value.length,
    1,
    V2_LIMITS.batchItems,
  );
  const normalized = value.map((item) => objectId(item));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]! >= normalized[index]!) {
      throw new TypeError(
        "Processor signer authorization output objects must be canonical and unique",
      );
    }
  }
  return Object.freeze(normalized);
}

function destroyUnsigned(
  value: ProcessorSignerAuthorizationUnsignedV1,
): void {
  value.issuerSigningPublicKeyHash.fill(0);
  value.signer.workDescriptorHash.fill(0);
  value.signerPublicKey.fill(0);
  value.workDescriptorHash.fill(0);
  value.credentialHash.fill(0);
}

function normalizeUnsigned(
  value: ProcessorSignerAuthorizationUnsignedV1,
): ProcessorSignerAuthorizationUnsignedV1 {
  assertObject("Processor signer authorization", value);
  assertExactFields(
    "Processor signer authorization",
    value,
    UNSIGNED_FIELDS,
  );
  if (
    value.formatVersion
      !== PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1
  ) {
    throw new TypeError(
      "Processor signer authorization format version is invalid",
    );
  }
  if (
    value.processorKind !== "stenographer"
    || value.processorVersion !== 1
  ) {
    throw new TypeError(
      "Processor signer authorization processor is invalid",
    );
  }
  assertPortableId("Processor signer authorization id", value.id);
  assertPortableId("Processor signer authorization work id", value.workId);
  const normalizedNamespaceId = namespaceId(value.namespaceId);
  const normalizedDomainId = cryptoDomainId(value.domainId);
  const normalizedDomainEpoch = domainEpoch(value.domainEpoch);
  const normalizedNamespaceAccessRevision =
    accessRevision(value.namespaceAccessRevision);
  const normalizedPolicyRevision =
    authorizationRevision(value.policyRevision);
  const normalizedProcessorAuthorizationRevision =
    authorizationRevision(value.processorAuthorizationRevision);
  const normalizedIssuingHumanId = humanId(value.issuingHumanId);
  const normalizedIssuingDeviceId =
    cryptoDeviceId(value.issuingDeviceId);
  const normalizedIssuingDeviceAuthorizationRevision =
    authorizationRevision(value.issuingDeviceAuthorizationRevision);
  const issuerSigningPublicKeyHash = exactBytes(
    "Processor signer authorization issuer key hash",
    value.issuerSigningPublicKeyHash,
    HASH_BYTES,
  );
  let signer: ProcessorObjectSignerPrincipalV1 | undefined;
  let signerPublicKey: Uint8Array | undefined;
  let workDescriptorHash: Uint8Array | undefined;
  let credentialHash: Uint8Array | undefined;
  try {
    signer = normalizeProcessorObjectSignerPrincipalV1(value.signer);
    if (signer.processorKind !== "stenographer") throw new TypeError("Legacy signer authorization requires Stenographer");
    signerPublicKey = exactBytes(
      "Processor signer authorization signer public key",
      value.signerPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    workDescriptorHash = exactBytes(
      "Processor signer authorization work descriptor hash",
      value.workDescriptorHash,
      HASH_BYTES,
    );
    credentialHash = exactBytes(
      "Processor signer authorization credential hash",
      value.credentialHash,
      HASH_BYTES,
    );
    if (signer.signerAuthorizationId !== value.id) {
      throw new TypeError(
        "Processor signer authorization id does not match signer principal",
      );
    }
    if (!equalBytes(signer.workDescriptorHash, workDescriptorHash)) {
      throw new TypeError(
        "Processor signer authorization work descriptor does not match signer principal",
      );
    }
    const outputObjectIds = normalizeOutputObjectIds(value.outputObjectIds);
    assertV2Range(
      "Processor signer authorization maximum output objects",
      value.maxOutputObjects,
      1,
      V2_LIMITS.batchItems,
    );
    if (value.maxOutputObjects !== outputObjectIds.length) {
      throw new RangeError(
        "Processor signer authorization output object boundary is not exact",
      );
    }
    assertV2Range(
      "Processor signer authorization maximum output plaintext bytes",
      value.maxOutputPlaintextBytes,
      1,
      V2_LIMITS.plaintextBytes,
    );
    assertV2Range(
      "Processor signer authorization maximum output ciphertext bytes",
      value.maxOutputCiphertextBytes,
      1,
      V2_LIMITS.ciphertextBytes,
    );
    if (
      !Number.isSafeInteger(value.issuedAt)
      || !Number.isSafeInteger(value.expiresAt)
      || value.issuedAt < 0
      || value.expiresAt <= value.issuedAt
      || value.expiresAt - value.issuedAt
        > PROCESSOR_SIGNER_AUTHORIZATION_MAX_TTL_MS_V1
    ) {
      throw new RangeError(
        "Processor signer authorization timestamps are invalid",
      );
    }
    return Object.freeze({
      formatVersion: PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
      id: value.id,
      processorKind: "stenographer",
      processorVersion: 1,
      workId: value.workId,
      namespaceId: normalizedNamespaceId,
      domainId: normalizedDomainId,
      domainEpoch: normalizedDomainEpoch,
      namespaceAccessRevision: normalizedNamespaceAccessRevision,
      policyRevision: normalizedPolicyRevision,
      processorAuthorizationRevision:
        normalizedProcessorAuthorizationRevision,
      issuingHumanId: normalizedIssuingHumanId,
      issuingDeviceId: normalizedIssuingDeviceId,
      issuingDeviceAuthorizationRevision:
        normalizedIssuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash,
      signer,
      signerPublicKey,
      workDescriptorHash,
      credentialHash,
      outputObjectIds,
      maxOutputObjects: value.maxOutputObjects,
      maxOutputPlaintextBytes: value.maxOutputPlaintextBytes,
      maxOutputCiphertextBytes: value.maxOutputCiphertextBytes,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
    });
  } catch (error) {
    issuerSigningPublicKeyHash.fill(0);
    signer?.workDescriptorHash.fill(0);
    signerPublicKey?.fill(0);
    workDescriptorHash?.fill(0);
    credentialHash?.fill(0);
    throw error;
  }
}

function normalizeAuthorization(
  value: ProcessorSignerAuthorizationV1,
): ProcessorSignerAuthorizationV1 {
  assertObject("Processor signer authorization", value);
  assertExactFields(
    "Processor signer authorization",
    value,
    SIGNED_FIELDS,
  );
  const { signature: rawSignature, ...rawUnsigned } = value;
  const unsigned = normalizeUnsigned(rawUnsigned);
  try {
    const signature = exactBytes(
      "Processor signer authorization signature",
      rawSignature,
      V2_LIMITS.signatureBytes,
    );
    return Object.freeze({ ...unsigned, signature });
  } catch (error) {
    destroyUnsigned(unsigned);
    throw error;
  }
}

function signingBytesFromNormalized(
  value: ProcessorSignerAuthorizationUnsignedV1,
): Uint8Array {
  return concatV2(
    frameText(PROCESSOR_SIGNER_AUTHORIZATION_DOMAIN_V1),
    encodeU32(PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1),
    frameText(value.id),
    frameText(value.processorKind),
    encodeU32(value.processorVersion),
    frameText(value.workId),
    frameText(value.namespaceId),
    frameText(value.domainId),
    encodeU64(value.domainEpoch),
    encodeU64(value.namespaceAccessRevision),
    encodeU64(value.policyRevision),
    encodeU64(value.processorAuthorizationRevision),
    frameText(value.issuingHumanId),
    frameText(value.issuingDeviceId),
    encodeU64(value.issuingDeviceAuthorizationRevision),
    frame(value.issuerSigningPublicKeyHash),
    frameText(value.signer.kind),
    frameText(value.signer.processorKind),
    encodeU32(value.signer.processorVersion),
    frameText(value.signer.signerAuthorizationId),
    frame(value.signer.workDescriptorHash),
    frameText(value.signer.signerKeyId),
    frame(value.signerPublicKey),
    frame(value.workDescriptorHash),
    frame(value.credentialHash),
    encodeU32(value.outputObjectIds.length),
    ...value.outputObjectIds.map(frameText),
    encodeU32(value.maxOutputObjects),
    encodeU64(value.maxOutputPlaintextBytes),
    encodeU64(value.maxOutputCiphertextBytes),
    encodeU64(value.issuedAt),
    encodeU64(value.expiresAt),
  );
}

export function processorSignerAuthorizationSigningBytesV1(
  value: ProcessorSignerAuthorizationUnsignedV1,
): Uint8Array {
  const normalized = normalizeUnsigned(value);
  try {
    return signingBytesFromNormalized(normalized);
  } finally {
    destroyUnsigned(normalized);
  }
}

export function encodeProcessorSignerAuthorizationV1(
  value: ProcessorSignerAuthorizationV1,
): Uint8Array {
  const normalized = normalizeAuthorization(value);
  try {
    return concatV2(
      signingBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
  } finally {
    destroyUnsigned(normalized);
    normalized.signature.fill(0);
  }
}

export function decodeProcessorSignerAuthorizationV1(
  bytes: Uint8Array,
): ProcessorSignerAuthorizationV1 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(
      "Processor signer authorization bytes must be Uint8Array",
    );
  }
  if (bytes.length > MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1) {
    throw new CanonicalDecodingError(
      "Processor signer authorization exceeds its wire limit",
    );
  }
  const reader = new StrictDecoder(bytes);
  try {
    const domain = reader.readText(
      utf8V2(PROCESSOR_SIGNER_AUTHORIZATION_DOMAIN_V1).length,
    );
    if (domain !== PROCESSOR_SIGNER_AUTHORIZATION_DOMAIN_V1) {
      throw new CanonicalDecodingError(
        "Processor signer authorization domain mismatch",
      );
    }
    const formatVersion = reader.readVersion(
      PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
    ) as 1;
    const id = reader.readText(V2_LIMITS.idBytes);
    const processorKind = reader.readText(
      V2_LIMITS.schemeIdBytes,
    ) as "stenographer";
    const processorVersion = reader.readVersion(1) as 1;
    const workId = reader.readText(V2_LIMITS.idBytes);
    const decodedNamespaceId =
      namespaceId(reader.readText(V2_LIMITS.idBytes));
    const decodedDomainId =
      cryptoDomainId(reader.readText(V2_LIMITS.idBytes));
    const decodedDomainEpoch = domainEpoch(reader.readU64());
    const namespaceAccessRevision =
      accessRevision(reader.readU64());
    const policyRevision = authorizationRevision(reader.readU64());
    const processorAuthorizationRevision =
      authorizationRevision(reader.readU64());
    const issuingHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
    const issuingDeviceId =
      cryptoDeviceId(reader.readText(V2_LIMITS.idBytes));
    const issuingDeviceAuthorizationRevision =
      authorizationRevision(reader.readU64());
    const issuerSigningPublicKeyHash = reader.readFrame(HASH_BYTES);
    const signerKind = reader.readText(
      V2_LIMITS.schemeIdBytes,
    ) as "processor_invocation";
    const signerProcessorKind = reader.readText(
      V2_LIMITS.schemeIdBytes,
    ) as "stenographer";
    const signerProcessorVersion = reader.readVersion(1) as 1;
    const signerAuthorizationId = reader.readText(V2_LIMITS.idBytes);
    const signerWorkDescriptorHash = reader.readFrame(HASH_BYTES);
    const signerKeyId = reader.readText(V2_LIMITS.idBytes);
    const signerPublicKey = reader.readFrame(
      V2_LIMITS.signingPublicKeyBytes,
    );
    const workDescriptorHash = reader.readFrame(HASH_BYTES);
    const credentialHash = reader.readFrame(HASH_BYTES);
    const outputCount = reader.readCount(V2_LIMITS.batchItems);
    const outputObjectIds = Array.from(
      { length: outputCount },
      () => objectId(reader.readText(V2_LIMITS.idBytes)),
    );
    const maxOutputObjects = reader.readCount(V2_LIMITS.batchItems);
    const maxOutputPlaintextBytes = reader.readU64();
    const maxOutputCiphertextBytes = reader.readU64();
    const issuedAt = reader.readU64();
    const expiresAt = reader.readU64();
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    reader.assertFinished();
    return normalizeAuthorization({
      formatVersion,
      id,
      processorKind,
      processorVersion,
      workId,
      namespaceId: decodedNamespaceId,
      domainId: decodedDomainId,
      domainEpoch: decodedDomainEpoch,
      namespaceAccessRevision,
      policyRevision,
      processorAuthorizationRevision,
      issuingHumanId,
      issuingDeviceId,
      issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash,
      signer: {
        kind: signerKind,
        processorKind: signerProcessorKind,
        processorVersion: signerProcessorVersion,
        signerAuthorizationId,
        workDescriptorHash: signerWorkDescriptorHash,
        signerKeyId,
      },
      signerPublicKey,
      workDescriptorHash,
      credentialHash,
      outputObjectIds,
      maxOutputObjects,
      maxOutputPlaintextBytes,
      maxOutputCiphertextBytes,
      issuedAt,
      expiresAt,
      signature,
    });
  } finally {
    reader.destroy(true);
  }
}

export function createProcessorSignerAuthorizationV1(
  crypto: LatticeCrypto,
  value: ProcessorSignerAuthorizationUnsignedV1,
  issuingDevicePrivateKey: Uint8Array,
): CreatedProcessorSignerAuthorizationV1 {
  const unsigned = normalizeUnsigned(value);
  const privateKey = exactBytes(
    "Processor signer authorization issuing device private key",
    issuingDevicePrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  let publicKey: Uint8Array | undefined;
  let publicKeyHash: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  try {
    publicKey = copyIssuingDevicePublicKey(
      ed25519.getPublicKey(privateKey),
    );
    publicKeyHash = exactBytes(
      "Processor signer authorization issuing device public key hash",
      crypto.hash(publicKey),
      HASH_BYTES,
    );
    if (!equalBytes(publicKeyHash, unsigned.issuerSigningPublicKeyHash)) {
      throw new TypeError(
        "Processor signer authorization issuer key hash does not match private key",
      );
    }
    if (
      processorObjectSignerKeyIdV1(crypto, unsigned.signerPublicKey)
      !== unsigned.signer.signerKeyId
    ) {
      throw new TypeError(
        "Processor signer authorization signer key id does not match public key",
      );
    }
    signingBytes = signingBytesFromNormalized(unsigned);
    const signature = exactBytes(
      "Processor signer authorization signature",
      crypto.sign(privateKey, signingBytes),
      V2_LIMITS.signatureBytes,
    );
    const authorization = normalizeAuthorization({
      ...unsigned,
      signature,
    });
    signature.fill(0);
    const bytes = encodeProcessorSignerAuthorizationV1(authorization);
    return Object.freeze({
      authorization,
      bytes,
      hash: crypto.hash(bytes),
    });
  } finally {
    signingBytes?.fill(0);
    publicKeyHash?.fill(0);
    publicKey?.fill(0);
    privateKey.fill(0);
    destroyUnsigned(unsigned);
  }
}

function authorityContext(
  value: ProcessorSignerAuthorizationUnsignedV1,
  purpose: ProcessorSignerAuthorizationAuthorityContextV1["purpose"],
): ProcessorSignerAuthorizationAuthorityContextV1 {
  const normalized = normalizeUnsigned(value);
  return Object.freeze({ purpose, ...normalized });
}

function verifyWithResolver(
  crypto: LatticeCrypto,
  authorizationBytes: Uint8Array,
  purpose: ProcessorSignerAuthorizationAuthorityContextV1["purpose"],
  resolve: (
    context: ProcessorSignerAuthorizationAuthorityContextV1,
  ) => Uint8Array | null,
): VerifiedProcessorSignerAuthorizationV1 {
  const authorization = decodeProcessorSignerAuthorizationV1(
    authorizationBytes,
  );
  let context: ProcessorSignerAuthorizationAuthorityContextV1 | undefined;
  let publicKey: Uint8Array | undefined;
  let publicKeyHash: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  try {
    if (
      processorObjectSignerKeyIdV1(crypto, authorization.signerPublicKey)
      !== authorization.signer.signerKeyId
    ) {
      throw new TypeError(
        "Processor signer authorization signer key id is invalid",
      );
    }
    const { signature: _signature, ...unsigned } = authorization;
    context = authorityContext(unsigned, purpose);
    const resolved = resolve(context);
    if (resolved === null) {
      throw new TypeError(
        "Processor signer authorization issuing device is not authorized",
      );
    }
    publicKey = exactBytes(
      "Processor signer authorization issuing device public key",
      resolved,
      V2_LIMITS.signingPublicKeyBytes,
    );
    publicKeyHash = exactBytes(
      "Processor signer authorization issuing device public key hash",
      crypto.hash(publicKey),
      HASH_BYTES,
    );
    if (!equalBytes(publicKeyHash, authorization.issuerSigningPublicKeyHash)) {
      throw new TypeError(
        "Processor signer authorization issuing device key is invalid",
      );
    }
    signingBytes = signingBytesFromNormalized(authorization);
    if (!crypto.verify(publicKey, signingBytes, authorization.signature)) {
      throw new TypeError(
        "Processor signer authorization signature is invalid",
      );
    }
    const ownedBytes = copyOwnedBytesV2(authorizationBytes);
    return Object.freeze({
      authorization,
      authorizationBytes: ownedBytes,
      authorizationHash: crypto.hash(ownedBytes),
    });
  } finally {
    if (context !== undefined) destroyUnsigned(context);
    signingBytes?.fill(0);
    publicKeyHash?.fill(0);
    publicKey?.fill(0);
  }
}

export function verifyCurrentProcessorSignerAuthorizationV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly authorizationBytes: Uint8Array;
    readonly now: number;
    readonly resolveCurrentIssuingDevicePublicKey:
      ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1;
  }>,
): VerifiedProcessorSignerAuthorizationV1 {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new TypeError(
      "Processor signer authorization current time is invalid",
    );
  }
  const decoded = decodeProcessorSignerAuthorizationV1(
    input.authorizationBytes,
  );
  try {
    if (input.now < decoded.issuedAt || input.now >= decoded.expiresAt) {
      throw new TypeError(
        "Processor signer authorization is not currently valid",
      );
    }
  } finally {
    destroyUnsigned(decoded);
    decoded.signature.fill(0);
  }
  return verifyWithResolver(
    crypto,
    input.authorizationBytes,
    "issue-processor-signer-authorization",
    input.resolveCurrentIssuingDevicePublicKey,
  );
}

export function verifyHistoricalProcessorSignerAuthorizationV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly authorizationBytes: Uint8Array;
    readonly resolveHistoricalIssuingDevicePublicKey:
      ResolveHistoricalProcessorSignerIssuingDevicePublicKeyV1;
  }>,
): VerifiedProcessorSignerAuthorizationV1 {
  return verifyWithResolver(
    crypto,
    input.authorizationBytes,
    "verify-historical-processor-signer-authorization",
    input.resolveHistoricalIssuingDevicePublicKey,
  );
}

function equalIds(left: readonly ObjectId[], right: readonly ObjectId[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function destroyVerifiedCredential(
  value: VerifiedProcessorCredentialV1,
): void {
  value.credential.workDescriptorBytes.fill(0);
  value.credential.workDescriptorHash.fill(0);
  value.credential.issuerSigningPublicKeyHash.fill(0);
  value.credential.signer.workDescriptorHash.fill(0);
  value.credential.signerPublicKey.fill(0);
  value.credential.encryptedSecret.fill(0);
  value.credential.signature.fill(0);
  value.credentialBytes.fill(0);
  value.credentialHash.fill(0);
  value.workDescriptor.recipientPublicKey.fill(0);
  value.workDescriptor.source.fingerprint.fill(0);
}

function destroyVerifiedSignerAuthorization(
  value: VerifiedProcessorSignerAuthorizationV1,
): void {
  destroyUnsigned(value.authorization);
  value.authorization.signature.fill(0);
  value.authorizationBytes.fill(0);
  value.authorizationHash.fill(0);
}

/**
 * Verify a current signer certificate and its exact referenced credential as
 * one indivisible authority fact. Callers that accept or persist certificates
 * must use this composition rather than validating the two signed records
 * independently.
 */
export async function verifyCurrentProcessorSignerAuthorizationForCredentialV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly authorizationBytes: Uint8Array;
    readonly credentialBytes: Uint8Array;
    readonly now: number;
    readonly resolveCurrentCredentialIssuerPublicKey:
      ResolveCurrentProcessorCredentialIssuerPublicKeyV1;
    readonly resolveCurrentSignerIssuingDevicePublicKey:
      ResolveCurrentProcessorSignerIssuingDevicePublicKeyV1;
  }>,
): Promise<VerifiedProcessorSignerAuthorizationForCredentialV1> {
  const credential = await verifyProcessorCredentialV1(crypto, {
    credentialBytes: input.credentialBytes,
    now: input.now,
    resolveCurrentIssuerPublicKey:
      input.resolveCurrentCredentialIssuerPublicKey,
  });
  let signerAuthorization:
    | VerifiedProcessorSignerAuthorizationV1
    | undefined;
  try {
    signerAuthorization = verifyCurrentProcessorSignerAuthorizationV1(
      crypto,
      {
        authorizationBytes: input.authorizationBytes,
        now: input.now,
        resolveCurrentIssuingDevicePublicKey:
          input.resolveCurrentSignerIssuingDevicePublicKey,
      },
    );
    const authorization = signerAuthorization.authorization;
    const descriptor = credential.workDescriptor;
    if (
      descriptor.subject.kind !== "processor"
      || authorization.processorKind !== "stenographer"
      || authorization.processorVersion !== 1
      || authorization.processorAuthorizationRevision
        !== descriptor.subject.authorizationRevision
      || authorization.workId !== descriptor.workId
      || authorization.namespaceId !== descriptor.namespaceId
      || authorization.domainId !== descriptor.domainId
      || authorization.domainEpoch !== descriptor.expectedDomainEpoch
      || authorization.namespaceAccessRevision
        !== descriptor.expectedNamespaceAccessRevision
      || authorization.policyRevision !== descriptor.expectedPolicyRevision
      || authorization.issuingHumanId
        !== credential.credential.issuingHumanId
      || authorization.issuingDeviceId
        !== credential.credential.issuingDeviceId
      || authorization.issuingDeviceAuthorizationRevision
        !== credential.credential.issuingDeviceAuthorizationRevision
      || !equalBytes(
        authorization.issuerSigningPublicKeyHash,
        credential.credential.issuerSigningPublicKeyHash,
      )
      || authorization.signer.signerAuthorizationId
        !== credential.credential.signer.signerAuthorizationId
      || authorization.signer.signerKeyId
        !== credential.credential.signer.signerKeyId
      || !equalBytes(
        authorization.signer.workDescriptorHash,
        credential.credential.signer.workDescriptorHash,
      )
      || !equalBytes(
        authorization.signerPublicKey,
        credential.credential.signerPublicKey,
      )
      || !equalBytes(
        authorization.workDescriptorHash,
        credential.credential.workDescriptorHash,
      )
      || !equalBytes(
        authorization.credentialHash,
        credential.credentialHash,
      )
      || !equalIds(
        authorization.outputObjectIds,
        descriptor.outputObjectIds,
      )
      || authorization.maxOutputObjects
        !== descriptor.maximumOutputObjectCount
      || authorization.maxOutputPlaintextBytes
        !== descriptor.maximumPlaintextBytes
      || authorization.maxOutputCiphertextBytes
        !== descriptor.maximumCiphertextBytes
      || authorization.issuedAt !== credential.credential.issuedAt
      || authorization.expiresAt !== credential.credential.expiresAt
    ) {
      throw new TypeError(
        "Processor signer authorization does not match the exact credential",
      );
    }
    const result = Object.freeze({
      signerAuthorization,
      credential,
    });
    signerAuthorization = undefined;
    return result;
  } catch (error) {
    destroyVerifiedCredential(credential);
    throw error;
  } finally {
    if (signerAuthorization !== undefined) {
      destroyVerifiedSignerAuthorization(signerAuthorization);
    }
  }
}
