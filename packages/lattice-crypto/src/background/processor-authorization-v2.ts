import { ed25519 } from "@noble/curves/ed25519.js";
import type { LatticeCrypto } from "../crypto/index.ts";
import { concatV2, decodeExact, encodeU32, encodeU64, frame, frameText,
  StrictDecoder } from "../format/v2-primitives.ts";
import { assertPortableId, assertU64Counter } from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { createProcessorObjectSignerPublicV1, processorObjectSignerKeyIdV1,
  type ProcessorObjectSignerPrincipalV1 } from "./processor-object-signer-v1.ts";
import { decodeAnyBackgroundProcessorWorkDescriptorV2, MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  backgroundProcessorDomainRequirementsV2, backgroundProcessorNamespaceRequirementsV2, REFLECTION_BACKGROUND_MAX_DOMAINS_V2,
  type BackgroundProcessorWorkDescriptorV2, type BackgroundReflectionWorkDescriptorV2, type AnyBackgroundProcessorWorkDescriptorV2 } from "./work-descriptor-v2.ts";
import {
  MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
  PROCESSOR_SIGNER_AUTHORIZATION_DOMAIN_V1,
} from "./processor-signer-authorization-v1.ts";

const CREDENTIAL_DOMAIN = "nautilo/lattice-crypto/processor-credential/v2";
const SIGNER_DOMAIN = "nautilo/lattice-crypto/processor-signer-authorization/v2";
const SECRET_DOMAIN = "nautilo/lattice-crypto/processor-credential-secret/v2";
const RESPONSE_DOMAIN = "nautilo/lattice-crypto/background-authorization-response/v2";
const HASH_BYTES = 32;
const DOMAIN_KEY_BYTES = 32;

/** Current M303/M304 admission coordinates, not a second device permission. */
export interface BackgroundAuthorizationIssuerV2 {
  readonly humanId: string;
  readonly deviceId: string;
  readonly deviceGeneration: number;
  readonly serverInstanceId: string;
  readonly lineageGeneration: number;
  readonly epoch: number;
  readonly securityRevision: number;
  readonly headDigest: Uint8Array;
  readonly signingPublicKeyHash: Uint8Array;
}

const ISSUER_IDS = ["humanId", "deviceId", "serverInstanceId"] as const;
const ISSUER_COUNTERS = ["deviceGeneration", "lineageGeneration", "epoch", "securityRevision"] as const;
const ISSUER_DIGESTS = ["headDigest", "signingPublicKeyHash"] as const;
const issuerWireMaximum = ISSUER_IDS.length * (4 + V2_LIMITS.idBytes)
  + ISSUER_COUNTERS.length * 8 + ISSUER_DIGESTS.length * (4 + HASH_BYTES);
const stenographerSecretWireMaximum = 4 + SECRET_DOMAIN.length + 4 + V2_LIMITS.idBytes
  + 4 + HASH_BYTES + 4 + DOMAIN_KEY_BYTES + 4 + V2_LIMITS.signingPrivateKeyBytes;
const reflectionSecretWireMaximum = 4 + SECRET_DOMAIN.length + 4 + V2_LIMITS.idBytes + 4 + HASH_BYTES
  + 4 + REFLECTION_BACKGROUND_MAX_DOMAINS_V2 * (4 + V2_LIMITS.idBytes + 4 + DOMAIN_KEY_BYTES)
  + 4 + V2_LIMITS.signingPrivateKeyBytes;
const secretWireMaximum = Math.max(stenographerSecretWireMaximum, reflectionSecretWireMaximum);
// LatticeCrypto.sealTo: u16 encapsulation length, P-256 encapsulation, AES-GCM tag.
const encryptedSecretMaximum = secretWireMaximum + 2 + V2_LIMITS.hpkePublicKeyBytes + 16;
const signedCommonMaximum = 4 + 4 + V2_LIMITS.idBytes
  + 4 + MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2 + 4 + HASH_BYTES
  + issuerWireMaximum + 4 + V2_LIMITS.signingPublicKeyBytes
  + 4 + V2_LIMITS.signatureBytes;
const MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V2 =
  4 + CREDENTIAL_DOMAIN.length + signedCommonMaximum + 4 + encryptedSecretMaximum;
