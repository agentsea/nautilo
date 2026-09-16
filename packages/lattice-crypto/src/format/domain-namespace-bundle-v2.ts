import type { LatticeCrypto } from "../crypto/index.ts";
import {
  DOMAIN_KEY_BYTES_V2,
  type DomainKeyClassV2,
  domainKeyClassV2,
} from "../domain/domain-keys-v2.ts";
import type {
  AccessRevision,
  AuthorizationRevision,
  CryptoDeviceId,
  CryptoDomainId,
  HumanId,
  NamespaceId,
  NamespaceKeyGeneration,
} from "../v2-types/ids.ts";
import {
  accessRevision,
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  namespaceGeneration,
  namespaceId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "./v2-primitives.ts";

export const DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2 = 2 as const;
export const DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2 =
  "domain_key.namespace_bundle" as const;
export const DOMAIN_NAMESPACE_BUNDLE_BINDING_PURPOSE_V2 =
  "domain_key.namespace_bundle_binding" as const;
export const DOMAIN_NAMESPACE_BUNDLE_MAX_RETAINED_GENERATIONS_V2 =
  V2_LIMITS.retainedNamespaceGenerations;
export const DOMAIN_NAMESPACE_BUNDLE_MAX_INNER_BYTES_V2 = 256 * 1024;
export const DOMAIN_NAMESPACE_BUNDLE_MAX_WIRE_BYTES_V2 = 512 * 1024;
export const DOMAIN_NAMESPACE_BUNDLE_MAX_TTL_MS_V2 = 30_000;

const INNER_DOMAIN = "nautilo/lattice-crypto/domain-namespace-bundle/v2";
const BINDING_DOMAIN =
  "nautilo/lattice-crypto/domain-namespace-bundle-binding/v2";
const AAD_DOMAIN = "nautilo/lattice-crypto/domain-namespace-bundle-aad/v2";
const RETAINED_SET_DOMAIN =
  "nautilo/lattice-crypto/domain-namespace-retained-set/v2";
const GENERATION_HEAD_DOMAIN =
  "nautilo/lattice-crypto/domain-namespace-generation-head/v2";
const HASH_BYTES = 32;
const NAMESPACE_KEY_BYTES = 32;

export const DOMAIN_NAMESPACE_GENERATION_KEY_BYTES_V2 = NAMESPACE_KEY_BYTES;

export interface DomainNamespaceRetainedAuthorityV2 {
  readonly generation: NamespaceKeyGeneration;
  readonly accessRevision: AccessRevision;
  readonly headDigest: Uint8Array;
}

export interface DomainNamespaceRetainedGenerationV2
  extends DomainNamespaceRetainedAuthorityV2 {
  readonly generationKey: Uint8Array;
}

export interface DomainNamespaceBundleV2 {
  readonly formatVersion: typeof DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2;
  readonly purpose: typeof DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2;
  readonly serverId: string;
  readonly cryptoDomainId: CryptoDomainId;
  readonly participantDigest: Uint8Array;
  readonly participantCount: number;
  readonly keyClass: DomainKeyClassV2;
  readonly domainKeyGeneration: number;
  readonly domainAuthorizationRevision: AuthorizationRevision;
  readonly domainHeadDigest: Uint8Array;
  readonly namespaceId: NamespaceId;
  readonly namespaceAccessRevision: AccessRevision;
  readonly namespaceCurrentGeneration: NamespaceKeyGeneration;
  readonly bundleRevision: number;
  readonly retainedGenerationCount: number;
  readonly retainedAuthoritySetDigest: Uint8Array;
  readonly retainedGenerations: readonly DomainNamespaceRetainedGenerationV2[];
}

export interface DomainNamespaceBundleBindingV2 {
  readonly formatVersion: typeof DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2;
  readonly purpose: typeof DOMAIN_NAMESPACE_BUNDLE_BINDING_PURPOSE_V2;
  readonly operationId: string;
  readonly serverId: string;
  readonly cryptoDomainId: CryptoDomainId;
  readonly participantDigest: Uint8Array;
  readonly participantCount: number;
  readonly keyClass: DomainKeyClassV2;
  readonly domainKeyGeneration: number;
  readonly domainAuthorizationRevision: AuthorizationRevision;
  readonly domainHeadDigest: Uint8Array;
  readonly namespaceId: NamespaceId;
  readonly namespaceAccessRevision: AccessRevision;
  readonly namespaceCurrentGeneration: NamespaceKeyGeneration;
  readonly bundleRevision: number;
  readonly retainedGenerationCount: number;
  readonly retainedAuthoritySetDigest: Uint8Array;
  readonly plaintextDigest: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly ciphertextDigest: Uint8Array;
  readonly previousBindingDigest: Uint8Array | null;
  readonly issuerHumanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerDeviceSigningGeneration: number;
  readonly issuedAt: number;
  readonly signature: Uint8Array;
}

export interface PreparedDomainNamespaceBundleV2 {
  readonly binding: DomainNamespaceBundleBindingV2;
  readonly bytes: Uint8Array;
  readonly bindingDigest: Uint8Array;
  readonly plaintextDigest: Uint8Array;
}

export type OpenDomainNamespaceBundleResultV2<Value> =
  | Readonly<{ status: "opened"; value: Value }>
  | Readonly<{
      status: "unavailable";
      reason: "invalid" | "authority_stale" | "secret_unavailable";
    }>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function counter(label: string, value: unknown, minimum = 0): number {
  assertU64Counter(label, value);
  if (value < minimum) throw new RangeError(`${label} is below its minimum`);
  return value;
}

function exactBytes(label: string, value: unknown, length = HASH_BYTES): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function nullableDigest(value: Uint8Array | null): Uint8Array {
  return value === null ? new Uint8Array(0) : value;
}

function readNullableDigest(
  reader: Parameters<Parameters<typeof decodeExact>[1]>[0],
): Uint8Array | null {
  const value = reader.readFrame(HASH_BYTES);
  if (value.length === 0) return null;
  if (value.length !== HASH_BYTES) {
    value.fill(0);
    throw new TypeError("Namespace bundle previous binding digest is invalid");
  }
  return value;
}

function normalizeRetainedAuthority(
  value: DomainNamespaceRetainedAuthorityV2,
): DomainNamespaceRetainedAuthorityV2 {
  return Object.freeze({
    generation: namespaceGeneration(value.generation),
    accessRevision: accessRevision(value.accessRevision),
    headDigest: exactBytes("Namespace generation head digest", value.headDigest),
  });
}

function normalizeRetained(
  value: DomainNamespaceRetainedGenerationV2,
): DomainNamespaceRetainedGenerationV2 {
  return Object.freeze({
    ...normalizeRetainedAuthority(value),
    generationKey: exactBytes(
      "Namespace generation key",
      value.generationKey,
      NAMESPACE_KEY_BYTES,
    ),
  });
}

function assertCanonicalRetained(
  values: readonly DomainNamespaceRetainedAuthorityV2[],
): void {
  if (
    !Array.isArray(values as unknown)
    || values.length < 1
    || values.length > DOMAIN_NAMESPACE_BUNDLE_MAX_RETAINED_GENERATIONS_V2
  ) throw new RangeError("Namespace bundle retained generation count is invalid");
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]!.generation !== values[index - 1]!.generation + 1) {
      throw new TypeError(
        "Namespace bundle retained generations must be contiguous and canonical",
      );
    }
  }
}

