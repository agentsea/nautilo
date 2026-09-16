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
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type HumanId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  createProcessorObjectSignerPublicV1,
  normalizeProcessorObjectSignerPrincipalV1,
  processorObjectSignerKeyIdV1,
  type ProcessorObjectSignerPrincipalV1,
} from "./processor-object-signer-v1.ts";
import {
  MAX_PROCESSOR_CREDENTIAL_SECRET_WIRE_BYTES_V1,
  PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1,
  decodeProcessorCredentialSecretV1,
  destroyProcessorCredentialSecretV1,
  encodeProcessorCredentialSecretV1,
  type ProcessorCredentialSecretV1,
} from "./processor-credential-secret-v1.ts";
import {
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1,
  backgroundWorkDescriptorDigestV1,
  decodeBackgroundWorkDescriptorV1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "./work-descriptor-v1.ts";

export const PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1 = 1 as const;
export const PROCESSOR_CREDENTIAL_DOMAIN_V1 =
  "nautilo/lattice-crypto/processor-credential/v1";
export const PROCESSOR_CREDENTIAL_TRANSFORM_PERMISSION_V1 =
  "stenographer.transform" as const;
export const PROCESSOR_CREDENTIAL_MAX_TTL_MS_V1 = 10 * 60 * 1_000;
export const MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1 = 192 * 1_024;

const HASH_BYTES = 32;
const MAX_ENCRYPTED_SECRET_BYTES =
  MAX_PROCESSOR_CREDENTIAL_SECRET_WIRE_BYTES_V1 + 512;

export interface ProcessorCredentialUnsignedV1 {
  readonly formatVersion: typeof PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1;
  readonly id: string;
  readonly workDescriptorBytes: Uint8Array;
  readonly workDescriptorHash: Uint8Array;
  readonly issuingHumanId: HumanId;
  readonly issuingDeviceId: CryptoDeviceId;
  readonly issuingDeviceAuthorizationRevision: AuthorizationRevision;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly signer: ProcessorObjectSignerPrincipalV1;
  readonly signerPublicKey: Uint8Array;
  readonly transformPermission:
    typeof PROCESSOR_CREDENTIAL_TRANSFORM_PERMISSION_V1;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly encryptedSecret: Uint8Array;
  readonly singleUse: true;
}

export interface ProcessorCredentialV1
  extends ProcessorCredentialUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface CreatedProcessorCredentialV1 {
  readonly credential: ProcessorCredentialV1;
  readonly bytes: Uint8Array;
  readonly hash: Uint8Array;
}

export interface ProcessorCredentialIssuerAuthorityContextV1 {
  readonly purpose: "verify-current-processor-credential";
  readonly credentialId: string;
  readonly issuingHumanId: HumanId;
  readonly issuingDeviceId: CryptoDeviceId;
  readonly issuingDeviceAuthorizationRevision: AuthorizationRevision;
  readonly issuerSigningPublicKeyHash: Uint8Array;
  readonly workDescriptorHash: Uint8Array;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly domainEpoch: number;
  readonly namespaceAccessRevision: number;
  readonly policyRevision: number;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export type ResolveCurrentProcessorCredentialIssuerPublicKeyV1 = (
  context: ProcessorCredentialIssuerAuthorityContextV1,
) =>
  | Uint8Array
  | null
  | Promise<Uint8Array | null>;

export interface VerifiedProcessorCredentialV1 {
  readonly credential: ProcessorCredentialV1;
  readonly credentialBytes: Uint8Array;
  readonly credentialHash: Uint8Array;
  readonly workDescriptor: BackgroundWorkDescriptorV1;
}

export interface OpenedProcessorCredentialV1 {
  readonly credentialId: string;
  readonly workDescriptor: BackgroundWorkDescriptorV1;
  readonly workDescriptorHash: Uint8Array;
  readonly domainId: string;
  readonly domainEpoch: number;
  readonly aiRoot: Uint8Array;
  readonly processorSignerPrivateKey: Uint8Array;
}

const UNSIGNED_FIELDS = Object.freeze([
  "formatVersion",
  "id",
  "workDescriptorBytes",
  "workDescriptorHash",
  "issuingHumanId",
  "issuingDeviceId",
  "issuingDeviceAuthorizationRevision",
  "issuerSigningPublicKeyHash",
  "signer",
  "signerPublicKey",
  "transformPermission",
  "issuedAt",
  "notBefore",
  "expiresAt",
  "encryptedSecret",
  "singleUse",
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
    throw new TypeError(
      `${label} must contain 1-${maximum} bytes`,
    );
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

function destroyUnsigned(value: ProcessorCredentialUnsignedV1): void {
  value.workDescriptorBytes.fill(0);
  value.workDescriptorHash.fill(0);
  value.issuerSigningPublicKeyHash.fill(0);
  value.signer.workDescriptorHash.fill(0);
  value.signerPublicKey.fill(0);
  value.encryptedSecret.fill(0);
}

function destroyCredential(value: ProcessorCredentialV1): void {
  destroyUnsigned(value);
  value.signature.fill(0);
}

function descriptorFromBytes(
  bytes: Uint8Array,
): BackgroundWorkDescriptorV1 {
  const descriptor = decodeBackgroundWorkDescriptorV1(bytes);
  if (
    descriptor.subject.kind !== "processor"
    || !descriptor.workKind.startsWith("stenographer.")
  ) {
    throw new TypeError(
      "Processor credential requires a Stenographer processor work descriptor",
    );
  }
  if (
    descriptor.expiresAt - descriptor.issuedAt
      > PROCESSOR_CREDENTIAL_MAX_TTL_MS_V1
  ) {
    throw new RangeError(
      "Processor credential requires a ten-minute-or-shorter work descriptor",
    );
  }
  return descriptor;
}

function normalizeUnsigned(
  value: ProcessorCredentialUnsignedV1,
): ProcessorCredentialUnsignedV1 {
  assertObject("Processor credential", value);
  assertExactFields("Processor credential", value, UNSIGNED_FIELDS);
  if (value.formatVersion !== PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1) {
    throw new TypeError("Processor credential format version is invalid");
  }
  assertPortableId("Processor credential id", value.id);
  let workDescriptorBytes: Uint8Array | undefined;
  let workDescriptorHash: Uint8Array | undefined;
  let issuerSigningPublicKeyHash: Uint8Array | undefined;
  let signer: ProcessorObjectSignerPrincipalV1 | undefined;
  let signerPublicKey: Uint8Array | undefined;
  let encryptedSecret: Uint8Array | undefined;
  try {
    workDescriptorBytes = boundedBytes(
      "Processor credential work descriptor",
      value.workDescriptorBytes,
      MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1,
    );
    const descriptor = descriptorFromBytes(workDescriptorBytes);
    workDescriptorHash = exactBytes(
      "Processor credential work descriptor hash",
      value.workDescriptorHash,
      HASH_BYTES,
    );
    if (!equalBytes(sha256(workDescriptorBytes), workDescriptorHash)) {
      throw new TypeError(
        "Processor credential work descriptor hash does not match its bytes",
      );
    }
    const issuingHumanId = humanId(value.issuingHumanId);
    const issuingDeviceId = cryptoDeviceId(value.issuingDeviceId);
    const issuingDeviceAuthorizationRevision = authorizationRevision(
      value.issuingDeviceAuthorizationRevision,
    );
    issuerSigningPublicKeyHash = exactBytes(
      "Processor credential issuer signing public key hash",
      value.issuerSigningPublicKeyHash,
      HASH_BYTES,
    );
    signer = normalizeProcessorObjectSignerPrincipalV1(value.signer);
    signerPublicKey = exactBytes(
      "Processor credential signer public key",
      value.signerPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    if (
      signer.processorKind !== "stenographer"
      || signer.processorVersion !== 1
      || !equalBytes(
        signer.workDescriptorHash,
        workDescriptorHash,
      )
    ) {
      throw new TypeError(
        "Processor credential signer does not match its work descriptor",
      );
    }
    if (
      value.transformPermission
        !== PROCESSOR_CREDENTIAL_TRANSFORM_PERMISSION_V1
    ) {
      throw new TypeError(
        "Processor credential transform permission is unsupported",
      );
    }
    assertU64Counter("Processor credential issued-at", value.issuedAt);
    assertU64Counter("Processor credential not-before", value.notBefore);
    assertU64Counter("Processor credential expiry", value.expiresAt);
    if (
      value.issuedAt !== descriptor.issuedAt
      || value.notBefore !== descriptor.notBefore
      || value.expiresAt !== descriptor.expiresAt
      || value.issuedAt > value.notBefore
      || value.notBefore >= value.expiresAt
    ) {
      throw new RangeError(
        "Processor credential timestamps do not match its work descriptor",
      );
    }
    if (
      value.expiresAt - value.issuedAt
        > PROCESSOR_CREDENTIAL_MAX_TTL_MS_V1
    ) {
      throw new RangeError(
        "Processor credential exceeds its ten-minute TTL",
      );
    }
    encryptedSecret = boundedBytes(
      "Processor credential encrypted secret",
      value.encryptedSecret,
      MAX_ENCRYPTED_SECRET_BYTES,
    );
    if (value.singleUse !== true) {
      throw new TypeError("Processor credential must be single-use");
    }
    return Object.freeze({
      formatVersion: PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1,
      id: value.id,
      workDescriptorBytes,
      workDescriptorHash,
      issuingHumanId,
      issuingDeviceId,
      issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash,
      signer,
      signerPublicKey,
      transformPermission:
        PROCESSOR_CREDENTIAL_TRANSFORM_PERMISSION_V1,
      issuedAt: value.issuedAt,
      notBefore: value.notBefore,
      expiresAt: value.expiresAt,
      encryptedSecret,
      singleUse: true,
    });
  } catch (error) {
    workDescriptorBytes?.fill(0);
    workDescriptorHash?.fill(0);
    issuerSigningPublicKeyHash?.fill(0);
    signer?.workDescriptorHash.fill(0);
    signerPublicKey?.fill(0);
    encryptedSecret?.fill(0);
    throw error;
  }
}

function normalizeCredential(
  value: ProcessorCredentialV1,
): ProcessorCredentialV1 {
  assertObject("Processor credential", value);
  assertExactFields("Processor credential", value, SIGNED_FIELDS);
  const { signature: rawSignature, ...rawUnsigned } = value;
  const unsigned = normalizeUnsigned(rawUnsigned);
  try {
    const signature = exactBytes(
      "Processor credential signature",
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
  value: ProcessorCredentialUnsignedV1,
): Uint8Array {
  return concatV2(
    frameText(PROCESSOR_CREDENTIAL_DOMAIN_V1),
    encodeU32(PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1),
    frameText(value.id),
    frame(value.workDescriptorBytes),
    frame(value.workDescriptorHash),
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
    frameText(value.transformPermission),
    encodeU64(value.issuedAt),
    encodeU64(value.notBefore),
    encodeU64(value.expiresAt),
    frame(value.encryptedSecret),
    frame(Uint8Array.of(1)),
  );
}

export function processorCredentialSigningBytesV1(
  value: ProcessorCredentialUnsignedV1,
): Uint8Array {
  const normalized = normalizeUnsigned(value);
  try {
    return signingBytesFromNormalized(normalized);
  } finally {
    destroyUnsigned(normalized);
  }
}

export function encodeProcessorCredentialV1(
  value: ProcessorCredentialV1,
): Uint8Array {
  const normalized = normalizeCredential(value);
  try {
    const encoded = concatV2(
      signingBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (encoded.length > MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1) {
      encoded.fill(0);
      throw new RangeError(
        "Processor credential exceeds its wire limit",
      );
    }
    return encoded;
  } finally {
    destroyCredential(normalized);
  }
}

export function decodeProcessorCredentialV1(
  bytes: Uint8Array,
): ProcessorCredentialV1 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Processor credential bytes must be Uint8Array");
  }
  if (bytes.length > MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1) {
    throw new RangeError("Processor credential exceeds its wire limit");
  }
  const raw = decodeExact(bytes, (reader): ProcessorCredentialV1 => {
    const domain = reader.readText(
      utf8V2(PROCESSOR_CREDENTIAL_DOMAIN_V1).length,
    );
    if (domain !== PROCESSOR_CREDENTIAL_DOMAIN_V1) {
      throw new CanonicalDecodingError(
        "Processor credential domain mismatch",
      );
    }
    const formatVersion = reader.readVersion(
      PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1,
    ) as typeof PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1;
    const id = reader.readText(V2_LIMITS.idBytes);
    const workDescriptorBytes = reader.readFrame(
      MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V1,
    );
    const workDescriptorHash = reader.readFrame(HASH_BYTES);
    const issuingHumanId =
      humanId(reader.readText(V2_LIMITS.idBytes));
    const issuingDeviceId =
      cryptoDeviceId(reader.readText(V2_LIMITS.idBytes));
    const issuingDeviceAuthorizationRevision =
      authorizationRevision(reader.readU64());
    const issuerSigningPublicKeyHash = reader.readFrame(HASH_BYTES);
    const signer = normalizeProcessorObjectSignerPrincipalV1({
      kind: reader.readText(64) as "processor_invocation",
      processorKind: reader.readText(64) as "stenographer",
      processorVersion: reader.readU32() as 1,
      signerAuthorizationId: reader.readText(V2_LIMITS.idBytes),
      workDescriptorHash: reader.readFrame(HASH_BYTES),
      signerKeyId: reader.readText(V2_LIMITS.idBytes),
    });
    const signerPublicKey =
      reader.readFrame(V2_LIMITS.signingPublicKeyBytes);
    const transformPermission = reader.readText(
      utf8V2(PROCESSOR_CREDENTIAL_TRANSFORM_PERMISSION_V1).length,
    ) as typeof PROCESSOR_CREDENTIAL_TRANSFORM_PERMISSION_V1;
    const issuedAt = reader.readU64();
    const notBefore = reader.readU64();
    const expiresAt = reader.readU64();
    const encryptedSecret =
      reader.readFrame(MAX_ENCRYPTED_SECRET_BYTES);
    const singleUseBytes = reader.readFrame(1);
    if (
      singleUseBytes.length !== 1
      || singleUseBytes[0] !== 1
    ) {
      throw new CanonicalDecodingError(
        "Processor credential single-use marker is invalid",
      );
    }
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    return {
      formatVersion,
      id,
      workDescriptorBytes,
      workDescriptorHash,
      issuingHumanId,
      issuingDeviceId,
      issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash,
      signer,
      signerPublicKey,
      transformPermission,
      issuedAt,
      notBefore,
      expiresAt,
      encryptedSecret,
      singleUse: true,
      signature,
    };
  });
  let normalized: ProcessorCredentialV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeCredential(raw);
    canonical = encodeProcessorCredentialV1(normalized);
    if (!equalBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Processor credential is noncanonical",
      );
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyCredential(raw);
    if (normalized !== undefined) destroyCredential(normalized);
    canonical?.fill(0);
  }
}

function issuerContext(
  credential: ProcessorCredentialV1,
  descriptor: BackgroundWorkDescriptorV1,
): ProcessorCredentialIssuerAuthorityContextV1 {
  return Object.freeze({
    purpose: "verify-current-processor-credential",
    credentialId: credential.id,
    issuingHumanId: credential.issuingHumanId,
    issuingDeviceId: credential.issuingDeviceId,
    issuingDeviceAuthorizationRevision:
      credential.issuingDeviceAuthorizationRevision,
    issuerSigningPublicKeyHash:
      copyOwnedBytesV2(credential.issuerSigningPublicKeyHash),
    workDescriptorHash:
      copyOwnedBytesV2(credential.workDescriptorHash),
    namespaceId: descriptor.namespaceId,
    domainId: descriptor.domainId,
    domainEpoch: descriptor.expectedDomainEpoch,
    namespaceAccessRevision:
      descriptor.expectedNamespaceAccessRevision,
    policyRevision: descriptor.expectedPolicyRevision,
    issuedAt: credential.issuedAt,
    notBefore: credential.notBefore,
    expiresAt: credential.expiresAt,
  });
}

function destroyIssuerContext(
  context: ProcessorCredentialIssuerAuthorityContextV1,
): void {
  context.issuerSigningPublicKeyHash.fill(0);
  context.workDescriptorHash.fill(0);
}

export async function createProcessorCredentialV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly id: string;
    readonly workDescriptor: BackgroundWorkDescriptorV1;
    readonly issuingHumanId: HumanId;
    readonly issuingDeviceId: CryptoDeviceId;
    readonly issuingDeviceAuthorizationRevision: AuthorizationRevision;
    readonly issuingDeviceSigningPublicKey: Uint8Array;
    readonly issuingDeviceSigningPrivateKey: Uint8Array;
    readonly signer: ProcessorObjectSignerPrincipalV1;
    readonly signerPublicKey: Uint8Array;
    readonly signerPrivateKey: Uint8Array;
    readonly aiRoot: Uint8Array;
  }>,
): Promise<CreatedProcessorCredentialV1> {
  assertPortableId("Processor credential id", input.id);
  const workDescriptorBytes =
    encodeBackgroundWorkDescriptorV1(input.workDescriptor);
  const workDescriptor = descriptorFromBytes(workDescriptorBytes);
  const workDescriptorHash =
    backgroundWorkDescriptorDigestV1(crypto, workDescriptor);
  let issuerPublicKey: Uint8Array | undefined;
  let issuerPrivateKey: Uint8Array | undefined;
  let signerPublicKey: Uint8Array | undefined;
  let signerPrivateKey: Uint8Array | undefined;
  let aiRoot: Uint8Array | undefined;
  let secretBytes: Uint8Array | undefined;
  let encryptedSecret: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  try {
    issuerPublicKey = exactBytes(
      "Processor credential issuer signing public key",
      input.issuingDeviceSigningPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    issuerPrivateKey = exactBytes(
      "Processor credential issuer signing private key",
      input.issuingDeviceSigningPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    signerPublicKey = exactBytes(
      "Processor credential signer public key",
      input.signerPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    signerPrivateKey = exactBytes(
      "Processor credential signer private key",
      input.signerPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    aiRoot = exactBytes(
      "Processor credential AI root",
      input.aiRoot,
      32,
    );
    const signer = normalizeProcessorObjectSignerPrincipalV1(input.signer);
    const derivedSigner = createProcessorObjectSignerPublicV1(crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId: signer.signerAuthorizationId,
      workDescriptorHash,
      signerPrivateKey,
    });
    if (
      !equalBytes(derivedSigner.publicKey, signerPublicKey)
      || derivedSigner.principal.signerKeyId !== signer.signerKeyId
      || !equalBytes(
        derivedSigner.principal.workDescriptorHash,
        signer.workDescriptorHash,
      )
    ) {
      throw new TypeError(
        "Processor credential signer key does not match its principal",
      );
    }
    secretBytes = encodeProcessorCredentialSecretV1({
      formatVersion: PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1,
      workDescriptorHash,
      domainId: workDescriptor.domainId,
      domainEpoch: workDescriptor.expectedDomainEpoch,
      aiRoot,
      processorSignerPrivateKey: signerPrivateKey,
    });
    encryptedSecret = await crypto.sealTo(
      workDescriptor.recipientPublicKey,
      secretBytes,
    );
    const unsigned = normalizeUnsigned({
      formatVersion: PROCESSOR_CREDENTIAL_FORMAT_VERSION_V1,
      id: input.id,
      workDescriptorBytes,
      workDescriptorHash,
      issuingHumanId: humanId(input.issuingHumanId),
      issuingDeviceId: cryptoDeviceId(input.issuingDeviceId),
      issuingDeviceAuthorizationRevision: authorizationRevision(
        input.issuingDeviceAuthorizationRevision,
      ),
      issuerSigningPublicKeyHash: crypto.hash(issuerPublicKey),
      signer,
      signerPublicKey,
      transformPermission:
        PROCESSOR_CREDENTIAL_TRANSFORM_PERMISSION_V1,
      issuedAt: workDescriptor.issuedAt,
      notBefore: workDescriptor.notBefore,
      expiresAt: workDescriptor.expiresAt,
      encryptedSecret,
      singleUse: true,
    });
    try {
      signingBytes = signingBytesFromNormalized(unsigned);
      signature = exactBytes(
        "Processor credential signature",
        crypto.sign(issuerPrivateKey, signingBytes),
        V2_LIMITS.signatureBytes,
      );
      if (!crypto.verify(issuerPublicKey, signingBytes, signature)) {
        throw new TypeError(
          "Processor credential issuer signing keys do not match",
        );
      }
      const bytes = encodeProcessorCredentialV1({
        ...unsigned,
        signature,
      });
      const credential = decodeProcessorCredentialV1(bytes);
      return Object.freeze({
        credential,
        bytes,
        hash: exactBytes(
          "Processor credential hash",
          crypto.hash(bytes),
          HASH_BYTES,
        ),
      });
    } finally {
      destroyUnsigned(unsigned);
    }
  } finally {
    workDescriptorBytes.fill(0);
    workDescriptorHash.fill(0);
    issuerPublicKey?.fill(0);
    issuerPrivateKey?.fill(0);
    signerPublicKey?.fill(0);
    signerPrivateKey?.fill(0);
    aiRoot?.fill(0);
    secretBytes?.fill(0);
    encryptedSecret?.fill(0);
    signature?.fill(0);
    signingBytes?.fill(0);
  }
}

export async function verifyProcessorCredentialV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly credentialBytes: Uint8Array;
    readonly now: number;
    readonly resolveCurrentIssuerPublicKey:
      ResolveCurrentProcessorCredentialIssuerPublicKeyV1;
  }>,
): Promise<VerifiedProcessorCredentialV1> {
  if (typeof input.resolveCurrentIssuerPublicKey !== "function") {
    throw new TypeError(
      "Current Processor credential issuer resolver is required",
    );
  }
  assertU64Counter("Processor credential verification time", input.now);
  if (
    input.credentialBytes instanceof Uint8Array
    && input.credentialBytes.length
      > MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1
  ) {
    throw new RangeError("Processor credential exceeds its wire limit");
  }
  const credentialBytes = boundedBytes(
    "Processor credential wire",
    input.credentialBytes,
    MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V1,
  );
  let credential: ProcessorCredentialV1 | undefined;
  let issuerPublicKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let context: ProcessorCredentialIssuerAuthorityContextV1 | undefined;
  try {
    credential = decodeProcessorCredentialV1(credentialBytes);
    if (
      input.now < credential.notBefore
      || input.now >= credential.expiresAt
    ) {
      throw new Error("Processor credential is not currently valid");
    }
    const descriptor =
      descriptorFromBytes(credential.workDescriptorBytes);
    context = issuerContext(credential, descriptor);
    const resolved = await input.resolveCurrentIssuerPublicKey(context);
    if (resolved === null) {
      throw new Error(
        "Processor credential issuer is not currently authorized",
      );
    }
    issuerPublicKey = exactBytes(
      "Processor credential current issuer public key",
      resolved,
      V2_LIMITS.signingPublicKeyBytes,
    );
    if (
      !equalBytes(
        crypto.hash(issuerPublicKey),
        credential.issuerSigningPublicKeyHash,
      )
    ) {
      throw new Error(
        "Processor credential issuer public key does not match",
      );
    }
    if (
      processorObjectSignerKeyIdV1(
        crypto,
        credential.signerPublicKey,
      ) !== credential.signer.signerKeyId
    ) {
      throw new Error(
        "Processor credential signer public key does not match",
      );
    }
    signingBytes = signingBytesFromNormalized(credential);
    if (
      !crypto.verify(
        issuerPublicKey,
        signingBytes,
        credential.signature,
      )
    ) {
      throw new Error("Processor credential signature is invalid");
    }
    const result = Object.freeze({
      credential,
      credentialBytes,
      credentialHash: exactBytes(
        "Processor credential hash",
        crypto.hash(credentialBytes),
        HASH_BYTES,
      ),
      workDescriptor: descriptor,
    });
    credential = undefined;
    return result;
  } catch (error) {
    credentialBytes.fill(0);
    throw error;
  } finally {
    if (credential !== undefined) destroyCredential(credential);
    issuerPublicKey?.fill(0);
    signingBytes?.fill(0);
    if (context !== undefined) destroyIssuerContext(context);
  }
}

export async function openProcessorCredentialV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly credentialBytes: Uint8Array;
    readonly recipientPrivateKey: Uint8Array;
    readonly now: number;
    readonly resolveCurrentIssuerPublicKey:
      ResolveCurrentProcessorCredentialIssuerPublicKeyV1;
  }>,
): Promise<OpenedProcessorCredentialV1 | null> {
  const recipientPrivateKey = exactBytes(
    "Processor credential recipient private key",
    input.recipientPrivateKey,
    V2_LIMITS.hpkePrivateKeyBytes,
  );
  let verified: VerifiedProcessorCredentialV1 | undefined;
  let plaintext: Uint8Array | null = null;
  let secret: ProcessorCredentialSecretV1 | undefined;
  try {
    verified = await verifyProcessorCredentialV1(crypto, {
      credentialBytes: input.credentialBytes,
      now: input.now,
      resolveCurrentIssuerPublicKey:
        input.resolveCurrentIssuerPublicKey,
    });
    plaintext = await crypto.openSealed(
      recipientPrivateKey,
      verified.credential.encryptedSecret,
    );
    if (plaintext === null) return null;
    secret = decodeProcessorCredentialSecretV1(plaintext);
    if (
      !equalBytes(
        secret.workDescriptorHash,
        verified.credential.workDescriptorHash,
      )
      || secret.domainId !== verified.workDescriptor.domainId
      || secret.domainEpoch
        !== verified.workDescriptor.expectedDomainEpoch
    ) {
      throw new Error(
        "Processor credential secret does not match its work descriptor",
      );
    }
    const derivedSigner = createProcessorObjectSignerPublicV1(crypto, {
      processorKind: "stenographer",
      processorVersion: 1,
      signerAuthorizationId:
        verified.credential.signer.signerAuthorizationId,
      workDescriptorHash: secret.workDescriptorHash,
      signerPrivateKey: secret.processorSignerPrivateKey,
    });
    if (
      !equalBytes(
        derivedSigner.publicKey,
        verified.credential.signerPublicKey,
      )
      || derivedSigner.principal.signerKeyId
        !== verified.credential.signer.signerKeyId
    ) {
      throw new Error(
        "Processor credential secret signer does not match its public identity",
      );
    }
    return Object.freeze({
      credentialId: verified.credential.id,
      workDescriptor: verified.workDescriptor,
      workDescriptorHash:
        copyOwnedBytesV2(secret.workDescriptorHash),
      domainId: secret.domainId,
      domainEpoch: secret.domainEpoch,
      aiRoot: copyOwnedBytesV2(secret.aiRoot),
      processorSignerPrivateKey:
        copyOwnedBytesV2(secret.processorSignerPrivateKey),
    });
  } finally {
    recipientPrivateKey.fill(0);
    plaintext?.fill(0);
    if (secret !== undefined) {
      destroyProcessorCredentialSecretV1(secret);
    }
    if (verified !== undefined) {
      destroyCredential(verified.credential);
      verified.credentialBytes.fill(0);
      verified.credentialHash.fill(0);
    }
  }
}