export const MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V2 =
  4 + SIGNER_DOMAIN.length + signedCommonMaximum + 4 + HASH_BYTES;
export const MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2 =
  4 + RESPONSE_DOMAIN.length + 4 + 4 + MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V2
  + 4 + MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V2;

interface SignedAuthorizationV2 {
  readonly id: string;
  readonly descriptorBytes: Uint8Array;
  readonly descriptorHash: Uint8Array;
  readonly issuer: BackgroundAuthorizationIssuerV2;
  readonly signerPublicKey: Uint8Array;
  /** Encrypted secret in a credential; credential hash in public signer evidence. */
  readonly material: Uint8Array;
  readonly signature: Uint8Array;
}

export interface BackgroundAuthorizationIssuerContextV2 {
  readonly issuer: BackgroundAuthorizationIssuerV2;
  readonly descriptor: AnyBackgroundProcessorWorkDescriptorV2;
  readonly descriptorHash: Uint8Array;
}
export type ResolveCurrentBackgroundAuthorizationIssuerV2 = (
  context: BackgroundAuthorizationIssuerContextV2,
) => Promise<Uint8Array | null> | Uint8Array | null;

/** Resolves retained authority at the certificate's signed issuance coordinates. */
export type ResolveHistoricalBackgroundAuthorizationIssuerV2 = (
  context: BackgroundAuthorizationIssuerContextV2,
) => Uint8Array | null;

export interface ProcessorSignerAuthorizationCertificateV2 extends BackgroundAuthorizationIssuerContextV2 {
  readonly credentialId: string;
  readonly credentialHash: Uint8Array;
  readonly descriptorBytes: Uint8Array;
  readonly signer: ProcessorObjectSignerPrincipalV1;
  readonly signerPublicKey: Uint8Array;
}

export interface VerifiedProcessorSignerAuthorizationV2 {
  readonly certificate: ProcessorSignerAuthorizationCertificateV2;
  readonly authorizationBytes: Uint8Array;
  readonly authorizationHash: Uint8Array;
}

export interface VerifiedBackgroundAuthorizationV2 extends BackgroundAuthorizationIssuerContextV2 {
  readonly credentialId: string;
  readonly descriptorBytes: Uint8Array;
  readonly credentialBytes: Uint8Array;
  readonly credentialHash: Uint8Array;
  readonly signer: ProcessorObjectSignerPrincipalV1;
  readonly signerPublicKey: Uint8Array;
  readonly signerAuthorizationBytes: Uint8Array;
  readonly signerAuthorizationHash: Uint8Array;
  readonly responseBytes: Uint8Array;
  readonly responseHash: Uint8Array;
}