function retainedAuthorityBytes(
  value: DomainNamespaceRetainedAuthorityV2,
): Uint8Array {
  return concatV2(
    encodeU64(value.generation),
    encodeU64(value.accessRevision),
    frame(value.headDigest),
  );
}

function retainedBytes(value: DomainNamespaceRetainedGenerationV2): Uint8Array {
  return concatV2(retainedAuthorityBytes(value), frame(value.generationKey));
}

export function domainNamespaceRetainedAuthoritySetDigestV2(
  crypto: Pick<LatticeCrypto, "hash">,
  values: readonly DomainNamespaceRetainedAuthorityV2[],
): Uint8Array {
  const retained = values.map(normalizeRetainedAuthority);
  let bytes: Uint8Array | undefined;
  try {
    assertCanonicalRetained(retained);
    bytes = concatV2(
      frameText(RETAINED_SET_DOMAIN),
      encodeU32(retained.length),
      ...retained.map(retainedAuthorityBytes),
    );
    return crypto.hash(bytes);
  } finally {
    retained.forEach(destroyRetainedAuthority);
    bytes?.fill(0);
  }
}

/**
 * Commits one native V2 Namespace generation to its complete authority
 * coordinates without exposing the generation key. The previous commitment
 * makes the retained sequence append-only while still allowing a Domain
 * bundle to be rewrapped unchanged for another qualified device.
 */
