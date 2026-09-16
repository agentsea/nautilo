import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  RECOVERY_PUBLIC_KEY_DIGEST_BYTES,
  assertTrustedCurrentRecoveryKey,
  recoveryPublicKeyDigest,
  recoveryKeyGeneration,
  type RecoveryKeyGeneration,
  type ResolveTrustedCurrentRecoveryKeyV2,
  type TrustedCurrentRecoveryKeyV2,
} from "../format/recovery-v2.ts";
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import {
  agentId,
  agentRuntimeGeneration,
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  unixTimestamp,
  type AgentId,
  type AgentRuntimeGeneration,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type HumanId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import {
  V2_LIMITS,
  assertV2Limit,
  assertV2Range,
} from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const AGENT_MANAGER_RECOVERY_DOMAIN =
  "nautilo/lattice-crypto/agent-manager-recovery/v2";
export const AGENT_MANAGER_RECOVERY_VERSION = 2 as const;
const KEYRING_KIND = "agent-manager-keyring";
const PACKAGE_KIND = "agent-manager-package";
const ISSUER_PROOF_KIND = "agent-manager-issuer-proof";
const KEY_BYTES = 32;
const MAX_PACKAGE_METADATA_BYTES = 2 * 1024;
const MAX_PACKAGE_WIRE_BYTES =
  V2_LIMITS.ciphertextBytes + MAX_PACKAGE_METADATA_BYTES;
const AGENT_MANAGER_PACKAGE_FIELDS = Object.freeze([
  "formatVersion",
  "managerHumanId",
  "agentId",
  "keyClass",
  "managerAuthorizationRevision",
  "recoveryKeyId",
  "recoveryGeneration",
  "recoveryPublicKeyDigest",
  "currentGeneration",
  "issuerDeviceId",
  "createdAt",
  "ciphertext",
  "signature",
]);
const AGENT_MANAGER_KEYRING_FIELDS = Object.freeze([
  "formatVersion",
  "agentId",
  "keyClass",
  "currentGeneration",
  "generations",
]);
const AGENT_MANAGER_GENERATION_FIELDS = Object.freeze([
  "generation",
  "key",
]);

export type AgentManagerKeyClass = "runtime" | "management";

export interface AgentManagerGenerationV2 {
  readonly generation: AgentRuntimeGeneration;
  readonly key: Uint8Array;
}

export interface AgentManagerKeyringV2 {
  readonly formatVersion: 2;
  readonly agentId: AgentId;
  readonly keyClass: AgentManagerKeyClass;
  readonly currentGeneration: AgentRuntimeGeneration;
  readonly generations: readonly AgentManagerGenerationV2[];
}

export interface AgentManagerRecoveryPackageV2 {
  readonly formatVersion: 2;
  readonly managerHumanId: HumanId;
  readonly agentId: AgentId;
  readonly keyClass: AgentManagerKeyClass;
  readonly managerAuthorizationRevision: AuthorizationRevision;
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: RecoveryKeyGeneration;
  readonly recoveryPublicKeyDigest: Uint8Array;
  readonly currentGeneration: AgentRuntimeGeneration;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly createdAt: UnixTimestamp;
  readonly ciphertext: Uint8Array;
  readonly signature: Uint8Array;
}

export type AgentManagerRecoveryMetadataV2 =
  Omit<AgentManagerRecoveryPackageV2, "ciphertext" | "signature">;

export interface AgentManagerAuthorityContextV2
  extends AgentManagerRecoveryMetadataV2 {
  readonly purpose:
    | "agent-manager-recovery-publish"
    | "agent-manager-recovery-restore";
}

export type ResolveCurrentAgentManagerAuthorityV2 = (
  context: AgentManagerAuthorityContextV2,
) => Uint8Array | null;

function assertExactFields(
  label: string,
  value: object,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedSet.has(field)) {
      throw new TypeError(`${label} contains unknown field ${field}`);
    }
  }
}