export class BackgroundAuthorizationErrorV2 extends Error {
  override readonly name = "BackgroundAuthorizationErrorV2";
  constructor(readonly code: "invalid" | "expired" | "authority_unavailable" | "secret_unavailable") {
    super(`Background authorization ${code}`);
  }
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function requireBytes(value: Uint8Array, length: number): void {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new BackgroundAuthorizationErrorV2("invalid");
}
function issuerBytes(issuer: BackgroundAuthorizationIssuerV2): Uint8Array {
  const fields = [...ISSUER_IDS, ...ISSUER_COUNTERS, ...ISSUER_DIGESTS].sort();
  const actual = Object.keys(issuer).sort();
  if (fields.length !== actual.length || fields.some((key, index) => key !== actual[index])) throw new BackgroundAuthorizationErrorV2("invalid");
  for (const key of ISSUER_IDS) assertPortableId(key, issuer[key]);
  for (const key of ISSUER_COUNTERS) assertU64Counter(key, issuer[key]);
  for (const key of ISSUER_DIGESTS) requireBytes(issuer[key], HASH_BYTES);
  return concatV2(...ISSUER_IDS.map((key) => frameText(issuer[key])),
    ...ISSUER_COUNTERS.map((key) => encodeU64(issuer[key])),
    ...ISSUER_DIGESTS.map((key) => frame(issuer[key])));
}
function readIssuer(decoder: StrictDecoder): BackgroundAuthorizationIssuerV2 {
  const value: Record<string, string | number | Uint8Array> = {};
  for (const key of ISSUER_IDS) value[key] = decoder.readText(V2_LIMITS.idBytes);
  for (const key of ISSUER_COUNTERS) value[key] = decoder.readU64();
  for (const key of ISSUER_DIGESTS) value[key] = decoder.readFrame(HASH_BYTES);
  const issuer = value as unknown as BackgroundAuthorizationIssuerV2;
  issuerBytes(issuer);
  return issuer;
}

function encryptedSecretMaximumFor(descriptor: AnyBackgroundProcessorWorkDescriptorV2): number {
  return (descriptor.subject.processorKind === "stenographer" ? stenographerSecretWireMaximum : reflectionSecretWireMaximum)
    + 2 + V2_LIMITS.hpkePublicKeyBytes + 16;
}

function signingBytes(domain: string, value: Omit<SignedAuthorizationV2, "signature">): Uint8Array {
  assertPortableId("Background credential ID", value.id);
  requireBytes(value.descriptorHash, HASH_BYTES);
  requireBytes(value.signerPublicKey, V2_LIMITS.signingPublicKeyBytes);
  const descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(value.descriptorBytes);
  const maximum = domain === CREDENTIAL_DOMAIN ? encryptedSecretMaximumFor(descriptor) : HASH_BYTES;
  if (!(value.material instanceof Uint8Array) || value.material.length < 1
    || value.material.length > maximum
    || (domain === SIGNER_DOMAIN && value.material.length !== HASH_BYTES)) {
    throw new BackgroundAuthorizationErrorV2("invalid");
  }
  return concatV2(frameText(domain), encodeU32(2), frameText(value.id),
    frame(value.descriptorBytes), frame(value.descriptorHash), issuerBytes(value.issuer),
    frame(value.signerPublicKey), frame(value.material));
}
function encodeAuthorization(domain: string, value: SignedAuthorizationV2): Uint8Array {
  requireBytes(value.signature, V2_LIMITS.signatureBytes);
  return concatV2(signingBytes(domain, value), frame(value.signature));
}
function decodeAuthorization(domain: string, bytes: Uint8Array): SignedAuthorizationV2 {
  const maximum = domain === CREDENTIAL_DOMAIN
    ? MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V2 : MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V2;
  if (!(bytes instanceof Uint8Array) || bytes.length > maximum) throw new BackgroundAuthorizationErrorV2("invalid");
  return decodeExact(bytes, (decoder) => {
    if (decoder.readText(domain.length) !== domain) throw new BackgroundAuthorizationErrorV2("invalid");
    decoder.readVersion(2);
    const id = decoder.readText(V2_LIMITS.idBytes);
    const descriptorBytes = decoder.readFrame(MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2);
    const descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(descriptorBytes);
    const value: SignedAuthorizationV2 = {
      id, descriptorBytes,
      descriptorHash: decoder.readFrame(HASH_BYTES), issuer: readIssuer(decoder),
      signerPublicKey: decoder.readFrame(V2_LIMITS.signingPublicKeyBytes),
      material: decoder.readFrame(domain === CREDENTIAL_DOMAIN ? encryptedSecretMaximumFor(descriptor) : HASH_BYTES),
      signature: decoder.readFrame(V2_LIMITS.signatureBytes),
    };
    if (!same(encodeAuthorization(domain, value), bytes)) throw new BackgroundAuthorizationErrorV2("invalid");
    return value;
  });
}

function assertSignature(crypto: LatticeCrypto, domain: string, value: SignedAuthorizationV2,
  publicKey: Uint8Array): void {
  requireBytes(publicKey, V2_LIMITS.signingPublicKeyBytes);
  if (!same(crypto.hash(value.descriptorBytes), value.descriptorHash)
    || !same(crypto.hash(publicKey), value.issuer.signingPublicKeyHash)
    || !crypto.verify(publicKey, signingBytes(domain, value), value.signature)) {
    throw new BackgroundAuthorizationErrorV2("invalid");
  }
}
function assertTime(descriptor: AnyBackgroundProcessorWorkDescriptorV2, now: number): void {
  assertU64Counter("Background verification time", now);
  if (now < descriptor.notBefore || now >= descriptor.expiresAt) throw new BackgroundAuthorizationErrorV2("expired");
}
function principal(crypto: LatticeCrypto, value: SignedAuthorizationV2): ProcessorObjectSignerPrincipalV1 {
  const descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(value.descriptorBytes);
  return {kind: "processor_invocation", processorKind: descriptor.subject.processorKind, processorVersion: 1,
    signerAuthorizationId: value.id, workDescriptorHash: value.descriptorHash.slice(),
    signerKeyId: processorObjectSignerKeyIdV1(crypto, value.signerPublicKey)};
}

/** The public certificate contains no encrypted Domain key or recipient secret. */
export function verifyProcessorSignerAuthorizationV2(crypto: LatticeCrypto, input: Readonly<{
  authorizationBytes: Uint8Array;
  issuerSigningPublicKey: Uint8Array;
  /** Omit only when verifying retained publication evidence, after its historical authority lookup. */
  now?: number;
}>): ProcessorSignerAuthorizationCertificateV2 {
  const value = decodeAuthorization(SIGNER_DOMAIN, input.authorizationBytes);
  assertSignature(crypto, SIGNER_DOMAIN, value, input.issuerSigningPublicKey);
  const descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(value.descriptorBytes);
  if (input.now !== undefined) assertTime(descriptor, input.now);
  return {credentialId: value.id, credentialHash: value.material,
    descriptor, descriptorBytes: value.descriptorBytes, descriptorHash: value.descriptorHash,
    issuer: value.issuer, signer: principal(crypto, value), signerPublicKey: value.signerPublicKey};
}

/** Bounded explicit dispatch only; the selected protocol must still fully verify. */
export function readProcessorSignerAuthorizationVersion(bytes: Uint8Array): 1 | 2 {
  if (!(bytes instanceof Uint8Array) || bytes.length > Math.max(
    MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V1,
    MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V2,
  )) throw new BackgroundAuthorizationErrorV2("invalid");
  const decoder = new StrictDecoder(bytes);
  try {
    const domain = decoder.readText(Math.max(SIGNER_DOMAIN.length, PROCESSOR_SIGNER_AUTHORIZATION_DOMAIN_V1.length));
    if (domain === SIGNER_DOMAIN) {decoder.readVersion(2); return 2;}
    if (domain === PROCESSOR_SIGNER_AUTHORIZATION_DOMAIN_V1) {decoder.readVersion(1); return 1;}
    throw new BackgroundAuthorizationErrorV2("invalid");
  } finally {
    decoder.destroy(true);
  }
}

/** Retained publication evidence survives expiry, never missing historical authority. */
export function verifyHistoricalProcessorSignerAuthorizationV2(crypto: LatticeCrypto, input: Readonly<{
  authorizationBytes: Uint8Array;
  resolveHistoricalIssuer: ResolveHistoricalBackgroundAuthorizationIssuerV2;
}>): VerifiedProcessorSignerAuthorizationV2 {
  const authorizationBytes = copyOwnedBytesV2(input.authorizationBytes);
  const value = decodeAuthorization(SIGNER_DOMAIN, authorizationBytes);
  const key = input.resolveHistoricalIssuer({
    issuer: decodeExact(issuerBytes(value.issuer), readIssuer),
    descriptor: decodeAnyBackgroundProcessorWorkDescriptorV2(value.descriptorBytes),
    descriptorHash: copyOwnedBytesV2(value.descriptorHash),
  });
  if (key === null) throw new BackgroundAuthorizationErrorV2("authority_unavailable");
  const publicKey = copyOwnedBytesV2(key);
  try {
    const certificate = verifyProcessorSignerAuthorizationV2(crypto, {
      authorizationBytes, issuerSigningPublicKey: publicKey,
    });
    return Object.freeze({certificate, authorizationBytes, authorizationHash: crypto.hash(authorizationBytes)});
  } finally {
    publicKey.fill(0);
  }
}

/** Destroys owned certificate buffers when a manifest chain releases evidence. */
export function destroyVerifiedProcessorSignerAuthorizationV2(value: VerifiedProcessorSignerAuthorizationV2): void {
  const certificate = value.certificate;
  const authorities = backgroundProcessorNamespaceRequirementsV2(certificate.descriptor).map(requirement => requirement.authority);
  [value.authorizationBytes, value.authorizationHash, certificate.credentialHash,
    certificate.descriptorBytes, certificate.descriptorHash, certificate.signerPublicKey,
    certificate.signer.workDescriptorHash, certificate.issuer.headDigest, certificate.issuer.signingPublicKeyHash,
    certificate.descriptor.recipientPublicKey, certificate.descriptor.source.fingerprint,
    ...authorities.flatMap(authority => [authority.namespaceHeadDigest, authority.domainHeadDigest, authority.bundleDigest]),
  ].forEach((bytes) => bytes.fill(0));
}

export function decodeBackgroundAuthorizationResponseV2(bytes: Uint8Array): Readonly<{
  credentialBytes: Uint8Array; signerAuthorizationBytes: Uint8Array;
}> {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2) {
    throw new BackgroundAuthorizationErrorV2("invalid");
  }
  return decodeExact(bytes, (decoder) => {
    if (decoder.readText(RESPONSE_DOMAIN.length) !== RESPONSE_DOMAIN) throw new BackgroundAuthorizationErrorV2("invalid");
    decoder.readVersion(2);
    const credentialBytes = decoder.readFrame(MAX_PROCESSOR_CREDENTIAL_WIRE_BYTES_V2);
    const signerAuthorizationBytes = decoder.readFrame(MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V2);
    decodeAuthorization(CREDENTIAL_DOMAIN, credentialBytes);
    decodeAuthorization(SIGNER_DOMAIN, signerAuthorizationBytes);
    return {credentialBytes, signerAuthorizationBytes};
  });
}