export function domainNamespaceGenerationHeadDigestV2(
  crypto: Pick<LatticeCrypto, "hash">,
  input: Readonly<{
    serverId: string;
    namespaceId: NamespaceId;
    keyClass: DomainKeyClassV2;
    accessRevision: AccessRevision;
    generation: NamespaceKeyGeneration;
    previousHeadDigest: Uint8Array | null;
    generationKey: Uint8Array;
  }>,
): Uint8Array {
  const generationKey = exactBytes(
    "Namespace generation key",
    input.generationKey,
    NAMESPACE_KEY_BYTES,
  );
  const previousHeadDigest = input.previousHeadDigest === null
    ? null
    : exactBytes(
      "Previous Namespace generation head digest",
      input.previousHeadDigest,
    );
  let bytes: Uint8Array | undefined;
  try {
    bytes = concatV2(
      frameText(GENERATION_HEAD_DOMAIN),
      frameText(portable("Domain Namespace server ID", input.serverId)),
      frameText(namespaceId(input.namespaceId)),
      frameText(domainKeyClassV2(input.keyClass)),
      encodeU64(accessRevision(input.accessRevision)),
      encodeU64(namespaceGeneration(input.generation)),
      frame(nullableDigest(previousHeadDigest)),
      frame(generationKey),
    );
    return crypto.hash(bytes);
  } finally {
    generationKey.fill(0);
    previousHeadDigest?.fill(0);
    bytes?.fill(0);
  }
}

function normalizeBundle(value: DomainNamespaceBundleV2): DomainNamespaceBundleV2 {
  if (
    value.formatVersion !== DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2
    || value.purpose !== DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2
  ) throw new TypeError("Domain Namespace bundle version is unsupported");
  const retained = value.retainedGenerations.map(normalizeRetained);
  try {
    assertCanonicalRetained(retained);
    if (value.retainedGenerationCount !== retained.length) {
      throw new TypeError("Namespace bundle retained generation count disagrees");
    }
    const currentGeneration = namespaceGeneration(value.namespaceCurrentGeneration);
    if (retained.at(-1)?.generation !== currentGeneration) {
      throw new TypeError("Namespace bundle current generation disagrees");
    }
    return Object.freeze({
      formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
      serverId: portable("Server ID", value.serverId),
      cryptoDomainId: cryptoDomainId(value.cryptoDomainId),
      participantDigest: exactBytes("Domain participant digest", value.participantDigest),
      participantCount: counter("Domain participant count", value.participantCount, 1),
      keyClass: domainKeyClassV2(value.keyClass),
      domainKeyGeneration: counter("Domain key generation", value.domainKeyGeneration, 1),
      domainAuthorizationRevision: authorizationRevision(
        value.domainAuthorizationRevision,
      ),
      domainHeadDigest: exactBytes("Domain key head digest", value.domainHeadDigest),
      namespaceId: namespaceId(value.namespaceId),
      namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
      namespaceCurrentGeneration: currentGeneration,
      bundleRevision: counter("Namespace bundle revision", value.bundleRevision, 1),
      retainedGenerationCount: retained.length,
      retainedAuthoritySetDigest: exactBytes(
        "Namespace retained authority-set digest",
        value.retainedAuthoritySetDigest,
      ),
      retainedGenerations: Object.freeze(retained),
    });
  } catch (error) {
    retained.forEach(destroyRetained);
    throw error;
  }
}

function bundleBytes(value: DomainNamespaceBundleV2): Uint8Array {
  return concatV2(
    frameText(INNER_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.serverId),
    frameText(value.cryptoDomainId),
    frame(value.participantDigest),
    encodeU64(value.participantCount),
    frameText(value.keyClass),
    encodeU64(value.domainKeyGeneration),
    encodeU64(value.domainAuthorizationRevision),
    frame(value.domainHeadDigest),
    frameText(value.namespaceId),
    encodeU64(value.namespaceAccessRevision),
    encodeU64(value.namespaceCurrentGeneration),
    encodeU64(value.bundleRevision),
    encodeU32(value.retainedGenerationCount),
    frame(value.retainedAuthoritySetDigest),
    ...value.retainedGenerations.map(retainedBytes),
  );
}

export function encodeDomainNamespaceBundleV2(
  value: DomainNamespaceBundleV2,
): Uint8Array {
  const normalized = normalizeBundle(value);
  try {
    const bytes = bundleBytes(normalized);
    if (bytes.length > DOMAIN_NAMESPACE_BUNDLE_MAX_INNER_BYTES_V2) {
      bytes.fill(0);
      throw new RangeError("Domain Namespace bundle exceeds its inner bound");
    }
    return bytes;
  } finally {
    destroyDomainNamespaceBundleV2(normalized);
  }
}

