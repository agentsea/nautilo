import { sha256 } from "@noble/hashes/sha2.js";

import type { LatticeCrypto } from "../crypto/index.ts";
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
  accessRevision,
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  type AccessRevision,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
  type NamespaceId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1,
  decodeProcessorCredentialV1,
  processorCredentialSigningBytesV1,
  type ProcessorCredentialV1,
} from "./processor-credential-v1.ts";
import {
  processorObjectSignerKeyIdV1,
} from "./processor-object-signer-v1.ts";
import {
  decodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "./work-descriptor-v1.ts";

export const BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1 =
  1 as const;
export const BACKGROUND_AUTHORIZATION_RESPONSE_DOMAIN_V1 =
  "nautilo/lattice-crypto/background-authorization-response/v1";
export const BACKGROUND_AUTHORIZATION_RESPONSE_MAX_TTL_MS_V1 =
  10 * 60 * 1_000;
export const MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1 =
  MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1 + 4 * 1_024;

const HASH_BYTES = 32;

export interface BackgroundAuthorizationResponseUnsignedV1 {
  readonly formatVersion:
    typeof BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1;
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly credentialBytes: Uint8Array;
  readonly credentialHash: Uint8Array;
  readonly issuingHumanId: HumanId;
  readonly issuingDeviceId: CryptoDeviceId;
  readonly issuingDeviceAuthorizationRevision: AuthorizationRevision;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly workDescriptorHash: Uint8Array;
  readonly domainEpoch: DomainEpoch;
  readonly namespaceAccessRevision: AccessRevision;
  readonly policyRevision: AuthorizationRevision;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface BackgroundAuthorizationResponseV1
  extends BackgroundAuthorizationResponseUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface CreatedBackgroundAuthorizationResponseV1 {
  readonly response: BackgroundAuthorizationResponseV1;
  readonly bytes: Uint8Array;
  readonly hash: Uint8Array;
}

export interface BackgroundAuthorizationResponseIssuerContextV1 {
  readonly purpose:
    | "verify-current-background-authorization-response"
    | "verify-historical-background-authorization-response";
  readonly requestId: string;
  readonly recipientGeneration: number;
  readonly recipientKeyId: string;
  readonly recipientPublicKey: Uint8Array;
  readonly credentialHash: Uint8Array;
  readonly issuingHumanId: HumanId;
  readonly issuingDeviceId: CryptoDeviceId;
  readonly issuingDeviceAuthorizationRevision: AuthorizationRevision;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly workDescriptorHash: Uint8Array;
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly namespaceAccessRevision: AccessRevision;
  readonly policyRevision: AuthorizationRevision;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export type ResolveBackgroundAuthorizationResponseIssuerPublicKeyV1 = (
  context: BackgroundAuthorizationResponseIssuerContextV1,
) => Uint8Array | null | Promise<Uint8Array | null>;

export interface VerifiedBackgroundAuthorizationResponseV1 {
  readonly response: BackgroundAuthorizationResponseV1;
  readonly responseBytes: Uint8Array;
  readonly responseHash: Uint8Array;
  readonly credential: ProcessorCredentialV1;
  readonly credentialHash: Uint8Array;
  readonly workDescriptor: BackgroundWorkDescriptorV1;
}

const UNSIGNED_FIELDS = Object.freeze([
  "formatVersion",
  "requestId",
  "recipientGeneration",
  "recipientKeyId",
  "recipientPublicKey",
  "credentialBytes",
  "credentialHash",
  "issuingHumanId",
  "issuingDeviceId",
  "issuingDeviceAuthorizationRevision",
  "issuerSigningPublicKeyHash",
  "workDescriptorHash",
  "domainEpoch",
  "namespaceAccessRevision",
  "policyRevision",
  "issuedAt",
  "notBefore",
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

function boundedBytes(
  label: string,
  value: unknown,
  maximum: number,
): Uint8Array {
  if (
    !(value instanceof Uint8Array)
    || value.length < 1
    || value.length > maximum
  ) {
    throw new TypeError(`${label} must contain 1-${maximum} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function destroyDescriptor(value: BackgroundWorkDescriptorV1): void {
  value.recipientPublicKey.fill(0);
  value.source.fingerprint.fill(0);
}

function destroyCredential(value: ProcessorCredentialV1): void {
  value.workDescriptorBytes.fill(0);
  value.workDescriptorHash.fill(0);
  value.issuerSigningPublicKeyHash.fill(0);
  value.signer.workDescriptorHash.fill(0);
  value.signerPublicKey.fill(0);
  value.encryptedSecret.fill(0);
  value.signature.fill(0);
}

function destroyUnsigned(
  value: BackgroundAuthorizationResponseUnsignedV1,
): void {
  value.recipientPublicKey.fill(0);
  value.credentialBytes.fill(0);
  value.credentialHash.fill(0);
  value.issuerSigningPublicKeyHash.fill(0);
  value.workDescriptorHash.fill(0);
}

function destroyResponse(
  value: BackgroundAuthorizationResponseV1,
): void {
  destroyUnsigned(value);
  value.signature.fill(0);
}

function decodeBoundCredential(
  credentialBytes: Uint8Array,
): Readonly<{
  credential: ProcessorCredentialV1;
  descriptor: BackgroundWorkDescriptorV1;
}> {
  const credential = decodeProcessorCredentialV1(credentialBytes);
  try {
    const descriptor = decodeBackgroundWorkDescriptorV1(
      credential.workDescriptorBytes,
    );
    return { credential, descriptor };
  } catch (error) {
    destroyCredential(credential);
    throw error;
  }
}

function normalizeUnsigned(
  value: BackgroundAuthorizationResponseUnsignedV1,
): BackgroundAuthorizationResponseUnsignedV1 {
  assertObject("Background authorization response", value);
  assertExactFields(
    "Background authorization response",
    value,
    UNSIGNED_FIELDS,
  );
  if (
    value.formatVersion
      !== BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1
  ) {
    throw new TypeError(
      "Background authorization response format version is invalid",
    );
  }
  assertPortableId(
    "Background authorization response request id",
    value.requestId,
  );
  assertU64Counter(
    "Background authorization response recipient generation",
    value.recipientGeneration,
  );
  assertPortableId(
    "Background authorization response recipient key id",
    value.recipientKeyId,
  );
  let recipientPublicKey: Uint8Array | undefined;
  let credentialBytes: Uint8Array | undefined;
  let credentialHash: Uint8Array | undefined;
  let issuerSigningPublicKeyHash: Uint8Array | undefined;
  let workDescriptorHash: Uint8Array | undefined;
  let credential: ProcessorCredentialV1 | undefined;
  let descriptor: BackgroundWorkDescriptorV1 | undefined;
  try {
    recipientPublicKey = exactBytes(
      "Background authorization response recipient public key",
      value.recipientPublicKey,
      V2_LIMITS.hpkePublicKeyBytes,
    );
    credentialBytes = boundedBytes(
      "Background authorization response credential",
      value.credentialBytes,
      MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1,
    );
    credentialHash = exactBytes(
      "Background authorization response credential hash",
      value.credentialHash,
      HASH_BYTES,
    );
    if (!equalBytes(sha256(credentialBytes), credentialHash)) {
      throw new TypeError(
        "Background authorization response credential hash does not match",
      );
    }
    ({ credential, descriptor } = decodeBoundCredential(credentialBytes));
    const issuingHumanId = humanId(value.issuingHumanId);
    const issuingDeviceId = cryptoDeviceId(value.issuingDeviceId);
    const issuingDeviceAuthorizationRevision = authorizationRevision(
      value.issuingDeviceAuthorizationRevision,
    );
    issuerSigningPublicKeyHash = exactBytes(
      "Background authorization response issuer key hash",
      value.issuerSigningPublicKeyHash,
      HASH_BYTES,
    );
    workDescriptorHash = exactBytes(
      "Background authorization response work descriptor hash",
      value.workDescriptorHash,
      HASH_BYTES,
    );
    const normalizedDomainEpoch = domainEpoch(value.domainEpoch);
    const normalizedNamespaceAccessRevision = accessRevision(
      value.namespaceAccessRevision,
    );
    const normalizedPolicyRevision = authorizationRevision(
      value.policyRevision,
    );
    assertU64Counter(
      "Background authorization response issued-at",
      value.issuedAt,
    );
    assertU64Counter(
      "Background authorization response not-before",
      value.notBefore,
    );
    assertU64Counter(
      "Background authorization response expiry",
      value.expiresAt,
    );
    if (
      value.issuedAt > value.notBefore
      || value.notBefore >= value.expiresAt
      || value.expiresAt - value.issuedAt
        > BACKGROUND_AUTHORIZATION_RESPONSE_MAX_TTL_MS_V1
    ) {
      throw new RangeError(
        "Background authorization response timestamps exceed its ten-minute TTL",
      );
    }
    if (
      value.requestId !== descriptor.requestId
      || value.recipientGeneration !== descriptor.recipientGeneration
      || value.recipientKeyId !== descriptor.recipientKeyId
      || !equalBytes(recipientPublicKey, descriptor.recipientPublicKey)
      || issuingHumanId !== credential.issuingHumanId
      || issuingDeviceId !== credential.issuingDeviceId
      || issuingDeviceAuthorizationRevision
        !== credential.issuingDeviceAuthorizationRevision
      || !equalBytes(
        issuerSigningPublicKeyHash,
        credential.issuerSigningPublicKeyHash,
      )
      || !equalBytes(workDescriptorHash, credential.workDescriptorHash)
      || normalizedDomainEpoch !== descriptor.expectedDomainEpoch
      || normalizedNamespaceAccessRevision
        !== descriptor.expectedNamespaceAccessRevision
      || normalizedPolicyRevision !== descriptor.expectedPolicyRevision
      || value.issuedAt !== credential.issuedAt
      || value.notBefore !== credential.notBefore
      || value.expiresAt !== credential.expiresAt
    ) {
      throw new TypeError(
        "Background authorization response does not match its credential",
      );
    }
    return Object.freeze({
      formatVersion:
        BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1,
      requestId: value.requestId,
      recipientGeneration: value.recipientGeneration,
      recipientKeyId: value.recipientKeyId,
      recipientPublicKey,
      credentialBytes,
      credentialHash,
      issuingHumanId,
      issuingDeviceId,
      issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash,
      workDescriptorHash,
      domainEpoch: normalizedDomainEpoch,
      namespaceAccessRevision: normalizedNamespaceAccessRevision,
      policyRevision: normalizedPolicyRevision,
      issuedAt: value.issuedAt,
      notBefore: value.notBefore,
      expiresAt: value.expiresAt,
    });
  } catch (error) {
    recipientPublicKey?.fill(0);
    credentialBytes?.fill(0);
    credentialHash?.fill(0);
    issuerSigningPublicKeyHash?.fill(0);
    workDescriptorHash?.fill(0);
    throw error;
  } finally {
    if (credential !== undefined) destroyCredential(credential);
    if (descriptor !== undefined) destroyDescriptor(descriptor);
  }
}

function normalizeResponse(
  value: BackgroundAuthorizationResponseV1,
): BackgroundAuthorizationResponseV1 {
  assertObject("Background authorization response", value);
  assertExactFields(
    "Background authorization response",
    value,
    SIGNED_FIELDS,
  );
  const { signature: rawSignature, ...rawUnsigned } = value;
  const unsigned = normalizeUnsigned(rawUnsigned);
  try {
    const signature = exactBytes(
      "Background authorization response signature",
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
  value: BackgroundAuthorizationResponseUnsignedV1,
): Uint8Array {
  return concatV2(
    frameText(BACKGROUND_AUTHORIZATION_RESPONSE_DOMAIN_V1),
    encodeU32(BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1),
    frameText(value.requestId),
    encodeU64(value.recipientGeneration),
    frameText(value.recipientKeyId),
    frame(value.recipientPublicKey),
    frame(value.credentialBytes),
    frame(value.credentialHash),
    frameText(value.issuingHumanId),
    frameText(value.issuingDeviceId),
    encodeU64(value.issuingDeviceAuthorizationRevision),
    frame(value.issuerSigningPublicKeyHash),
    frame(value.workDescriptorHash),
    encodeU64(value.domainEpoch),
    encodeU64(value.namespaceAccessRevision),
    encodeU64(value.policyRevision),
    encodeU64(value.issuedAt),
    encodeU64(value.notBefore),
    encodeU64(value.expiresAt),
  );
}

export function backgroundAuthorizationResponseSigningBytesV1(
  value: BackgroundAuthorizationResponseUnsignedV1,
): Uint8Array {
  const normalized = normalizeUnsigned(value);
  try {
    return signingBytesFromNormalized(normalized);
  } finally {
    destroyUnsigned(normalized);
  }
}

export function encodeBackgroundAuthorizationResponseV1(
  value: BackgroundAuthorizationResponseV1,
): Uint8Array {
  const normalized = normalizeResponse(value);
  try {
    const encoded = concatV2(
      signingBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (
      encoded.length
        > MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1
    ) {
      encoded.fill(0);
      throw new RangeError(
        "Background authorization response exceeds its wire limit",
      );
    }
    return encoded;
  } finally {
    destroyResponse(normalized);
  }
}

export function decodeBackgroundAuthorizationResponseV1(
  bytes: Uint8Array,
): BackgroundAuthorizationResponseV1 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(
      "Background authorization response bytes must be Uint8Array",
    );
  }
  if (
    bytes.length
      > MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1
  ) {
    throw new RangeError(
      "Background authorization response exceeds its wire limit",
    );
  }
  const raw = decodeExact(bytes, (reader): BackgroundAuthorizationResponseV1 => {
    const domain = reader.readText(
      utf8V2(BACKGROUND_AUTHORIZATION_RESPONSE_DOMAIN_V1).length,
    );
    if (domain !== BACKGROUND_AUTHORIZATION_RESPONSE_DOMAIN_V1) {
      throw new CanonicalDecodingError(
        "Background authorization response domain mismatch",
      );
    }
    return {
      formatVersion: reader.readVersion(
        BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1,
      ) as typeof BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1,
      requestId: reader.readText(V2_LIMITS.idBytes),
      recipientGeneration: reader.readU64(),
      recipientKeyId: reader.readText(V2_LIMITS.idBytes),
      recipientPublicKey: reader.readFrame(
        V2_LIMITS.hpkePublicKeyBytes,
      ),
      credentialBytes: reader.readFrame(
        MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1,
      ),
      credentialHash: reader.readFrame(HASH_BYTES),
      issuingHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      issuingDeviceId: cryptoDeviceId(
        reader.readText(V2_LIMITS.idBytes),
      ),
      issuingDeviceAuthorizationRevision: authorizationRevision(
        reader.readU64(),
      ),
      issuerSigningPublicKeyHash: reader.readFrame(HASH_BYTES),
      workDescriptorHash: reader.readFrame(HASH_BYTES),
      domainEpoch: domainEpoch(reader.readU64()),
      namespaceAccessRevision: accessRevision(reader.readU64()),
      policyRevision: authorizationRevision(reader.readU64()),
      issuedAt: reader.readU64(),
      notBefore: reader.readU64(),
      expiresAt: reader.readU64(),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let normalized: BackgroundAuthorizationResponseV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeResponse(raw);
    canonical = encodeBackgroundAuthorizationResponseV1(normalized);
    if (!equalBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Background authorization response is noncanonical",
      );
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyResponse(raw);
    if (normalized !== undefined) destroyResponse(normalized);
    canonical?.fill(0);
  }
}

function issuerContext(
  purpose: BackgroundAuthorizationResponseIssuerContextV1["purpose"],
  response: BackgroundAuthorizationResponseV1,
  descriptor: BackgroundWorkDescriptorV1,
): BackgroundAuthorizationResponseIssuerContextV1 {
  return Object.freeze({
    purpose,
    requestId: response.requestId,
    recipientGeneration: response.recipientGeneration,
    recipientKeyId: response.recipientKeyId,
    recipientPublicKey: copyOwnedBytesV2(response.recipientPublicKey),
    credentialHash: copyOwnedBytesV2(response.credentialHash),
    issuingHumanId: response.issuingHumanId,
    issuingDeviceId: response.issuingDeviceId,
    issuingDeviceAuthorizationRevision:
      response.issuingDeviceAuthorizationRevision,
    issuerSigningPublicKeyHash:
      copyOwnedBytesV2(response.issuerSigningPublicKeyHash),
    workDescriptorHash:
      copyOwnedBytesV2(response.workDescriptorHash),
    namespaceId: namespaceId(descriptor.namespaceId),
    domainId: cryptoDomainId(descriptor.domainId),
    domainEpoch: response.domainEpoch,
    namespaceAccessRevision: response.namespaceAccessRevision,
    policyRevision: response.policyRevision,
    issuedAt: response.issuedAt,
    notBefore: response.notBefore,
    expiresAt: response.expiresAt,
  });
}

function destroyIssuerContext(
  context: BackgroundAuthorizationResponseIssuerContextV1,
): void {
  context.recipientPublicKey.fill(0);
  context.credentialHash.fill(0);
  context.issuerSigningPublicKeyHash.fill(0);
  context.workDescriptorHash.fill(0);
}

function verifyCredentialAndResponseSignatures(
  crypto: LatticeCrypto,
  response: BackgroundAuthorizationResponseV1,
  credential: ProcessorCredentialV1,
  issuerPublicKey: Uint8Array,
): void {
  if (
    processorObjectSignerKeyIdV1(
      crypto,
      credential.signerPublicKey,
    ) !== credential.signer.signerKeyId
  ) {
    throw new TypeError(
      "Background authorization response credential signer public key does not match its principal",
    );
  }
  let credentialSigningBytes: Uint8Array | undefined;
  let responseSigningBytes: Uint8Array | undefined;
  try {
    const {
      signature: _credentialSignature,
      ...credentialUnsigned
    } = credential;
    credentialSigningBytes =
      processorCredentialSigningBytesV1(credentialUnsigned);
    if (
      !crypto.verify(
        issuerPublicKey,
        credentialSigningBytes,
        credential.signature,
      )
    ) {
      throw new TypeError(
        "Background authorization response credential signature is invalid",
      );
    }
    responseSigningBytes = signingBytesFromNormalized(response);
    if (
      !crypto.verify(
        issuerPublicKey,
        responseSigningBytes,
        response.signature,
      )
    ) {
      throw new TypeError(
        "Background authorization response signature is invalid",
      );
    }
  } finally {
    credentialSigningBytes?.fill(0);
    responseSigningBytes?.fill(0);
  }
}

export function createBackgroundAuthorizationResponseV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly credentialBytes: Uint8Array;
    readonly issuingDeviceSigningPublicKey: Uint8Array;
    readonly issuingDeviceSigningPrivateKey: Uint8Array;
  }>,
): CreatedBackgroundAuthorizationResponseV1 {
  const credentialBytes = boundedBytes(
    "Background authorization response credential",
    input.credentialBytes,
    MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1,
  );
  const { credential, descriptor } =
    decodeBoundCredential(credentialBytes);
  let issuerPublicKey: Uint8Array | undefined;
  let issuerPrivateKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    issuerPublicKey = exactBytes(
      "Background authorization response issuer public key",
      input.issuingDeviceSigningPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    issuerPrivateKey = exactBytes(
      "Background authorization response issuer private key",
      input.issuingDeviceSigningPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    if (
      !equalBytes(
        crypto.hash(issuerPublicKey),
        credential.issuerSigningPublicKeyHash,
      )
    ) {
      throw new TypeError(
        "Background authorization response issuer keys do not match the credential",
      );
    }
    const {
      signature: _credentialSignature,
      ...credentialUnsigned
    } = credential;
    if (
      processorObjectSignerKeyIdV1(
        crypto,
        credential.signerPublicKey,
      ) !== credential.signer.signerKeyId
    ) {
      throw new TypeError(
        "Background authorization response credential signer public key does not match its principal",
      );
    }
    const credentialSigningBytes =
      processorCredentialSigningBytesV1(credentialUnsigned);
    try {
      if (
        !crypto.verify(
          issuerPublicKey,
          credentialSigningBytes,
          credential.signature,
        )
      ) {
        throw new TypeError(
          "Background authorization response credential signature is invalid",
        );
      }
    } finally {
      credentialSigningBytes.fill(0);
    }
    const unsigned = normalizeUnsigned({
      formatVersion:
        BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1,
      requestId: descriptor.requestId,
      recipientGeneration: descriptor.recipientGeneration,
      recipientKeyId: descriptor.recipientKeyId,
      recipientPublicKey: descriptor.recipientPublicKey,
      credentialBytes,
      credentialHash: crypto.hash(credentialBytes),
      issuingHumanId: credential.issuingHumanId,
      issuingDeviceId: credential.issuingDeviceId,
      issuingDeviceAuthorizationRevision:
        credential.issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash:
        credential.issuerSigningPublicKeyHash,
      workDescriptorHash: credential.workDescriptorHash,
      domainEpoch: descriptor.expectedDomainEpoch,
      namespaceAccessRevision:
        descriptor.expectedNamespaceAccessRevision,
      policyRevision: descriptor.expectedPolicyRevision,
      issuedAt: credential.issuedAt,
      notBefore: credential.notBefore,
      expiresAt: credential.expiresAt,
    });
    try {
      signingBytes = signingBytesFromNormalized(unsigned);
      signature = exactBytes(
        "Background authorization response signature",
        crypto.sign(issuerPrivateKey, signingBytes),
        V2_LIMITS.signatureBytes,
      );
      if (!crypto.verify(issuerPublicKey, signingBytes, signature)) {
        throw new TypeError(
          "Background authorization response issuer keys do not match",
        );
      }
      const bytes = encodeBackgroundAuthorizationResponseV1({
        ...unsigned,
        signature,
      });
      const response = decodeBackgroundAuthorizationResponseV1(bytes);
      return Object.freeze({
        response,
        bytes,
        hash: exactBytes(
          "Background authorization response hash",
          crypto.hash(bytes),
          HASH_BYTES,
        ),
      });
    } finally {
      destroyUnsigned(unsigned);
    }
  } finally {
    credentialBytes.fill(0);
    destroyCredential(credential);
    destroyDescriptor(descriptor);
    issuerPublicKey?.fill(0);
    issuerPrivateKey?.fill(0);
    signingBytes?.fill(0);
    signature?.fill(0);
  }
}

async function verifyWithResolver(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly responseBytes: Uint8Array;
    readonly purpose:
      BackgroundAuthorizationResponseIssuerContextV1["purpose"];
    readonly now?: number;
    readonly resolveIssuingDevicePublicKey:
      ResolveBackgroundAuthorizationResponseIssuerPublicKeyV1;
  }>,
): Promise<VerifiedBackgroundAuthorizationResponseV1> {
  if (typeof input.resolveIssuingDevicePublicKey !== "function") {
    throw new TypeError(
      "Background authorization response issuer resolver is required",
    );
  }
  if (input.now !== undefined) {
    assertU64Counter(
      "Background authorization response verification time",
      input.now,
    );
  }
  const responseBytes = boundedBytes(
    "Background authorization response wire",
    input.responseBytes,
    MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1,
  );
  let response: BackgroundAuthorizationResponseV1 | undefined;
  let credential: ProcessorCredentialV1 | undefined;
  let descriptor: BackgroundWorkDescriptorV1 | undefined;
  let context: BackgroundAuthorizationResponseIssuerContextV1 | undefined;
  let issuerPublicKey: Uint8Array | undefined;
  try {
    response = decodeBackgroundAuthorizationResponseV1(responseBytes);
    if (
      input.now !== undefined
      && (
        input.now < response.notBefore
        || input.now >= response.expiresAt
      )
    ) {
      throw new TypeError(
        "Background authorization response is not currently valid",
      );
    }
    ({ credential, descriptor } =
      decodeBoundCredential(response.credentialBytes));
    context = issuerContext(input.purpose, response, descriptor);
    const resolved =
      await input.resolveIssuingDevicePublicKey(context);
    if (resolved === null) {
      throw new TypeError(
        "Background authorization response issuer is not currently authorized",
      );
    }
    issuerPublicKey = exactBytes(
      "Background authorization response resolved issuer public key",
      resolved,
      V2_LIMITS.signingPublicKeyBytes,
    );
    if (
      !equalBytes(
        crypto.hash(issuerPublicKey),
        response.issuerSigningPublicKeyHash,
      )
    ) {
      throw new TypeError(
        "Background authorization response issuer public key does not match",
      );
    }
    verifyCredentialAndResponseSignatures(
      crypto,
      response,
      credential,
      issuerPublicKey,
    );
    const result = Object.freeze({
      response,
      responseBytes,
      responseHash: exactBytes(
        "Background authorization response hash",
        crypto.hash(responseBytes),
        HASH_BYTES,
      ),
      credential,
      credentialHash: copyOwnedBytesV2(response.credentialHash),
      workDescriptor: descriptor,
    });
    response = undefined;
    credential = undefined;
    descriptor = undefined;
    return result;
  } finally {
    if (response !== undefined) destroyResponse(response);
    if (credential !== undefined) destroyCredential(credential);
    if (descriptor !== undefined) destroyDescriptor(descriptor);
    if (context !== undefined) destroyIssuerContext(context);
    issuerPublicKey?.fill(0);
  }
}

export async function verifyCurrentBackgroundAuthorizationResponseV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly responseBytes: Uint8Array;
    readonly now: number;
    readonly resolveCurrentIssuingDevicePublicKey:
      ResolveBackgroundAuthorizationResponseIssuerPublicKeyV1;
  }>,
): Promise<VerifiedBackgroundAuthorizationResponseV1> {
  return verifyWithResolver(crypto, {
    responseBytes: input.responseBytes,
    purpose: "verify-current-background-authorization-response",
    now: input.now,
    resolveIssuingDevicePublicKey:
      input.resolveCurrentIssuingDevicePublicKey,
  });
}

export async function verifyHistoricalBackgroundAuthorizationResponseV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly responseBytes: Uint8Array;
    readonly resolveHistoricalIssuingDevicePublicKey:
      ResolveBackgroundAuthorizationResponseIssuerPublicKeyV1;
  }>,
): Promise<VerifiedBackgroundAuthorizationResponseV1> {
  return verifyWithResolver(crypto, {
    responseBytes: input.responseBytes,
    purpose: "verify-historical-background-authorization-response",
    resolveIssuingDevicePublicKey:
      input.resolveHistoricalIssuingDevicePublicKey,
  });
}