/** Untrusted routing coordinates only. Acceptance must verify the signatures
 * and exact durable descriptor under the current authority transaction. */
export function inspectBackgroundAuthorizationResponseV2(
  responseBytes: Uint8Array,
): BackgroundAuthorizationIssuerContextV2 {
  const response = decodeBackgroundAuthorizationResponseV2(responseBytes);
  const credential = decodeAuthorization(CREDENTIAL_DOMAIN, response.credentialBytes);
  return {issuer: credential.issuer, descriptor: decodeAnyBackgroundProcessorWorkDescriptorV2(credential.descriptorBytes),
    descriptorHash: credential.descriptorHash};
}

export interface BackgroundProcessorDomainKeyV2 {readonly domainId: string; readonly key: Uint8Array;}

export type CreateBackgroundAuthorizationResponseInputV2 = Readonly<{
  credentialId: string; descriptorBytes: Uint8Array; issuer: BackgroundAuthorizationIssuerV2; issuerSigningPrivateKey: Uint8Array;
}> & (Readonly<{domainKey: Uint8Array; domainKeys?: never}> | Readonly<{domainKeys: readonly BackgroundProcessorDomainKeyV2[]; domainKey?: never}>);

/** Validates the exact complete distinct-Domain set, never combines responses. */
function requireDomainKeySet(descriptor: AnyBackgroundProcessorWorkDescriptorV2, keys: readonly BackgroundProcessorDomainKeyV2[]): void {
  const domains = backgroundProcessorDomainRequirementsV2(descriptor);
  try {
    if (!Array.isArray(keys as unknown) || keys.length !== domains.length) throw new BackgroundAuthorizationErrorV2("invalid");
    for (const [index, entry] of keys.entries()) {
      if (entry.domainId !== domains[index]!.domainId || Object.keys(entry).sort().join(",") !== "domainId,key") throw new BackgroundAuthorizationErrorV2("invalid");
      requireBytes(entry.key, DOMAIN_KEY_BYTES);
    }
  } finally {domains.forEach(domain => domain.domainHeadDigest.fill(0));}
}