export function decodeDomainNamespaceBundleV2(
  bytes: Uint8Array,
): DomainNamespaceBundleV2 {
  if (bytes.length > DOMAIN_NAMESPACE_BUNDLE_MAX_INNER_BYTES_V2) {
    throw new RangeError("Domain Namespace bundle exceeds its inner bound");
  }
  const decoded = decodeExact(bytes, (reader) => {
    if (reader.readText(256) !== INNER_DOMAIN) {
      throw new TypeError("Domain Namespace bundle domain is invalid");
    }
    reader.readVersion(DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2);
    if (reader.readText(128) !== DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2) {
      throw new TypeError("Domain Namespace bundle purpose is invalid");
    }
    const serverId = reader.readText(V2_LIMITS.idBytes);
    const domainId = cryptoDomainId(reader.readText(V2_LIMITS.idBytes));
    const participantDigest = reader.readFrame(HASH_BYTES);
    const participantCount = reader.readU64();
    const keyClass = domainKeyClassV2(reader.readText(16));
    const domainKeyGeneration = reader.readU64();
    const domainAuthorizationRevision = authorizationRevision(reader.readU64());
    const domainHeadDigest = reader.readFrame(HASH_BYTES);
    const namespaceIdValue = namespaceId(reader.readText(V2_LIMITS.idBytes));
    const namespaceAccessRevision = accessRevision(reader.readU64());
    const namespaceCurrentGeneration = namespaceGeneration(reader.readU64());
    const bundleRevision = reader.readU64();
    const retainedGenerationCount = reader.readCount(
      DOMAIN_NAMESPACE_BUNDLE_MAX_RETAINED_GENERATIONS_V2,
    );
    const retainedAuthoritySetDigest = reader.readFrame(HASH_BYTES);
    const retainedGenerations = Array.from(
      { length: retainedGenerationCount },
      () => Object.freeze({
        generation: namespaceGeneration(reader.readU64()),
        accessRevision: accessRevision(reader.readU64()),
        headDigest: reader.readFrame(HASH_BYTES),
        generationKey: reader.readFrame(NAMESPACE_KEY_BYTES),
      }),
    );
    return normalizeBundle({
      formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
      serverId,
      cryptoDomainId: domainId,
      participantDigest,
      participantCount,
      keyClass,
      domainKeyGeneration,
      domainAuthorizationRevision,
      domainHeadDigest,
      namespaceId: namespaceIdValue,
      namespaceAccessRevision,
      namespaceCurrentGeneration,
      bundleRevision,
      retainedGenerationCount,
      retainedAuthoritySetDigest,
      retainedGenerations,
    });
  });
  const canonical = bundleBytes(decoded);
  try {
    if (!sameBytes(canonical, bytes)) {
      throw new TypeError("Domain Namespace bundle is noncanonical");
    }
    return decoded;
  } catch (error) {
    destroyDomainNamespaceBundleV2(decoded);
    throw error;
  } finally {
    canonical.fill(0);
  }
}

interface BundleCoordinatesV2 {
  readonly operationId: string;
  readonly serverId: string;
  readonly cryptoDomainId: CryptoDomainId;
  readonly participantDigest: Uint8Array;
  readonly participantCount: number;
  readonly keyClass: DomainKeyClassV2;
  readonly domainKeyGeneration: number;
  readonly domainAuthorizationRevision: AuthorizationRevision;
  readonly domainHeadDigest: Uint8Array;
  readonly namespaceId: NamespaceId;
  readonly namespaceAccessRevision: AccessRevision;
  readonly namespaceCurrentGeneration: NamespaceKeyGeneration;
  readonly bundleRevision: number;
  readonly retainedGenerationCount: number;
  readonly retainedAuthoritySetDigest: Uint8Array;
  readonly plaintextDigest: Uint8Array;
  readonly previousBindingDigest: Uint8Array | null;
  readonly issuerHumanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerDeviceSigningGeneration: number;
  readonly issuedAt: number;
}

function aadBytes(value: BundleCoordinatesV2): Uint8Array {
  return concatV2(
    frameText(AAD_DOMAIN),
    frameText(value.operationId),
    frameText(value.serverId),
    frameText(value.cryptoDomainId),
    frame(value.participantDigest),
    encodeU64(value.participantCount),
    frameText(value.keyClass),
    encodeU64(value.domainKeyGeneration),
    encodeU64(value.domainAuthorizationRevision),
    frame(value.domainHeadDigest),
    frameText(value.namespaceId),
    encodeU64(value.namespaceAccessRevision),
    encodeU64(value.namespaceCurrentGeneration),
    encodeU64(value.bundleRevision),
    encodeU32(value.retainedGenerationCount),
    frame(value.retainedAuthoritySetDigest),
    frame(value.plaintextDigest),
    frame(nullableDigest(value.previousBindingDigest)),
    frameText(value.issuerHumanId),
    frameText(value.issuerDeviceId),
    encodeU64(value.issuerDeviceSigningGeneration),
    encodeU64(value.issuedAt),
  );
}