function assertBytes(
  label: string,
  value: unknown,
  expectedLength: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} bytes`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return bytesToHex(left) === bytesToHex(right);
}

function assertKeyClass(
  value: unknown,
): asserts value is AgentManagerKeyClass {
  if (value !== "runtime" && value !== "management") {
    throw new RangeError(
      "Agent manager recovery key class must be runtime or management",
    );
  }
}

function validateMetadata(
  value: AgentManagerRecoveryMetadataV2,
): AgentManagerRecoveryMetadataV2 {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Agent manager recovery metadata must be an object");
  }
  assertExactFields(
    "Agent manager recovery package",
    value,
    AGENT_MANAGER_PACKAGE_FIELDS,
  );
  if (value.formatVersion !== AGENT_MANAGER_RECOVERY_VERSION) {
    throw new RangeError("Agent manager recovery version is unsupported");
  }
  const keyClass = value.keyClass;
  assertKeyClass(keyClass);
  assertPortableId("Recovery key id", value.recoveryKeyId);
  return Object.freeze({
    formatVersion: AGENT_MANAGER_RECOVERY_VERSION,
    managerHumanId: humanId(value.managerHumanId),
    agentId: agentId(value.agentId),
    keyClass,
    managerAuthorizationRevision: authorizationRevision(
      value.managerAuthorizationRevision,
    ),
    recoveryKeyId: value.recoveryKeyId,
    recoveryGeneration: recoveryKeyGeneration(value.recoveryGeneration),
    recoveryPublicKeyDigest: (() => {
      assertBytes(
        "Agent manager recovery public-key digest",
        value.recoveryPublicKeyDigest,
        RECOVERY_PUBLIC_KEY_DIGEST_BYTES,
      );
      return copyOwnedBytesV2(value.recoveryPublicKeyDigest);
    })(),
    currentGeneration: agentRuntimeGeneration(value.currentGeneration),
    issuerDeviceId: cryptoDeviceId(value.issuerDeviceId),
    createdAt: unixTimestamp(value.createdAt),
  });
}

function metadataBytes(value: AgentManagerRecoveryMetadataV2): Uint8Array {
  const checked = validateMetadata(value);
  return concatV2(
    frameText(AGENT_MANAGER_RECOVERY_DOMAIN),
    frameText(PACKAGE_KIND),
    encodeU32(AGENT_MANAGER_RECOVERY_VERSION),
    frameText(checked.managerHumanId),
    frameText(checked.agentId),
    frameText(checked.keyClass),
    encodeU64(checked.managerAuthorizationRevision),
    frameText(checked.recoveryKeyId),
    encodeU64(checked.recoveryGeneration),
    frame(checked.recoveryPublicKeyDigest),
    encodeU64(checked.currentGeneration),
    frameText(checked.issuerDeviceId),
    encodeU64(checked.createdAt),
  );
}

function readExactText(
  reader: StrictDecoder,
  expected: string,
  label: string,
): void {
  if (reader.readText(utf8V2(expected).length) !== expected) {
    throw new CanonicalDecodingError(`${label} is unsupported`);
  }
}

function readMetadata(reader: StrictDecoder): AgentManagerRecoveryMetadataV2 {
  readExactText(
    reader,
    AGENT_MANAGER_RECOVERY_DOMAIN,
    "Agent manager recovery domain",
  );
  readExactText(reader, PACKAGE_KIND, "Agent manager recovery package kind");
  reader.readVersion(AGENT_MANAGER_RECOVERY_VERSION);
  const managerHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
  const targetAgentId = agentId(reader.readText(V2_LIMITS.idBytes));
  const keyClass = reader.readText("management".length);
  assertKeyClass(keyClass);
  const managerAuthorizationRevision = authorizationRevision(reader.readU64());
  const recoveryKeyId = reader.readText(V2_LIMITS.idBytes);
  assertPortableId("Recovery key id", recoveryKeyId);
  const recoveryGeneration = recoveryKeyGeneration(reader.readU64());
  const recoveryPublicKeyDigest = reader.readFrame(
    RECOVERY_PUBLIC_KEY_DIGEST_BYTES,
  );
  return validateMetadata({
    formatVersion: AGENT_MANAGER_RECOVERY_VERSION,
    managerHumanId,
    agentId: targetAgentId,
    keyClass,
    managerAuthorizationRevision,
    recoveryKeyId,
    recoveryGeneration,
    recoveryPublicKeyDigest,
    currentGeneration: agentRuntimeGeneration(reader.readU64()),
    issuerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
    createdAt: unixTimestamp(reader.readU64()),
  });
}

export function assertCanonicalAgentManagerKeyring(
  keyring: AgentManagerKeyringV2,
): void {
  if (typeof keyring !== "object" || keyring === null) {
    throw new TypeError("Agent manager keyring must be an object");
  }
  assertExactFields(
    "Agent manager keyring",
    keyring,
    AGENT_MANAGER_KEYRING_FIELDS,
  );
  if (keyring.formatVersion !== AGENT_MANAGER_RECOVERY_VERSION) {
    throw new RangeError("Agent manager keyring version is unsupported");
  }
  agentId(keyring.agentId);
  assertKeyClass(keyring.keyClass);
  agentRuntimeGeneration(keyring.currentGeneration);
  if (!Array.isArray(keyring.generations as unknown)) {
    throw new TypeError("Agent manager keyring generations must be an array");
  }
  assertV2Limit(
    "Agent manager retained generations",
    keyring.generations.length,
    V2_LIMITS.retainedAgentGenerations,
  );
  if (keyring.generations.length === 0) {
    throw new Error("Agent manager retained history must start at generation 0");
  }
  if (keyring.generations.length !== keyring.currentGeneration + 1) {
    throw new Error(
      "Agent manager retained history must be complete through current generation",
    );
  }
  for (let index = 0; index < keyring.generations.length; index++) {
    const item = keyring.generations[index];
    if (typeof item !== "object" || item === null) {
      throw new TypeError("Agent manager generation must be an object");
    }
    assertExactFields(
      "Agent manager generation",
      item,
      AGENT_MANAGER_GENERATION_FIELDS,
    );
    if (agentRuntimeGeneration(item.generation) !== index) {
      throw new Error(
        "Agent manager retained history must be contiguous from generation 0",
      );
    }
    assertBytes("Agent manager generation key", item.key, KEY_BYTES);
  }
}

export function encodeAgentManagerKeyring(
  keyring: AgentManagerKeyringV2,
): Uint8Array {
  assertCanonicalAgentManagerKeyring(keyring);
  const framedKeys = keyring.generations.map((item) => frame(item.key));
  try {
    return concatV2(
      frameText(AGENT_MANAGER_RECOVERY_DOMAIN),
      frameText(KEYRING_KIND),
      encodeU32(AGENT_MANAGER_RECOVERY_VERSION),
      frameText(keyring.agentId),
      frameText(keyring.keyClass),
      encodeU64(keyring.currentGeneration),
      encodeU32(keyring.generations.length),
      ...keyring.generations.flatMap((item, index) => [
        encodeU64(item.generation),
        framedKeys[index]!,
      ]),
    );
  } finally {
    framedKeys.forEach((value) => value.fill(0));
  }
}

export function decodeAgentManagerKeyring(
  bytes: Uint8Array,
): AgentManagerKeyringV2 {
  if (!(bytes instanceof Uint8Array)) {
    throw new CanonicalDecodingError(
      "Agent manager keyring exceeds the plaintext limit",
    );
  }
  try {
    assertV2Limit(
      AGENT_MANAGER_RECOVERY_DOMAIN,
      bytes.length,
      V2_LIMITS.plaintextBytes,
    );
  } catch {
    throw new CanonicalDecodingError(
      "Agent manager keyring exceeds the plaintext limit",
    );
  }
  const reader = new StrictDecoder(bytes);
  const generations: AgentManagerGenerationV2[] = [];
  let succeeded = false;
  try {
    readExactText(
      reader,
      AGENT_MANAGER_RECOVERY_DOMAIN,
      "Agent manager recovery domain",
    );
    readExactText(reader, KEYRING_KIND, "Agent manager keyring kind");
    reader.readVersion(AGENT_MANAGER_RECOVERY_VERSION);
    const targetAgentId = agentId(reader.readText(V2_LIMITS.idBytes));
    const keyClass = reader.readText("management".length);
    assertKeyClass(keyClass);
    const currentGeneration = agentRuntimeGeneration(reader.readU64());
    const count = reader.readCount(V2_LIMITS.retainedAgentGenerations);
    for (let index = 0; index < count; index++) {
      generations.push({
        generation: agentRuntimeGeneration(reader.readU64()),
        key: reader.readFrame(KEY_BYTES),
      });
    }
    reader.assertFinished();
    const keyring: AgentManagerKeyringV2 = {
      formatVersion: AGENT_MANAGER_RECOVERY_VERSION,
      agentId: targetAgentId,
      keyClass,
      currentGeneration,
      generations,
    };
    assertCanonicalAgentManagerKeyring(keyring);
    const result = Object.freeze({
      ...keyring,
      generations: Object.freeze(
        generations.map((item) => Object.freeze(item)),
      ),
    });
    succeeded = true;
    return result;
  } finally {
    if (!succeeded) generations.forEach((item) => item.key.fill(0));
    reader.destroy(!succeeded);
  }
}

function cloneKeyring(keyring: AgentManagerKeyringV2): AgentManagerKeyringV2 {
  return Object.freeze({
    ...keyring,
    generations: Object.freeze(
      keyring.generations.map((item) =>
        Object.freeze({ ...item, key: copyOwnedBytesV2(item.key) })
      ),
    ),
  });
}

export function agentManagerRecoveryPackageAad(
  value: AgentManagerRecoveryMetadataV2,
): Uint8Array {
  return metadataBytes(value);
}

export function agentManagerRecoveryPackageSigningBytes(
  value: Omit<AgentManagerRecoveryPackageV2, "signature">,
): Uint8Array {
  if (!(value.ciphertext instanceof Uint8Array)) {
    throw new TypeError("Agent manager recovery ciphertext must be bytes");
  }
  assertV2Range(
    "Agent manager recovery ciphertext bytes",
    value.ciphertext.length,
    1,
    V2_LIMITS.ciphertextBytes,
  );
  return concatV2(metadataBytes(value), frame(sha256(value.ciphertext)));
}

export function serializeAgentManagerRecoveryPackage(
  value: AgentManagerRecoveryPackageV2,
): Uint8Array {
  assertBytes(
    "Agent manager recovery signature",
    value.signature,
    V2_LIMITS.signatureBytes,
  );
  agentManagerRecoveryPackageSigningBytes(value);
  return concatV2(
    metadataBytes(value),
    frame(value.ciphertext),
    frame(value.signature),
  );
}

export function decodeAgentManagerRecoveryPackage(
  bytes: Uint8Array,
): AgentManagerRecoveryPackageV2 {
  if (!(bytes instanceof Uint8Array)) {
    throw new CanonicalDecodingError(
      "Agent manager recovery package exceeds wire limits",
    );
  }
  try {
    assertV2Limit(
      AGENT_MANAGER_RECOVERY_DOMAIN,
      bytes.length,
      MAX_PACKAGE_WIRE_BYTES,
    );
  } catch {
    throw new CanonicalDecodingError(
      "Agent manager recovery package exceeds wire limits",
    );
  }
  return decodeExact(bytes, (reader) => {
    const metadata = readMetadata(reader);
    const ciphertext = reader.readFrame(V2_LIMITS.ciphertextBytes);
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    assertBytes(
      "Agent manager recovery signature",
      signature,
      V2_LIMITS.signatureBytes,
    );
    if (ciphertext.length === 0) {
      throw new CanonicalDecodingError(
        "Agent manager recovery ciphertext must not be empty",
      );
    }
    return Object.freeze({
      ...metadata,
      ciphertext,
      signature,
    });
  });
}

function managerContext(
  purpose: AgentManagerAuthorityContextV2["purpose"],
  metadata: AgentManagerRecoveryMetadataV2,
): AgentManagerAuthorityContextV2 {
  return Object.freeze({ ...validateMetadata(metadata), purpose });
}

function resolveManager(
  metadata: AgentManagerRecoveryMetadataV2,
  purpose: AgentManagerAuthorityContextV2["purpose"],
  resolver: ResolveCurrentAgentManagerAuthorityV2,
): Uint8Array {
  const publicKey = resolver(managerContext(purpose, metadata));
  if (publicKey === null) {
    throw new Error(
      "Current explicit Agent manager authorization is required",
    );
  }
  assertBytes(
    "Agent manager issuer signing public key",
    publicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  return publicKey;
}

function issuerProofBytes(
  metadata: AgentManagerRecoveryMetadataV2,
): Uint8Array {
  return concatV2(
    frameText(AGENT_MANAGER_RECOVERY_DOMAIN),
    frameText(ISSUER_PROOF_KIND),
    metadataBytes(metadata),
  );
}

function assertIssuerPrivateKey(
  crypto: LatticeCrypto,
  metadata: AgentManagerRecoveryMetadataV2,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): void {
  const proof = issuerProofBytes(metadata);
  if (!crypto.verify(publicKey, proof, crypto.sign(privateKey, proof))) {
    throw new Error(
      "Agent manager issuer signing key does not match current authority",
    );
  }
}

function packagePlaintext(
  metadata: AgentManagerRecoveryMetadataV2,
  keyring: AgentManagerKeyringV2,
): Uint8Array {
  const encodedKeyring = encodeAgentManagerKeyring(keyring);
  const framedKeyring = frame(encodedKeyring);
  try {
    return concatV2(
      frame(metadataBytes(metadata)),
      framedKeyring,
    );
  } finally {
    encodedKeyring.fill(0);
    framedKeyring.fill(0);
  }
}

function decodePackagePlaintext(
  plaintext: Uint8Array,
): {
  readonly metadataBytes: Uint8Array;
  readonly keyring: AgentManagerKeyringV2;
} {
  const reader = new StrictDecoder(plaintext);
  let keyring: AgentManagerKeyringV2 | null = null;
  let succeeded = false;
  try {
    const embeddedMetadata = reader.readFrame(MAX_PACKAGE_METADATA_BYTES);
    const encodedKeyring = reader.readFrame(V2_LIMITS.plaintextBytes);
    try {
      keyring = decodeAgentManagerKeyring(encodedKeyring);
    } finally {
      encodedKeyring.fill(0);
    }
    reader.assertFinished();
    const result = { metadataBytes: embeddedMetadata, keyring };
    succeeded = true;
    return result;
  } catch (error) {
    keyring?.generations.forEach((item) => item.key.fill(0));
    throw error;
  } finally {
    reader.destroy(!succeeded);
  }
}

function metadataMatches(
  left: AgentManagerRecoveryMetadataV2,
  right: AgentManagerRecoveryMetadataV2,
): boolean {
  return equalBytes(metadataBytes(left), metadataBytes(right));
}

function resolveTrustedRecoveryKey(
  resolver: ResolveTrustedCurrentRecoveryKeyV2,
  human: HumanId,
): TrustedCurrentRecoveryKeyV2 {
  const record = resolver(human);
  if (record === null) {
    throw new Error(
      "Trusted current recovery-key record is required for the manager",
    );
  }
  assertTrustedCurrentRecoveryKey(record);
  if (record.humanId !== human) {
    throw new Error(
      "Trusted current recovery-key record belongs to another Human",
    );
  }
  return record;
}

export async function publishAgentManagerRecoveryPackage(input: {
  readonly crypto: LatticeCrypto;
  readonly metadata: AgentManagerRecoveryMetadataV2;
  readonly keyring: AgentManagerKeyringV2;
  readonly currentRecoveryKeyId: string;
  readonly currentRecoveryGeneration: RecoveryKeyGeneration;
  readonly recoveryPublicKey: Uint8Array;
  readonly resolveTrustedCurrentRecoveryKey:
    ResolveTrustedCurrentRecoveryKeyV2;
  readonly issuerSigningPrivateKey: Uint8Array;
  readonly resolveCurrentManagerAuthority:
    ResolveCurrentAgentManagerAuthorityV2;
}): Promise<{
  readonly package: AgentManagerRecoveryPackageV2;
  readonly packageBytes: Uint8Array;
}> {
  const metadata = validateMetadata(input.metadata);
  assertPortableId("Current recovery key id", input.currentRecoveryKeyId);
  const currentRecoveryGeneration = recoveryKeyGeneration(
    input.currentRecoveryGeneration,
  );
  if (
    metadata.recoveryKeyId !== input.currentRecoveryKeyId
    || metadata.recoveryGeneration !== currentRecoveryGeneration
  ) {
    throw new Error(
      "Agent manager recovery publication does not target the current recovery key generation",
    );
  }
  assertCanonicalAgentManagerKeyring(input.keyring);
  if (
    input.keyring.agentId !== metadata.agentId
    || input.keyring.keyClass !== metadata.keyClass
    || input.keyring.currentGeneration !== metadata.currentGeneration
  ) {
    throw new Error(
      "Agent manager recovery keyring does not match package metadata",
    );
  }
  assertBytes(
    "Agent manager recovery public key",
    input.recoveryPublicKey,
    V2_LIMITS.hpkePublicKeyBytes,
  );
  assertBytes(
    "Agent manager issuer signing private key",
    input.issuerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const recoveryPublicKey = copyOwnedBytesV2(input.recoveryPublicKey);
  const issuerSigningPrivateKey = copyOwnedBytesV2(
    input.issuerSigningPrivateKey,
  );
  try {
  const candidateRecoveryKeyDigest = recoveryPublicKeyDigest(
    recoveryPublicKey,
  );
  const trustedRecoveryKey = resolveTrustedRecoveryKey(
    input.resolveTrustedCurrentRecoveryKey,
    metadata.managerHumanId,
  );
  if (
    trustedRecoveryKey.recoveryKeyId !== input.currentRecoveryKeyId
    || trustedRecoveryKey.recoveryGeneration !== currentRecoveryGeneration
    || !equalBytes(
      trustedRecoveryKey.publicKeyDigest,
      candidateRecoveryKeyDigest,
    )
    || !equalBytes(
      metadata.recoveryPublicKeyDigest,
      candidateRecoveryKeyDigest,
    )
  ) {
    throw new Error(
      "Agent manager recovery recipient is not the trusted current recovery key",
    );
  }
  const issuerPublicKey = resolveManager(
    metadata,
    "agent-manager-recovery-publish",
    input.resolveCurrentManagerAuthority,
  );
  assertIssuerPrivateKey(
    input.crypto,
    metadata,
    issuerSigningPrivateKey,
    issuerPublicKey,
  );
  const plaintext = packagePlaintext(metadata, input.keyring);
  try {
    const ciphertext = await input.crypto.sealTo(
      recoveryPublicKey,
      plaintext,
    );
    if (ciphertext.length > V2_LIMITS.ciphertextBytes) {
      throw new RangeError(
        "Agent manager recovery ciphertext exceeds format limits",
      );
    }
    const unsigned = Object.freeze({
      ...metadata,
      ciphertext: copyOwnedBytesV2(ciphertext),
    });
    const signature = input.crypto.sign(
      issuerSigningPrivateKey,
      agentManagerRecoveryPackageSigningBytes(unsigned),
    );
    const recoveryPackage = Object.freeze({
      ...unsigned,
      signature: copyOwnedBytesV2(signature),
    });
    return Object.freeze({
      package: recoveryPackage,
      packageBytes:
        serializeAgentManagerRecoveryPackage(recoveryPackage),
    });
  } finally {
    plaintext.fill(0);
  }
  } finally {
    recoveryPublicKey.fill(0);
    issuerSigningPrivateKey.fill(0);
  }
}

export async function openAgentManagerRecoveryPackage(input: {
  readonly crypto: LatticeCrypto;
  readonly packageBytes: Uint8Array;
  readonly expectedMetadata: AgentManagerRecoveryMetadataV2;
  readonly currentRecoveryKeyId: string;
  readonly currentRecoveryGeneration: RecoveryKeyGeneration;
  readonly recoveryPrivateKey: Uint8Array;
  readonly resolveTrustedCurrentRecoveryKey:
    ResolveTrustedCurrentRecoveryKeyV2;
  readonly resolveCurrentManagerAuthority:
    ResolveCurrentAgentManagerAuthorityV2;
}): Promise<AgentManagerKeyringV2> {
  const expected = validateMetadata(input.expectedMetadata);
  assertPortableId("Current recovery key id", input.currentRecoveryKeyId);
  const currentRecoveryGeneration = recoveryKeyGeneration(
    input.currentRecoveryGeneration,
  );
  assertBytes(
    "Agent manager recovery private key",
    input.recoveryPrivateKey,
    V2_LIMITS.hpkePrivateKeyBytes,
  );
  const recoveryPrivateKey = copyOwnedBytesV2(
    input.recoveryPrivateKey,
  );
  try {
  const recoveryPackage = decodeAgentManagerRecoveryPackage(
    input.packageBytes,
  );
  if (!metadataMatches(recoveryPackage, expected)) {
    throw new Error(
      "Agent manager recovery package does not match expected manager context",
    );
  }
  if (
    recoveryPackage.recoveryKeyId !== input.currentRecoveryKeyId
    || recoveryPackage.recoveryGeneration !== currentRecoveryGeneration
  ) {
    throw new Error(
      "Agent manager recovery package does not target the current recovery key generation",
    );
  }
  const trustedRecoveryKey = resolveTrustedRecoveryKey(
    input.resolveTrustedCurrentRecoveryKey,
    recoveryPackage.managerHumanId,
  );
  if (
    trustedRecoveryKey.recoveryKeyId !== input.currentRecoveryKeyId
    || trustedRecoveryKey.recoveryGeneration !== currentRecoveryGeneration
    || !equalBytes(
      trustedRecoveryKey.publicKeyDigest,
      recoveryPackage.recoveryPublicKeyDigest,
    )
  ) {
    throw new Error(
      "Agent manager recovery package does not match the trusted current recovery key",
    );
  }
  const issuerPublicKey = resolveManager(
    recoveryPackage,
    "agent-manager-recovery-restore",
    input.resolveCurrentManagerAuthority,
  );
  if (
    !input.crypto.verify(
      issuerPublicKey,
      agentManagerRecoveryPackageSigningBytes(recoveryPackage),
      recoveryPackage.signature,
    )
  ) {
    throw new Error("Agent manager recovery package signature is invalid");
  }
  const plaintext = await input.crypto.openSealed(
    recoveryPrivateKey,
    recoveryPackage.ciphertext,
  );
  if (plaintext === null) {
    throw new Error("Agent manager recovery package failed to decrypt");
  }
  let decoded: ReturnType<typeof decodePackagePlaintext> | null = null;
  try {
    decoded = decodePackagePlaintext(plaintext);
    if (
      !equalBytes(decoded.metadataBytes, metadataBytes(recoveryPackage))
      || decoded.keyring.agentId !== recoveryPackage.agentId
      || decoded.keyring.keyClass !== recoveryPackage.keyClass
      || decoded.keyring.currentGeneration
        !== recoveryPackage.currentGeneration
    ) {
      throw new Error(
        "Agent manager recovery inner and outer metadata do not match",
      );
    }
    return cloneKeyring(decoded.keyring);
  } finally {
    plaintext.fill(0);
    decoded?.keyring.generations.forEach((item) => item.key.fill(0));
  }
  } finally {
    recoveryPrivateKey.fill(0);
  }
}