export async function createBackgroundAuthorizationResponseV2(crypto: LatticeCrypto, input: CreateBackgroundAuthorizationResponseInputV2): Promise<Uint8Array> {
  const credentialId = input.credentialId;
  const descriptorBytes = copyOwnedBytesV2(input.descriptorBytes);
  const descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(descriptorBytes);
  const descriptorHash = crypto.hash(descriptorBytes);
  const issuer = decodeExact(issuerBytes(input.issuer), readIssuer);
  let privateKey: Uint8Array | undefined;
  let domainKey: Uint8Array | undefined;
  const domainKeys: BackgroundProcessorDomainKeyV2[] = [];
  let signer: ReturnType<LatticeCrypto["generateSigningKeyPair"]> | undefined;
  let secret: Uint8Array | undefined;
  try {
    privateKey = copyOwnedBytesV2(input.issuerSigningPrivateKey);
    if (descriptor.subject.processorKind === "stenographer") {
      if (!(input.domainKey instanceof Uint8Array) || input.domainKeys !== undefined) throw new BackgroundAuthorizationErrorV2("invalid");
      domainKey = copyOwnedBytesV2(input.domainKey); requireBytes(domainKey, DOMAIN_KEY_BYTES);
    } else {
      if (input.domainKey !== undefined || !Array.isArray(input.domainKeys as unknown) || input.domainKeys.length > REFLECTION_BACKGROUND_MAX_DOMAINS_V2) throw new BackgroundAuthorizationErrorV2("invalid");
      requireDomainKeySet(descriptor, input.domainKeys);
      for (const entry of input.domainKeys) domainKeys.push({domainId: entry.domainId, key: copyOwnedBytesV2(entry.key)});
      requireDomainKeySet(descriptor, domainKeys);
    }
    signer = crypto.generateSigningKeyPair();
    requireBytes(privateKey, V2_LIMITS.signingPrivateKeyBytes);
    if (!same(crypto.hash(ed25519.getPublicKey(privateKey)), issuer.signingPublicKeyHash)) {
      throw new BackgroundAuthorizationErrorV2("invalid");
    }
    assertPortableId("Background credential ID", credentialId);
    const materialParts = domainKey === undefined
      ? [encodeU32(domainKeys.length), ...domainKeys.flatMap(entry => [frameText(entry.domainId), frame(entry.key)])]
      : [encodeU32(domainKey.length), copyOwnedBytesV2(domainKey)];
    const material = concatV2(...materialParts);
    materialParts.forEach(part => part.fill(0));
    try {
      secret = concatV2(frameText(SECRET_DOMAIN), frameText(credentialId), frame(descriptorHash), material,
        encodeU32(signer.privateKey.length), signer.privateKey);
    } finally {material.fill(0);}
    const encryptedSecret = await crypto.sealTo(descriptor.recipientPublicKey, secret);
    const common = {id: credentialId, descriptorBytes, descriptorHash, issuer,
      signerPublicKey: signer.publicKey};
    const credential = {...common, material: encryptedSecret};
    const credentialBytes = encodeAuthorization(CREDENTIAL_DOMAIN, {...credential,
      signature: crypto.sign(privateKey, signingBytes(CREDENTIAL_DOMAIN, credential))});
    const certificate = {...common, material: crypto.hash(credentialBytes)};
    const certificateBytes = encodeAuthorization(SIGNER_DOMAIN, {...certificate,
      signature: crypto.sign(privateKey, signingBytes(SIGNER_DOMAIN, certificate))});
    return concatV2(frameText(RESPONSE_DOMAIN), encodeU32(2), frame(credentialBytes), frame(certificateBytes));
  } finally {
    privateKey?.fill(0); domainKey?.fill(0); domainKeys.forEach(entry => entry.key.fill(0)); signer?.privateKey.fill(0); secret?.fill(0);
  }
}