function bindingSigningBytes(
  value: Omit<DomainNamespaceBundleBindingV2, "signature">,
): Uint8Array {
  if (
    value.formatVersion !== DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2
    || value.purpose !== DOMAIN_NAMESPACE_BUNDLE_BINDING_PURPOSE_V2
  ) throw new TypeError("Domain Namespace binding version is unsupported");
  const ciphertext = value.ciphertext;
  if (
    !(ciphertext instanceof Uint8Array)
    || ciphertext.length < 1
    || ciphertext.length > DOMAIN_NAMESPACE_BUNDLE_MAX_INNER_BYTES_V2 + 64
  ) throw new RangeError("Domain Namespace bundle ciphertext is out of bounds");
  return concatV2(
    frameText(BINDING_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    aadBytes(value),
    frame(ciphertext),
    frame(value.ciphertextDigest),
  );
}

export function encodeDomainNamespaceBundleBindingV2(
  value: DomainNamespaceBundleBindingV2,
): Uint8Array {
  const signature = exactBytes(
    "Domain Namespace bundle signature",
    value.signature,
    V2_LIMITS.signatureBytes,
  );
  const signing = bindingSigningBytes(value);
  try {
    const bytes = concatV2(signing, frame(signature));
    if (bytes.length > DOMAIN_NAMESPACE_BUNDLE_MAX_WIRE_BYTES_V2) {
      bytes.fill(0);
      throw new RangeError("Domain Namespace bundle binding exceeds its wire bound");
    }
    return bytes;
  } finally {
    signature.fill(0);
    signing.fill(0);
  }
}

export function decodeDomainNamespaceBundleBindingV2(
  bytes: Uint8Array,
): DomainNamespaceBundleBindingV2 {
  if (bytes.length > DOMAIN_NAMESPACE_BUNDLE_MAX_WIRE_BYTES_V2) {
    throw new RangeError("Domain Namespace bundle binding exceeds its wire bound");
  }
  const decoded = decodeExact(bytes, (reader) => {
    if (reader.readText(256) !== BINDING_DOMAIN) {
      throw new TypeError("Domain Namespace bundle binding domain is invalid");
    }
    reader.readVersion(DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2);
    if (reader.readText(128) !== DOMAIN_NAMESPACE_BUNDLE_BINDING_PURPOSE_V2) {
      throw new TypeError("Domain Namespace bundle binding purpose is invalid");
    }
    if (reader.readText(256) !== AAD_DOMAIN) {
      throw new TypeError("Domain Namespace bundle AAD domain is invalid");
    }
    return Object.freeze({
      formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_BINDING_PURPOSE_V2,
      operationId: portable("Domain Namespace operation ID", reader.readText(V2_LIMITS.idBytes)),
      serverId: portable("Server ID", reader.readText(V2_LIMITS.idBytes)),
      cryptoDomainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
      participantDigest: reader.readFrame(HASH_BYTES),
      participantCount: counter("Domain participant count", reader.readU64(), 1),
      keyClass: domainKeyClassV2(reader.readText(16)),
      domainKeyGeneration: counter("Domain key generation", reader.readU64(), 1),
      domainAuthorizationRevision: authorizationRevision(reader.readU64()),
      domainHeadDigest: reader.readFrame(HASH_BYTES),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      namespaceAccessRevision: accessRevision(reader.readU64()),
      namespaceCurrentGeneration: namespaceGeneration(reader.readU64()),
      bundleRevision: counter("Namespace bundle revision", reader.readU64(), 1),
      retainedGenerationCount: reader.readCount(
        DOMAIN_NAMESPACE_BUNDLE_MAX_RETAINED_GENERATIONS_V2,
      ),
      retainedAuthoritySetDigest: reader.readFrame(HASH_BYTES),
      plaintextDigest: reader.readFrame(HASH_BYTES),
      previousBindingDigest: readNullableDigest(reader),
      issuerHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      issuerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      issuerDeviceSigningGeneration: counter(
        "Domain Namespace issuer signing generation",
        reader.readU64(),
        1,
      ),
      issuedAt: counter("Domain Namespace bundle issued time", reader.readU64()),
      ciphertext: reader.readFrame(DOMAIN_NAMESPACE_BUNDLE_MAX_INNER_BYTES_V2 + 64),
      ciphertextDigest: reader.readFrame(HASH_BYTES),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    });
  });
  const canonical = encodeDomainNamespaceBundleBindingV2(decoded);
  try {
    if (!sameBytes(canonical, bytes)) {
      throw new TypeError("Domain Namespace bundle binding is noncanonical");
    }
    return decoded;
  } catch (error) {
    destroyDomainNamespaceBundleBindingV2(decoded);
    throw error;
  } finally {
    canonical.fill(0);
  }
}

/** Verify the canonical signed outer binding without opening its ciphertext. */
export function verifyDomainNamespaceBundleBindingV2(
  crypto: Pick<LatticeCrypto, "hash" | "verify">,
  input: Readonly<{
    bindingBytes: Uint8Array;
    issuerSigningPublicKey: Uint8Array;
    expectedBindingDigest?: Uint8Array;
  }>,
): DomainNamespaceBundleBindingV2 | null {
  let binding: DomainNamespaceBundleBindingV2 | undefined;
  let signing: Uint8Array | undefined;
  let digest: Uint8Array | undefined;
  let ciphertextDigest: Uint8Array | undefined;
  const publicKey = exactBytes(
    "Domain Namespace issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  try {
    binding = decodeDomainNamespaceBundleBindingV2(input.bindingBytes);
    signing = bindingSigningBytes(binding);
    digest = crypto.hash(input.bindingBytes);
    ciphertextDigest = crypto.hash(binding.ciphertext);
    if (
      !crypto.verify(publicKey, signing, binding.signature)
      || !sameBytes(ciphertextDigest, binding.ciphertextDigest)
      || (input.expectedBindingDigest !== undefined
        && !sameBytes(digest, input.expectedBindingDigest))
    ) return null;
    return decodeDomainNamespaceBundleBindingV2(input.bindingBytes);
  } catch {
    return null;
  } finally {
    publicKey.fill(0);
    signing?.fill(0);
    digest?.fill(0);
    ciphertextDigest?.fill(0);
    if (binding) destroyDomainNamespaceBundleBindingV2(binding);
  }
}

export function prepareDomainNamespaceBundleV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    operationId: string;
    bundle: DomainNamespaceBundleV2;
    previousBindingDigest: Uint8Array | null;
    issuerHumanId: HumanId;
    issuerDeviceId: CryptoDeviceId;
    issuerDeviceSigningGeneration: number;
    issuerSigningPrivateKey: Uint8Array;
    issuerSigningPublicKey: Uint8Array;
    domainKey: Uint8Array;
    issuedAt: number;
  }>,
): PreparedDomainNamespaceBundleV2 {
  const bundle = normalizeBundle(input.bundle);
  const domainKey = exactBytes("Domain key", input.domainKey, DOMAIN_KEY_BYTES_V2);
  const signingPrivateKey = exactBytes(
    "Domain Namespace issuer signing private key",
    input.issuerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const signingPublicKey = exactBytes(
    "Domain Namespace issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  let plaintext: Uint8Array | undefined;
  let plaintextDigest: Uint8Array | undefined;
  let retainedDigest: Uint8Array | undefined;
  let aad: Uint8Array | undefined;
  let ciphertext: Uint8Array | undefined;
  let ciphertextDigest: Uint8Array | undefined;
  let signing: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    retainedDigest = domainNamespaceRetainedAuthoritySetDigestV2(
      crypto,
      bundle.retainedGenerations,
    );
    if (!sameBytes(retainedDigest, bundle.retainedAuthoritySetDigest)) {
      throw new TypeError("Domain Namespace retained authority set disagrees");
    }
    plaintext = bundleBytes(bundle);
    plaintextDigest = crypto.hash(plaintext);
    const coordinates: BundleCoordinatesV2 = Object.freeze({
      operationId: portable("Domain Namespace operation ID", input.operationId),
      serverId: bundle.serverId,
      cryptoDomainId: bundle.cryptoDomainId,
      participantDigest: bundle.participantDigest,
      participantCount: bundle.participantCount,
      keyClass: bundle.keyClass,
      domainKeyGeneration: bundle.domainKeyGeneration,
      domainAuthorizationRevision: bundle.domainAuthorizationRevision,
      domainHeadDigest: bundle.domainHeadDigest,
      namespaceId: bundle.namespaceId,
      namespaceAccessRevision: bundle.namespaceAccessRevision,
      namespaceCurrentGeneration: bundle.namespaceCurrentGeneration,
      bundleRevision: bundle.bundleRevision,
      retainedGenerationCount: bundle.retainedGenerationCount,
      retainedAuthoritySetDigest: bundle.retainedAuthoritySetDigest,
      plaintextDigest,
      previousBindingDigest: input.previousBindingDigest,
      issuerHumanId: humanId(input.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(input.issuerDeviceId),
      issuerDeviceSigningGeneration: counter(
        "Domain Namespace issuer signing generation",
        input.issuerDeviceSigningGeneration,
        1,
      ),
      issuedAt: counter("Domain Namespace bundle issued time", input.issuedAt),
    });
    aad = aadBytes(coordinates);
    ciphertext = crypto.aeadSeal(domainKey, plaintext, aad);
    ciphertextDigest = crypto.hash(ciphertext);
    const unsigned = Object.freeze({
      formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_BINDING_PURPOSE_V2,
      ...coordinates,
      participantDigest: coordinates.participantDigest.slice(),
      domainHeadDigest: coordinates.domainHeadDigest.slice(),
      retainedAuthoritySetDigest: coordinates.retainedAuthoritySetDigest.slice(),
      plaintextDigest: coordinates.plaintextDigest.slice(),
      previousBindingDigest: coordinates.previousBindingDigest?.slice() ?? null,
      ciphertext: ciphertext.slice(),
      ciphertextDigest: ciphertextDigest.slice(),
    });
    signing = bindingSigningBytes(unsigned);
    signature = crypto.sign(signingPrivateKey, signing);
    if (!crypto.verify(signingPublicKey, signing, signature)) {
      throw new TypeError("Domain Namespace signing keys do not match");
    }
    const bytes = encodeDomainNamespaceBundleBindingV2({ ...unsigned, signature });
    return Object.freeze({
      binding: decodeDomainNamespaceBundleBindingV2(bytes),
      bytes,
      bindingDigest: crypto.hash(bytes),
      plaintextDigest: plaintextDigest.slice(),
    });
  } finally {
    destroyDomainNamespaceBundleV2(bundle);
    domainKey.fill(0);
    signingPrivateKey.fill(0);
    signingPublicKey.fill(0);
    plaintext?.fill(0);
    plaintextDigest?.fill(0);
    retainedDigest?.fill(0);
    aad?.fill(0);
    ciphertext?.fill(0);
    ciphertextDigest?.fill(0);
    signing?.fill(0);
    signature?.fill(0);
  }
}

export async function withOpenedDomainNamespaceBundleV2<Value>(
  crypto: LatticeCrypto,
  input: Readonly<{
    bindingBytes: Uint8Array;
    expectedBindingDigest?: Uint8Array;
    issuerSigningPublicKey: Uint8Array;
    domainKey: Uint8Array;
    current: Readonly<{
      serverId: string;
      cryptoDomainId: CryptoDomainId;
      participantDigest: Uint8Array;
      participantCount: number;
      keyClass: DomainKeyClassV2;
      domainKeyGeneration: number;
      domainAuthorizationRevision: AuthorizationRevision;
      domainHeadDigest: Uint8Array;
      namespaceId: NamespaceId;
      namespaceAccessRevision: AccessRevision;
      namespaceCurrentGeneration: NamespaceKeyGeneration;
      bundleRevision: number;
      retainedAuthoritySetDigest: Uint8Array;
    }>;
    operation(
      retained: readonly DomainNamespaceRetainedGenerationV2[],
    ): Value | PromiseLike<Value>;
  }>,
): Promise<OpenDomainNamespaceBundleResultV2<Value>> {
  let binding: DomainNamespaceBundleBindingV2 | undefined;
  let signing: Uint8Array | undefined;
  let aad: Uint8Array | undefined;
  let plaintext: Uint8Array | null = null;
  let bundle: DomainNamespaceBundleV2 | undefined;
  let operationStarted = false;
  const signingPublicKey = exactBytes(
    "Domain Namespace issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const domainKey = exactBytes("Domain key", input.domainKey, DOMAIN_KEY_BYTES_V2);
  try {
    binding = decodeDomainNamespaceBundleBindingV2(input.bindingBytes);
    if (input.expectedBindingDigest !== undefined) {
      const actual = crypto.hash(input.bindingBytes);
      try {
        if (!sameBytes(actual, input.expectedBindingDigest)) {
          return Object.freeze({ status: "unavailable", reason: "invalid" });
        }
      } finally {
        actual.fill(0);
      }
    }
    if (!bindingMatchesCurrent(binding, input.current)) {
      return Object.freeze({ status: "unavailable", reason: "authority_stale" });
    }
    signing = bindingSigningBytes(binding);
    if (!crypto.verify(signingPublicKey, signing, binding.signature)) {
      return Object.freeze({ status: "unavailable", reason: "invalid" });
    }
    const actualCiphertextDigest = crypto.hash(binding.ciphertext);
    try {
      if (!sameBytes(actualCiphertextDigest, binding.ciphertextDigest)) {
        return Object.freeze({ status: "unavailable", reason: "invalid" });
      }
    } finally {
      actualCiphertextDigest.fill(0);
    }
    aad = aadBytes(binding);
    plaintext = crypto.aeadOpen(domainKey, binding.ciphertext, aad);
    if (plaintext === null) {
      return Object.freeze({ status: "unavailable", reason: "secret_unavailable" });
    }
    const actualPlaintextDigest = crypto.hash(plaintext);
    try {
      if (!sameBytes(actualPlaintextDigest, binding.plaintextDigest)) {
        return Object.freeze({ status: "unavailable", reason: "invalid" });
      }
    } finally {
      actualPlaintextDigest.fill(0);
    }
    bundle = decodeDomainNamespaceBundleV2(plaintext);
    const retainedDigest = domainNamespaceRetainedAuthoritySetDigestV2(
      crypto,
      bundle.retainedGenerations,
    );
    try {
      if (
        !bundleMatchesBinding(bundle, binding)
        || !sameBytes(retainedDigest, binding.retainedAuthoritySetDigest)
      ) return Object.freeze({ status: "unavailable", reason: "invalid" });
    } finally {
      retainedDigest.fill(0);
    }
    operationStarted = true;
    const value = await input.operation(bundle.retainedGenerations);
    operationStarted = false;
    return Object.freeze({ status: "opened", value });
  } catch (error) {
    if (operationStarted) throw error;
    return Object.freeze({ status: "unavailable", reason: "invalid" });
  } finally {
    signingPublicKey.fill(0);
    domainKey.fill(0);
    signing?.fill(0);
    aad?.fill(0);
    plaintext?.fill(0);
    if (bundle) destroyDomainNamespaceBundleV2(bundle);
    if (binding) destroyDomainNamespaceBundleBindingV2(binding);
  }
}

function bindingMatchesCurrent(
  binding: DomainNamespaceBundleBindingV2,
  current: Parameters<typeof withOpenedDomainNamespaceBundleV2>[1]["current"],
): boolean {
  return binding.serverId === current.serverId
    && binding.cryptoDomainId === current.cryptoDomainId
    && binding.participantCount === current.participantCount
    && binding.keyClass === current.keyClass
    && binding.domainKeyGeneration === current.domainKeyGeneration
    && binding.domainAuthorizationRevision === current.domainAuthorizationRevision
    && binding.namespaceId === current.namespaceId
    && binding.namespaceAccessRevision === current.namespaceAccessRevision
    && binding.namespaceCurrentGeneration === current.namespaceCurrentGeneration
    && binding.bundleRevision === current.bundleRevision
    && sameBytes(binding.participantDigest, current.participantDigest)
    && sameBytes(binding.domainHeadDigest, current.domainHeadDigest)
    && sameBytes(
      binding.retainedAuthoritySetDigest,
      current.retainedAuthoritySetDigest,
    );
}

function bundleMatchesBinding(
  bundle: DomainNamespaceBundleV2,
  binding: DomainNamespaceBundleBindingV2,
): boolean {
  return bundle.serverId === binding.serverId
    && bundle.cryptoDomainId === binding.cryptoDomainId
    && bundle.participantCount === binding.participantCount
    && bundle.keyClass === binding.keyClass
    && bundle.domainKeyGeneration === binding.domainKeyGeneration
    && bundle.domainAuthorizationRevision === binding.domainAuthorizationRevision
    && bundle.namespaceId === binding.namespaceId
    && bundle.namespaceAccessRevision === binding.namespaceAccessRevision
    && bundle.namespaceCurrentGeneration === binding.namespaceCurrentGeneration
    && bundle.bundleRevision === binding.bundleRevision
    && bundle.retainedGenerationCount === binding.retainedGenerationCount
    && sameBytes(bundle.participantDigest, binding.participantDigest)
    && sameBytes(bundle.domainHeadDigest, binding.domainHeadDigest)
    && sameBytes(
      bundle.retainedAuthoritySetDigest,
      binding.retainedAuthoritySetDigest,
    );
}

function destroyRetainedAuthority(value: DomainNamespaceRetainedAuthorityV2): void {
  value.headDigest.fill(0);
}

function destroyRetained(value: DomainNamespaceRetainedGenerationV2): void {
  destroyRetainedAuthority(value);
  value.generationKey.fill(0);
}

export function destroyDomainNamespaceBundleV2(
  value: DomainNamespaceBundleV2,
): void {
  value.participantDigest.fill(0);
  value.domainHeadDigest.fill(0);
  value.retainedAuthoritySetDigest.fill(0);
  value.retainedGenerations.forEach(destroyRetained);
}

export function destroyDomainNamespaceBundleBindingV2(
  value: DomainNamespaceBundleBindingV2,
): void {
  value.participantDigest.fill(0);
  value.domainHeadDigest.fill(0);
  value.retainedAuthoritySetDigest.fill(0);
  value.plaintextDigest.fill(0);
  value.ciphertext.fill(0);
  value.ciphertextDigest.fill(0);
  value.previousBindingDigest?.fill(0);
  value.signature.fill(0);
}