export async function verifyBackgroundAuthorizationResponseV2(crypto: LatticeCrypto, input: Readonly<{
  responseBytes: Uint8Array; now: number; resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2;
}>): Promise<VerifiedBackgroundAuthorizationV2> {
  const responseBytes = copyOwnedBytesV2(input.responseBytes);
  const {credentialBytes, signerAuthorizationBytes} = decodeBackgroundAuthorizationResponseV2(responseBytes);
  const credential = decodeAuthorization(CREDENTIAL_DOMAIN, credentialBytes);
  const descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(credential.descriptorBytes);
  assertTime(descriptor, input.now);
  // Authority implementations receive their own decoded view. A callback must
  // never be able to rewrite the separately authenticated execution scope.
  const publicKey = await input.resolveCurrentIssuer({
    issuer: decodeExact(issuerBytes(credential.issuer), readIssuer),
    descriptor: decodeAnyBackgroundProcessorWorkDescriptorV2(credential.descriptorBytes),
    descriptorHash: credential.descriptorHash.slice(),
  });
  if (publicKey === null) throw new BackgroundAuthorizationErrorV2("authority_unavailable");
  assertSignature(crypto, CREDENTIAL_DOMAIN, credential, publicKey);
  const certificate = verifyProcessorSignerAuthorizationV2(crypto, {
    authorizationBytes: signerAuthorizationBytes, issuerSigningPublicKey: publicKey, now: input.now,
  });
  const credentialHash = crypto.hash(credentialBytes);
  if (certificate.credentialId !== credential.id || !same(certificate.credentialHash, credentialHash)
    || !same(certificate.descriptorBytes, credential.descriptorBytes)
    || !same(certificate.signerPublicKey, credential.signerPublicKey)
    || !same(issuerBytes(certificate.issuer), issuerBytes(credential.issuer))) {
    throw new BackgroundAuthorizationErrorV2("invalid");
  }
  return {credentialId: credential.id, descriptor, descriptorBytes: credential.descriptorBytes,
    descriptorHash: credential.descriptorHash, issuer: credential.issuer, credentialBytes, credentialHash,
    signer: certificate.signer, signerPublicKey: certificate.signerPublicKey,
    signerAuthorizationBytes, signerAuthorizationHash: crypto.hash(signerAuthorizationBytes),
    responseBytes, responseHash: crypto.hash(responseBytes)};
}

export type VerifiedStenographerBackgroundAuthorizationV2 = VerifiedBackgroundAuthorizationV2 & Readonly<{descriptor: BackgroundProcessorWorkDescriptorV2}>;
export type VerifiedReflectionBackgroundAuthorizationV2 = VerifiedBackgroundAuthorizationV2 & Readonly<{descriptor: BackgroundReflectionWorkDescriptorV2}>;

type OpenedBackgroundMaterialV2 =
  | Readonly<{kind: "stenographer"; verified: VerifiedStenographerBackgroundAuthorizationV2; domainKey: Uint8Array; signerPrivateKey: Uint8Array}>
  | Readonly<{kind: "reflection"; verified: VerifiedReflectionBackgroundAuthorizationV2; domainKeys: readonly BackgroundProcessorDomainKeyV2[]; signerPrivateKey: Uint8Array}>;
type OpenBackgroundInputV2 = Readonly<{
  responseBytes: Uint8Array; recipientPrivateKey: Uint8Array; now: () => number;
  resolveCurrentIssuer: ResolveCurrentBackgroundAuthorizationIssuerV2; signal?: AbortSignal;
}>;

/** Called only inside the one-use recipient/claim gate. Never exports long-lived key custody. */
export function withOpenedBackgroundAuthorizationV2<Value>(crypto: LatticeCrypto, input: OpenBackgroundInputV2 & Readonly<{
  use(input: Readonly<{verified: VerifiedStenographerBackgroundAuthorizationV2; domainKey: Uint8Array; signerPrivateKey: Uint8Array}>): Value | Promise<Value>;
}>): Promise<Value> {
  return withOpenedProcessorAuthorizationV2(crypto, {...input, expectedKind: "stenographer", use: material => {
    if (material.kind !== "stenographer") throw new BackgroundAuthorizationErrorV2("invalid");
    return input.use(material);
  }});
}

export function withOpenedReflectionBackgroundAuthorizationV2<Value>(crypto: LatticeCrypto, input: OpenBackgroundInputV2 & Readonly<{
  use(input: Readonly<{verified: VerifiedReflectionBackgroundAuthorizationV2; domainKeys: readonly BackgroundProcessorDomainKeyV2[]; signerPrivateKey: Uint8Array}>): Value | Promise<Value>;
}>): Promise<Value> {
  return withOpenedProcessorAuthorizationV2(crypto, {...input, expectedKind: "reflection", use: material => {
    if (material.kind !== "reflection") throw new BackgroundAuthorizationErrorV2("invalid");
    return input.use(material);
  }});
}

async function withOpenedProcessorAuthorizationV2<Value>(crypto: LatticeCrypto, input: OpenBackgroundInputV2 & Readonly<{
  expectedKind: "stenographer" | "reflection"; use(input: OpenedBackgroundMaterialV2): Value | Promise<Value>;
}>): Promise<Value> {
  const responseBytes = copyOwnedBytesV2(input.responseBytes);
  const recipientPrivateKey = copyOwnedBytesV2(input.recipientPrivateKey);
  let secret: Uint8Array | null = null;
  let domainKey: Uint8Array | undefined;
  const domainKeys: BackgroundProcessorDomainKeyV2[] = [];
  let signerPrivateKey: Uint8Array | undefined;
  const wipeSecrets = () => {
    secret?.fill(0); domainKey?.fill(0); domainKeys.forEach(entry => entry.key.fill(0)); signerPrivateKey?.fill(0); recipientPrivateKey.fill(0);
  };
  input.signal?.addEventListener("abort", wipeSecrets, {once: true});
  try {
    input.signal?.throwIfAborted();
    const verified = await verifyBackgroundAuthorizationResponseV2(crypto, {
      responseBytes, now: input.now(), resolveCurrentIssuer: input.resolveCurrentIssuer,
    });
    const kind = verified.descriptor.subject.processorKind;
    if (kind !== input.expectedKind) throw new BackgroundAuthorizationErrorV2("invalid");
    const credential = decodeAuthorization(CREDENTIAL_DOMAIN, verified.credentialBytes);
    input.signal?.throwIfAborted();
    secret = await crypto.openSealed(recipientPrivateKey, credential.material);
    input.signal?.throwIfAborted();
    if (secret === null || secret.length > (kind === "stenographer" ? stenographerSecretWireMaximum : reflectionSecretWireMaximum)) throw new BackgroundAuthorizationErrorV2("secret_unavailable");
    decodeExact(secret, decoder => {
      if (decoder.readText(SECRET_DOMAIN.length) !== SECRET_DOMAIN
        || decoder.readText(V2_LIMITS.idBytes) !== verified.credentialId
        || !same(decoder.readFrame(HASH_BYTES), verified.descriptorHash)) throw new BackgroundAuthorizationErrorV2("secret_unavailable");
      if (kind === "stenographer") {
        domainKey = decoder.readFrame(DOMAIN_KEY_BYTES); requireBytes(domainKey, DOMAIN_KEY_BYTES);
      } else {
        const count = decoder.readCount(REFLECTION_BACKGROUND_MAX_DOMAINS_V2);
        for (let index = 0; index < count; index += 1) domainKeys.push({domainId: decoder.readText(V2_LIMITS.idBytes), key: decoder.readFrame(DOMAIN_KEY_BYTES)});
        requireDomainKeySet(verified.descriptor, domainKeys);
      }
      signerPrivateKey = decoder.readFrame(V2_LIMITS.signingPrivateKeyBytes);
      requireBytes(signerPrivateKey, V2_LIMITS.signingPrivateKeyBytes);
    });
    const signer = createProcessorObjectSignerPublicV1(crypto, {processorKind: kind, processorVersion: 1,
      signerAuthorizationId: verified.credentialId, workDescriptorHash: verified.descriptorHash, signerPrivateKey: signerPrivateKey!});
    if (!same(signer.publicKey, verified.signerPublicKey)) throw new BackgroundAuthorizationErrorV2("secret_unavailable");
    await verifyBackgroundAuthorizationResponseV2(crypto, {responseBytes, now: input.now(), resolveCurrentIssuer: input.resolveCurrentIssuer});
    input.signal?.throwIfAborted(); assertTime(verified.descriptor, input.now());
    const result = await input.use(kind === "stenographer"
      ? {kind, verified: verified as VerifiedStenographerBackgroundAuthorizationV2, domainKey: domainKey!, signerPrivateKey: signerPrivateKey!}
      : {kind, verified: verified as VerifiedReflectionBackgroundAuthorizationV2, domainKeys: Object.freeze(domainKeys.map(entry => Object.freeze({...entry}))), signerPrivateKey: signerPrivateKey!});
    input.signal?.throwIfAborted(); return result;
  } finally {
    input.signal?.removeEventListener("abort", wipeSecrets); wipeSecrets();
  }
}
