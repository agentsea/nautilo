import { sha256 } from "@noble/hashes/sha2.js";
import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import {
  HUMAN_RECOVERY_FORMAT_VERSION,
  assertTrustedCurrentRecoveryKey,
  assertCanonicalHumanRecoveryArchive,
  decodeHumanRecoveryArchive,
  humanRecoveryArchiveSigningBytes,
  namespaceRecoveryPackageAad,
  namespaceRecoveryPackageSigningBytes,
  recoveryPublicKeyDigest,
  recoveryKeyGeneration,
  serializeHumanRecoveryArchive,
  serializeNamespaceRecoveryPackage,
  type HumanRecoveryArchiveV2,
  type NamespaceRecoveryPackageMetadataV2,
  type NamespaceRecoveryPackageV2,
  type RecoveryKeyGeneration,
  type ResolveTrustedCurrentRecoveryKeyV2,
  type TrustedCurrentRecoveryKeyV2,
} from "../format/recovery-v2.ts";
import {
  assertCanonicalNamespaceKeyring,
  decodeNamespaceKeyring,
  encodeNamespaceKeyring,
} from "../format/namespace-keyring-v2.ts";
import {
  CanonicalDecodingError,
  concatV2,
  decodeExact,
  frame,
  frameText,
} from "../format/v2-primitives.ts";
import {
  namespaceKeyringEnvelopeHash,
} from "../namespace/bindings.ts";
import type {
  HistoricalCommitterResolverV2,
} from "../namespace/authorization.ts";
import { openNamespaceKeyring } from "../namespace/keyrings.ts";
import {
  recoveryArchiveWriteRecordV2,
} from "../storage/v2-record-policy.ts";
import type {
  OpaqueRecoveryPackageRecordV2,
  RecoveryArchiveCasStatusV2,
  RecoveryArchiveStorageExpectationV2,
  RecoveryArchiveWireRecordV2,
} from "../storage/v2-records.ts";
import type {
  NamespaceKeyClass,
  NamespaceKeyringEnvelopeV2,
  NamespaceKeyringPlaintextV2,
  VerifiedNamespaceBindingHeadV2,
} from "../namespace/types.ts";
import {
  assertPortableId,
  cryptoDeviceId,
  humanId,
  unixTimestamp,
  type CryptoDeviceId,
  type HumanId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import {
  assertBytes,
  assertConsistentCurrentDomainEpochsV2,
  assertExactFields,
  assertExactTrustedNamespaceHeadV2,
  equalBytes,
  predictedHpkeCiphertextBytes,
} from "./device-transfer-common-v2.ts";

const MAX_PACKAGE_AAD_BYTES = 2 * 1024;
const ISSUER_PROOF_DOMAIN =
  "nautilo/lattice-crypto/recovery-publication-issuer-proof/v2";
const RECOVERY_INVENTORY_FIELDS = Object.freeze([
  "authorizedHumanId",
  "trustedNamespaceHead",
  "keyClass",
]);
const RECOVERY_SOURCE_FIELDS = Object.freeze([
  ...RECOVERY_INVENTORY_FIELDS,
  "currentKeyringEnvelope",
  "currentDomainRoot",
  "resolveHistoricalCommitter",
]);

export interface HumanRecoveryInventoryItemV2 {
  readonly authorizedHumanId: HumanId;
  readonly trustedNamespaceHead: VerifiedNamespaceBindingHeadV2;
  readonly keyClass: NamespaceKeyClass;
}

export interface HumanRecoveryKeyringSourceV2
  extends HumanRecoveryInventoryItemV2 {
  readonly currentKeyringEnvelope: NamespaceKeyringEnvelopeV2;
  readonly currentDomainRoot: Uint8Array;
  readonly resolveHistoricalCommitter: HistoricalCommitterResolverV2;
}

export interface HumanRecoveryIssuerContextV2 {
  readonly purpose:
    | "human-recovery-archive"
    | "namespace-recovery-package";
  readonly humanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly createdAt: UnixTimestamp;
  readonly namespaceId?: string;
  readonly keyClass?: NamespaceKeyClass;
}

export type ResolveHumanRecoveryIssuerV2 = (
  context: HumanRecoveryIssuerContextV2,
) => Uint8Array | null;

export interface PublishHumanRecoveryArchiveInputV2 {
  readonly crypto: LatticeCrypto;
  readonly humanId: HumanId;
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: RecoveryKeyGeneration;
  readonly recoveryPublicKey: Uint8Array;
  readonly resolveTrustedCurrentRecoveryKey:
    ResolveTrustedCurrentRecoveryKeyV2;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly createdAt: UnixTimestamp;
  readonly sources: readonly HumanRecoveryKeyringSourceV2[];
  readonly issuerSigningPrivateKey: Uint8Array;
  readonly resolveIssuerDevice: ResolveHumanRecoveryIssuerV2;
}

export interface PublishedHumanRecoveryArchiveV2 {
  readonly archive: HumanRecoveryArchiveV2;
  readonly archiveBytes: Uint8Array;
}

interface PublishedHumanRecoveryArchiveSnapshotV2 {
  readonly archiveBytes: Uint8Array;
}

const publishedHumanRecoveryArchives =
  new WeakMap<object, PublishedHumanRecoveryArchiveSnapshotV2>();

export interface HumanRecoveryArchivePersistenceStorageV2 {
  getRecoveryArchive(
    humanId: string,
  ): Promise<RecoveryArchiveWireRecordV2 | null>;
  compareAndSwapRecoveryArchive(
    expected: RecoveryArchiveStorageExpectationV2 | null,
    intended: OpaqueRecoveryPackageRecordV2,
  ): Promise<RecoveryArchiveCasStatusV2>;
}

export class HumanRecoveryArchivePersistenceOutcomeUnknownV2 extends Error {
  override readonly name =
    "HumanRecoveryArchivePersistenceOutcomeUnknownV2";

  constructor(cause: unknown) {
    super(
      "Human recovery archive storage outcome is ambiguous; retry must be explicit",
      { cause },
    );
  }
}

export interface OpenHumanRecoveryArchiveInputV2 {
  readonly crypto: LatticeCrypto;
  readonly archiveBytes: Uint8Array;
  readonly humanId: HumanId;
  readonly currentRecoveryKeyId: string;
  readonly currentRecoveryGeneration: RecoveryKeyGeneration;
  readonly recoveryPrivateKey: Uint8Array;
  readonly resolveTrustedCurrentRecoveryKey:
    ResolveTrustedCurrentRecoveryKeyV2;
  readonly expectedInventory: readonly HumanRecoveryInventoryItemV2[];
  readonly resolveIssuerDevice: ResolveHumanRecoveryIssuerV2;
}

interface NormalizedInventoryItem {
  readonly trustedNamespaceHead: VerifiedNamespaceBindingHeadV2;
  readonly keyClass: NamespaceKeyClass;
}

interface PublicationPlanItem extends NormalizedInventoryItem {
  readonly metadata: NamespaceRecoveryPackageMetadataV2;
  readonly plaintext: Uint8Array;
  readonly predictedCiphertextBytes: number;
}

interface OpenedHumanRecoveryArchiveSnapshotV2 {
  readonly archiveDigest: Uint8Array;
  readonly keyringDigests: readonly Uint8Array[];
}

const openedHumanRecoveryArchives =
  new WeakMap<
    readonly NamespaceKeyringPlaintextV2[],
    OpenedHumanRecoveryArchiveSnapshotV2
  >();

function keyringCapabilityDigest(
  keyring: NamespaceKeyringPlaintextV2,
): Uint8Array {
  const encoded = encodeNamespaceKeyring(keyring);
  try {
    return sha256(encoded);
  } finally {
    encoded.fill(0);
  }
}

function openedArchiveSnapshot(
  keyrings: readonly NamespaceKeyringPlaintextV2[],
  archiveDigest: Uint8Array,
): OpenedHumanRecoveryArchiveSnapshotV2 {
  return Object.freeze({
    archiveDigest: copyOwnedBytesV2(archiveDigest),
    keyringDigests: Object.freeze(
      keyrings.map((keyring) => keyringCapabilityDigest(keyring)),
    ),
  });
}

function openedArchiveMatchesSnapshot(
  keyrings: readonly NamespaceKeyringPlaintextV2[],
  snapshot: OpenedHumanRecoveryArchiveSnapshotV2,
): boolean {
  if (
    keyrings.length !== snapshot.keyringDigests.length
    || !Array.isArray(keyrings as unknown)
  ) {
    return false;
  }
  try {
    for (let index = 0; index < keyrings.length; index++) {
      const digest = keyringCapabilityDigest(keyrings[index]!);
      try {
        if (!equalBytes(digest, snapshot.keyringDigests[index]!)) {
          return false;
        }
      } finally {
        digest.fill(0);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function assertOpenedHumanRecoveryArchiveV2(
  value: readonly NamespaceKeyringPlaintextV2[],
  expectedArchiveDigest: Uint8Array,
): void {
  const snapshot = openedHumanRecoveryArchives.get(value);
  if (
    !(expectedArchiveDigest instanceof Uint8Array)
    || snapshot === undefined
    || !equalBytes(snapshot.archiveDigest, expectedArchiveDigest)
    || !openedArchiveMatchesSnapshot(value, snapshot)
  ) {
    throw new TypeError(
      "Recovery readiness requires the exact successfully opened archive capability",
    );
  }
}

function resolveTrustedRecoveryKey(
  resolver: ResolveTrustedCurrentRecoveryKeyV2,
  human: HumanId,
): TrustedCurrentRecoveryKeyV2 {
  const record = resolver(human);
  if (record === null) {
    throw new Error(
      "Trusted current recovery-key record is required for the Human",
    );
  }
  assertTrustedCurrentRecoveryKey(record);
  if (record.humanId !== human) {
    throw new Error(
      "Trusted current recovery-key record belongs to another Human",
    );
  }
  return Object.freeze({
    ...record,
    publicKeyDigest: record.publicKeyDigest,
  });
}

function assertKeyClass(
  value: unknown,
): asserts value is NamespaceKeyClass {
  if (value !== "human" && value !== "ai") {
    throw new TypeError("Human recovery supports only human and ai key classes");
  }
}

function currentGenerationForClass(
  head: VerifiedNamespaceBindingHeadV2,
  keyClass: NamespaceKeyClass,
): number {
  return keyClass === "human"
    ? head.binding.humanCurrentGeneration
    : head.binding.aiCurrentGeneration;
}

function keyringEnvelopeHashForClass(
  head: VerifiedNamespaceBindingHeadV2,
  keyClass: NamespaceKeyClass,
): Uint8Array {
  return keyClass === "human"
    ? head.binding.humanKeyringEnvelopeHash
    : head.binding.aiKeyringEnvelopeHash;
}

function assertCompleteRetainedHistory(
  keyring: NamespaceKeyringPlaintextV2,
): void {
  assertCanonicalNamespaceKeyring(keyring);
  if (keyring.generations[0]!.generation !== 0) {
    throw new Error(
      "Recovery keyring retained history must start at generation 0",
    );
  }
  for (let index = 0; index < keyring.generations.length; index++) {
    if (keyring.generations[index]!.generation !== index) {
      throw new Error(
        "Recovery keyring retained history must be contiguous through current generation",
      );
    }
  }
}

function compareInventory(
  left: NormalizedInventoryItem,
  right: NormalizedInventoryItem,
): number {
  const namespaceOrder = compareUnsignedUtf8(
    left.trustedNamespaceHead.namespaceId,
    right.trustedNamespaceHead.namespaceId,
  );
  if (namespaceOrder !== 0) return namespaceOrder;
  return compareUnsignedUtf8(left.keyClass, right.keyClass);
}

function normalizeInventory<T extends HumanRecoveryInventoryItemV2>(
  input: readonly T[],
  allowedFields: readonly string[],
): readonly (T & NormalizedInventoryItem)[] {
  if (!Array.isArray(input as unknown)) {
    throw new TypeError("Human recovery inventory must be an array");
  }
  assertV2Limit(
    "Human recovery package count",
    input.length,
    V2_LIMITS.recoveryPackages,
  );
  const normalized = input.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new TypeError("Human recovery inventory item must be an object");
    }
    assertExactFields("Human recovery inventory item", item, allowedFields);
    humanId(item.authorizedHumanId);
    assertKeyClass(item.keyClass);
    assertExactTrustedNamespaceHeadV2(
      item.trustedNamespaceHead,
      "Human recovery trusted Namespace head",
    );
    return item as T & NormalizedInventoryItem;
  }).sort(compareInventory);
  for (let index = 1; index < normalized.length; index++) {
    if (compareInventory(normalized[index - 1]!, normalized[index]!) === 0) {
      throw new Error(
        "Human recovery inventory contains a duplicate Namespace/key class",
      );
    }
  }
  assertConsistentCurrentDomainEpochsV2(
    normalized,
    "Human recovery inventory",
  );
  return Object.freeze(normalized);
}

function preflightPublicationSources(
  sources: readonly HumanRecoveryKeyringSourceV2[],
  human: HumanId,
): void {
  const normalized = normalizeInventory(sources, RECOVERY_SOURCE_FIELDS);
  for (const source of normalized) {
    if (source.authorizedHumanId !== human) {
      throw new Error(
        "Recovery publication inventory does not authorize the target Human",
      );
    }
    assertBytes(
      "Recovery publication current Domain root",
      source.currentDomainRoot,
      32,
    );
    if (
      typeof source.currentKeyringEnvelope !== "object"
      || source.currentKeyringEnvelope === null
    ) {
      throw new TypeError(
        "Recovery publication current keyring envelope must be an object",
      );
    }
    const envelopeHash = namespaceKeyringEnvelopeHash(
      source.currentKeyringEnvelope,
    );
    if (
      !equalBytes(
        envelopeHash,
        keyringEnvelopeHashForClass(
          source.trustedNamespaceHead,
          source.keyClass,
        ),
      )
    ) {
      throw new Error(
        "Recovery publication current keyring envelope does not match the trusted Namespace binding",
      );
    }
    if (typeof source.resolveHistoricalCommitter !== "function") {
      throw new TypeError(
        "Recovery publication historical committer resolver is required",
      );
    }
  }
}

function archiveFixedWireBytes(input: {
  readonly humanId: HumanId;
  readonly recoveryKeyId: string;
  readonly recoveryGeneration: RecoveryKeyGeneration;
  readonly recoveryPublicKeyDigest: Uint8Array;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly createdAt: UnixTimestamp;
}): number {
  return serializeHumanRecoveryArchive({
    formatVersion: HUMAN_RECOVERY_FORMAT_VERSION,
    humanId: input.humanId,
    recoveryKeyId: input.recoveryKeyId,
    recoveryGeneration: input.recoveryGeneration,
    recoveryPublicKeyDigest: input.recoveryPublicKeyDigest,
    issuerDeviceId: input.issuerDeviceId,
    createdAt: input.createdAt,
    packages: [],
    signature: new Uint8Array(V2_LIMITS.signatureBytes),
  }).length;
}

export function assertHumanRecoveryArchiveAggregateBytesV2(
  value: number,
): number {
  return assertV2Limit(
    "Human recovery archive aggregate bytes",
    value,
    V2_LIMITS.recoveryArchiveBytes,
  );
}

function issuerContext(
  purpose: HumanRecoveryIssuerContextV2["purpose"],
  human: HumanId,
  issuer: CryptoDeviceId,
  createdAt: UnixTimestamp,
  item?: NormalizedInventoryItem,
): HumanRecoveryIssuerContextV2 {
  return Object.freeze({
    purpose,
    humanId: human,
    issuerDeviceId: issuer,
    createdAt,
    ...(item === undefined
      ? {}
      : {
        namespaceId: item.trustedNamespaceHead.namespaceId,
        keyClass: item.keyClass,
      }),
  });
}

function issuerProofBytes(
  human: HumanId,
  issuer: CryptoDeviceId,
  createdAt: UnixTimestamp,
): Uint8Array {
  return concatV2(
    frameText(ISSUER_PROOF_DOMAIN),
    frameText(human),
    frameText(issuer),
    frameText(String(createdAt)),
  );
}

function resolveIssuerPublicKey(
  resolver: ResolveHumanRecoveryIssuerV2,
  context: HumanRecoveryIssuerContextV2,
): Uint8Array {
  const publicKey = resolver(context);
  if (publicKey === null) {
    throw new Error(
      `Human recovery issuer ${context.issuerDeviceId} is not authorized`,
    );
  }
  assertBytes(
    "Human recovery issuer signing public key",
    publicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  return publicKey;
}

function cloneKeyring(
  keyring: NamespaceKeyringPlaintextV2,
): NamespaceKeyringPlaintextV2 {
  return Object.freeze({
    ...keyring,
    generations: Object.freeze(
      keyring.generations.map((entry) =>
        Object.freeze({
          generation: entry.generation,
          key: copyOwnedBytesV2(entry.key),
        })
      ),
    ),
  });
}

function preflightPublication(
  input: PublishHumanRecoveryArchiveInputV2,
  human: HumanId,
  issuer: CryptoDeviceId,
  createdAt: UnixTimestamp,
  recoveryKeyDigest: Uint8Array,
): readonly PublicationPlanItem[] {
  const sources = normalizeInventory(input.sources, RECOVERY_SOURCE_FIELDS);
  let totalWireBytes = archiveFixedWireBytes({
    humanId: human,
    recoveryKeyId: input.recoveryKeyId,
    recoveryGeneration: input.recoveryGeneration,
    recoveryPublicKeyDigest: recoveryKeyDigest,
    issuerDeviceId: issuer,
    createdAt,
  });
  const plan: PublicationPlanItem[] = [];
  try {
    for (const source of sources) {
      let keyring: NamespaceKeyringPlaintextV2 | null = null;
      let keyringBytes: Uint8Array | null = null;
      let framedKeyring: Uint8Array | null = null;
      let plaintext: Uint8Array | null = null;
      try {
        const head = source.trustedNamespaceHead;
        keyring = openNamespaceKeyring({
          crypto: input.crypto,
          domainRoot: source.currentDomainRoot,
          envelope: source.currentKeyringEnvelope,
          resolveHistoricalCommitter: source.resolveHistoricalCommitter,
        });
        assertCompleteRetainedHistory(keyring);
        const metadata: NamespaceRecoveryPackageMetadataV2 = {
          formatVersion: HUMAN_RECOVERY_FORMAT_VERSION,
          humanId: human,
          recoveryKeyId: input.recoveryKeyId,
          recoveryGeneration: input.recoveryGeneration,
          recoveryPublicKeyDigest: recoveryKeyDigest,
          namespaceId: head.namespaceId,
          keyClass: source.keyClass,
          accessRevision: head.accessRevision,
          currentGeneration: keyring.currentGeneration,
          bindingHash: copyOwnedBytesV2(head.bindingHash),
          issuerDeviceId: issuer,
          createdAt,
        };
        const aad = namespaceRecoveryPackageAad(metadata);
        keyringBytes = encodeNamespaceKeyring(keyring);
        framedKeyring = frame(keyringBytes);
        plaintext = concatV2(frame(aad), framedKeyring);
        const ciphertextBytes = predictedHpkeCiphertextBytes(plaintext.length);
        const packageWireBytes = frame(serializeNamespaceRecoveryPackage({
          ...metadata,
          ciphertext: new Uint8Array(ciphertextBytes),
          signature: new Uint8Array(V2_LIMITS.signatureBytes),
        })).length;
        totalWireBytes += packageWireBytes;
        assertHumanRecoveryArchiveAggregateBytesV2(totalWireBytes);
        plan.push({
          trustedNamespaceHead: head,
          keyClass: source.keyClass,
          metadata,
          plaintext,
          predictedCiphertextBytes: ciphertextBytes,
        });
        plaintext = null;
      } finally {
        keyring?.generations.forEach((entry) => entry.key.fill(0));
        keyringBytes?.fill(0);
        framedKeyring?.fill(0);
        plaintext?.fill(0);
      }
    }
    return Object.freeze(plan);
  } catch (error) {
    plan.forEach((item) => item.plaintext.fill(0));
    throw error;
  }
}

export async function publishHumanRecoveryArchiveV2(
  input: PublishHumanRecoveryArchiveInputV2,
): Promise<PublishedHumanRecoveryArchiveV2> {
  const targetHuman = humanId(input.humanId);
  assertPortableId("Recovery key id", input.recoveryKeyId);
  const targetRecoveryGeneration = recoveryKeyGeneration(
    input.recoveryGeneration,
  );
  const issuer = cryptoDeviceId(input.issuerDeviceId);
  const createdAt = unixTimestamp(input.createdAt);
  assertBytes(
    "Recovery public key",
    input.recoveryPublicKey,
    V2_LIMITS.hpkePublicKeyBytes,
  );
  assertBytes(
    "Recovery issuer signing private key",
    input.issuerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const recoveryPublicKey = copyOwnedBytesV2(input.recoveryPublicKey);
  const issuerSigningPrivateKey = copyOwnedBytesV2(
    input.issuerSigningPrivateKey,
  );
  try {
    preflightPublicationSources(input.sources, targetHuman);
    const candidateRecoveryKeyDigest = recoveryPublicKeyDigest(
      recoveryPublicKey,
    );
    const trustedRecoveryKey = resolveTrustedRecoveryKey(
      input.resolveTrustedCurrentRecoveryKey,
      targetHuman,
    );
    if (
      trustedRecoveryKey.recoveryKeyId !== input.recoveryKeyId
      || trustedRecoveryKey.recoveryGeneration !== targetRecoveryGeneration
      || !equalBytes(
        trustedRecoveryKey.publicKeyDigest,
        candidateRecoveryKeyDigest,
      )
    ) {
      throw new Error(
        "Recovery publication recipient is not the trusted current recovery key",
      );
    }
    // Every count, keyring, ciphertext, and aggregate-byte check precedes HPKE.
    const plan = preflightPublication(
      input,
      targetHuman,
      issuer,
      createdAt,
      candidateRecoveryKeyDigest,
    );
    try {
      const issuerPublicKey = resolveIssuerPublicKey(
        input.resolveIssuerDevice,
        issuerContext(
          "human-recovery-archive",
          targetHuman,
          issuer,
          createdAt,
        ),
      );
      const proof = issuerProofBytes(targetHuman, issuer, createdAt);
      const proofSignature = input.crypto.sign(
        issuerSigningPrivateKey,
        proof,
      );
      if (!input.crypto.verify(issuerPublicKey, proof, proofSignature)) {
        throw new Error(
          "Recovery issuer private key does not match the authorized device",
        );
      }

      const packages: NamespaceRecoveryPackageV2[] = [];
      for (const item of plan) {
        const ciphertext = await input.crypto.sealTo(
          recoveryPublicKey,
          item.plaintext,
        );
        if (ciphertext.length !== item.predictedCiphertextBytes) {
          throw new Error("Recovery HPKE ciphertext length is noncanonical");
        }
        const unsigned: NamespaceRecoveryPackageV2 = {
          ...item.metadata,
          ciphertext,
          signature: new Uint8Array(V2_LIMITS.signatureBytes),
        };
        const signature = input.crypto.sign(
          issuerSigningPrivateKey,
          namespaceRecoveryPackageSigningBytes(unsigned),
        );
        packages.push(Object.freeze({
          ...unsigned,
          ciphertext: copyOwnedBytesV2(unsigned.ciphertext),
          signature: copyOwnedBytesV2(signature),
        }));
      }
      const unsignedArchive: HumanRecoveryArchiveV2 = {
        formatVersion: HUMAN_RECOVERY_FORMAT_VERSION,
        humanId: targetHuman,
        recoveryKeyId: input.recoveryKeyId,
        recoveryGeneration: targetRecoveryGeneration,
        recoveryPublicKeyDigest: candidateRecoveryKeyDigest,
        issuerDeviceId: issuer,
        createdAt,
        packages: Object.freeze(packages),
        signature: new Uint8Array(V2_LIMITS.signatureBytes),
      };
      const archive: HumanRecoveryArchiveV2 = Object.freeze({
        ...unsignedArchive,
        signature: copyOwnedBytesV2(
          input.crypto.sign(
            issuerSigningPrivateKey,
            humanRecoveryArchiveSigningBytes(unsignedArchive),
          ),
        ),
      });
      assertCanonicalHumanRecoveryArchive(archive);
      const archiveBytes = serializeHumanRecoveryArchive(archive);
      const published = Object.freeze({
        archive,
        archiveBytes,
      });
      publishedHumanRecoveryArchives.set(published, Object.freeze({
        archiveBytes: copyOwnedBytesV2(archiveBytes),
      }));
      return published;
    } finally {
      for (const item of plan) item.plaintext.fill(0);
    }
  } finally {
    recoveryPublicKey.fill(0);
    issuerSigningPrivateKey.fill(0);
  }
}

function assertAuthenticPublishedHumanRecoveryArchive(
  published: PublishedHumanRecoveryArchiveV2,
): Readonly<{
  readonly archive: HumanRecoveryArchiveV2;
  readonly archiveBytes: Uint8Array;
}> {
  assertExactFields("Human recovery archive publication", published, [
    "archive",
    "archiveBytes",
  ]);
  const snapshot = publishedHumanRecoveryArchives.get(published);
  if (
    snapshot === undefined
    || !(published.archiveBytes instanceof Uint8Array)
    || !equalBytes(published.archiveBytes, snapshot.archiveBytes)
  ) {
    throw new Error(
      "Human recovery archive publication is untrusted or mutated",
    );
  }
  try {
    const currentArchiveBytes =
      serializeHumanRecoveryArchive(published.archive);
    if (!equalBytes(currentArchiveBytes, snapshot.archiveBytes)) {
      throw new Error("mutated");
    }
    const archive = decodeHumanRecoveryArchive(snapshot.archiveBytes);
    const canonicalBytes = serializeHumanRecoveryArchive(archive);
    if (!equalBytes(canonicalBytes, snapshot.archiveBytes)) {
      throw new Error("noncanonical");
    }
    return Object.freeze({
      archive,
      archiveBytes: copyOwnedBytesV2(snapshot.archiveBytes),
    });
  } catch {
    throw new Error(
      "Human recovery archive publication is untrusted or mutated",
    );
  }
}

function canonicalRecoveryArchiveWire(
  wire: RecoveryArchiveWireRecordV2,
): Readonly<{
  readonly humanId: HumanId;
  readonly recoveryKeyGeneration: RecoveryKeyGeneration;
  readonly archiveBytes: Uint8Array;
}> {
  assertExactFields("Stored Human recovery archive", wire, [
    "humanId",
    "recoveryKeyGeneration",
    "archiveBytes",
  ]);
  const outerHumanId = humanId(wire.humanId);
  const outerGeneration = recoveryKeyGeneration(
    wire.recoveryKeyGeneration,
  );
  if (!(wire.archiveBytes instanceof Uint8Array)) {
    throw new TypeError("Stored Human recovery archive must be bytes");
  }
  const canonical = recoveryArchiveWriteRecordV2(wire.archiveBytes);
  if (
    canonical.humanId !== outerHumanId
    || canonical.recoveryKeyGeneration !== outerGeneration
  ) {
    throw new Error(
      "Stored Human recovery archive coordinates do not match its canonical bytes",
    );
  }
  return Object.freeze({
    humanId: outerHumanId,
    recoveryKeyGeneration: outerGeneration,
    archiveBytes: copyOwnedBytesV2(canonical.archiveBytes.ciphertext),
  });
}

function assertFreshRecoveryArchiveAuthorization(
  input: {
    readonly crypto: LatticeCrypto;
    readonly resolveTrustedCurrentRecoveryKey:
      ResolveTrustedCurrentRecoveryKeyV2;
    readonly resolveIssuerDevice: ResolveHumanRecoveryIssuerV2;
  },
  archive: HumanRecoveryArchiveV2,
): void {
  const trusted = resolveTrustedRecoveryKey(
    input.resolveTrustedCurrentRecoveryKey,
    archive.humanId,
  );
  if (
    trusted.recoveryKeyId !== archive.recoveryKeyId
    || trusted.recoveryGeneration !== archive.recoveryGeneration
    || !equalBytes(
      trusted.publicKeyDigest,
      archive.recoveryPublicKeyDigest,
    )
  ) {
    throw new Error(
      "Human recovery archive does not match the trusted current recovery key",
    );
  }
  const issuerPublicKey = input.resolveIssuerDevice(issuerContext(
    "human-recovery-archive",
    archive.humanId,
    archive.issuerDeviceId,
    archive.createdAt,
  ));
  if (issuerPublicKey === null) {
    throw new Error(
      "Human recovery archive issuer is not currently authorized",
    );
  }
  assertBytes(
    "Human recovery archive issuer signing public key",
    issuerPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  if (
    !input.crypto.verify(
      issuerPublicKey,
      humanRecoveryArchiveSigningBytes(archive),
      archive.signature,
    )
  ) {
    throw new Error(
      "Human recovery archive signature is invalid for the current issuer",
    );
  }
}

/**
 * Persist only the exact result of a successful local publication. The host's
 * current recovery-key and issuer authorization are resolved again after the
 * durable read and immediately before the single CAS attempt.
 */
export async function persistPublishedHumanRecoveryArchiveV2(input: {
  readonly crypto: LatticeCrypto;
  readonly storage: HumanRecoveryArchivePersistenceStorageV2;
  readonly prepared: PublishedHumanRecoveryArchiveV2;
  readonly resolveTrustedCurrentRecoveryKey:
    ResolveTrustedCurrentRecoveryKeyV2;
  readonly resolveIssuerDevice: ResolveHumanRecoveryIssuerV2;
}): Promise<RecoveryArchiveCasStatusV2> {
  assertExactFields("Human recovery archive persistence input", input, [
    "crypto",
    "storage",
    "prepared",
    "resolveTrustedCurrentRecoveryKey",
    "resolveIssuerDevice",
  ]);
  if (typeof input.resolveTrustedCurrentRecoveryKey !== "function") {
    throw new TypeError(
      "Trusted current recovery-key resolver is required",
    );
  }
  if (typeof input.resolveIssuerDevice !== "function") {
    throw new TypeError(
      "Current Human recovery issuer resolver is required",
    );
  }
  const prepared = assertAuthenticPublishedHumanRecoveryArchive(
    input.prepared,
  );
  const intended = recoveryArchiveWriteRecordV2(prepared.archiveBytes);
  const currentWire = await input.storage.getRecoveryArchive(
    prepared.archive.humanId,
  );
  const current = currentWire === null
    ? null
    : canonicalRecoveryArchiveWire(currentWire);

  if (
    current !== null
    && current.recoveryKeyGeneration
      === prepared.archive.recoveryGeneration
  ) {
    const status = equalBytes(current.archiveBytes, prepared.archiveBytes)
      ? "duplicate"
      : "stale";
    assertFreshRecoveryArchiveAuthorization(input, prepared.archive);
    return status;
  }
  let expected: RecoveryArchiveStorageExpectationV2 | null;
  if (current === null) {
    if (prepared.archive.recoveryGeneration !== 1) {
      assertFreshRecoveryArchiveAuthorization(input, prepared.archive);
      return "stale";
    }
    expected = null;
  } else {
    if (
      prepared.archive.recoveryGeneration
        !== current.recoveryKeyGeneration + 1
    ) {
      assertFreshRecoveryArchiveAuthorization(input, prepared.archive);
      return "stale";
    }
    expected = Object.freeze({
      humanId: current.humanId,
      recoveryKeyGeneration: current.recoveryKeyGeneration,
      archiveHash: sha256(current.archiveBytes),
    });
  }
  // Keep this synchronous check adjacent to the CAS: a recovery-key rotation
  // or issuer revocation after publication cannot authorize a write.
  assertFreshRecoveryArchiveAuthorization(input, prepared.archive);
  let status: RecoveryArchiveCasStatusV2;
  try {
    status = await input.storage.compareAndSwapRecoveryArchive(
      expected,
      intended,
    );
  } catch (cause) {
    throw new HumanRecoveryArchivePersistenceOutcomeUnknownV2(cause);
  }
  if (
    status !== "applied"
    && status !== "duplicate"
    && status !== "stale"
  ) {
    throw new TypeError(
      "Human recovery archive storage returned an invalid CAS status",
    );
  }
  return status;
}

function assertPackageMatchesInventory(
  item: NamespaceRecoveryPackageV2,
  expected: NormalizedInventoryItem,
): void {
  const head = expected.trustedNamespaceHead;
  if (
    item.namespaceId !== head.namespaceId
    || item.keyClass !== expected.keyClass
  ) {
    throw new Error(
      "Recovery archive Namespace/key-class inventory is unauthorized",
    );
  }
  if (
    item.accessRevision !== head.accessRevision
    || item.currentGeneration
      !== currentGenerationForClass(head, expected.keyClass)
    || !equalBytes(item.bindingHash, head.bindingHash)
  ) {
    throw new Error(
      "Recovery package does not match the authorized binding anchor",
    );
  }
}

function verifyArchiveAndPackageSignatures(
  input: OpenHumanRecoveryArchiveInputV2,
  archive: HumanRecoveryArchiveV2,
  inventory: readonly NormalizedInventoryItem[],
): void {
  const archivePublicKey = resolveIssuerPublicKey(
    input.resolveIssuerDevice,
    issuerContext(
      "human-recovery-archive",
      archive.humanId,
      archive.issuerDeviceId,
      archive.createdAt,
    ),
  );
  if (
    !input.crypto.verify(
      archivePublicKey,
      humanRecoveryArchiveSigningBytes(archive),
      archive.signature,
    )
  ) {
    throw new Error("Human recovery archive signature is invalid");
  }
  for (let index = 0; index < archive.packages.length; index++) {
    const item = archive.packages[index]!;
    const expected = inventory[index]!;
    const publicKey = resolveIssuerPublicKey(
      input.resolveIssuerDevice,
      issuerContext(
        "namespace-recovery-package",
        item.humanId,
        item.issuerDeviceId,
        item.createdAt,
        expected,
      ),
    );
    if (
      !input.crypto.verify(
        publicKey,
        namespaceRecoveryPackageSigningBytes(item),
        item.signature,
      )
    ) {
      throw new Error("Namespace recovery package signature is invalid");
    }
  }
}

function decodeRecoveryPlaintext(
  plaintext: Uint8Array,
  item: NamespaceRecoveryPackageV2,
): NamespaceKeyringPlaintextV2 {
  let decoded: NamespaceKeyringPlaintextV2 | null = null;
  try {
    decoded = decodeExact(plaintext, (reader) => {
      const embeddedAad = reader.readFrame(MAX_PACKAGE_AAD_BYTES);
      const expectedAad = namespaceRecoveryPackageAad(item);
      if (!equalBytes(embeddedAad, expectedAad)) {
        throw new Error(
          "Recovery package embedded metadata/AAD does not match its outer metadata",
        );
      }
      const keyringBytes = reader.readFrame(
        V2_LIMITS.namespaceKeyringBytes,
      );
      try {
        return decodeNamespaceKeyring(keyringBytes);
      } finally {
        keyringBytes.fill(0);
      }
    });
    if (
      decoded.namespaceId !== item.namespaceId
      || decoded.keyClass !== item.keyClass
      || decoded.accessRevision !== item.accessRevision
      || decoded.currentGeneration !== item.currentGeneration
    ) {
      throw new Error(
        "Recovery package inner and outer keyring metadata do not match",
      );
    }
    assertCompleteRetainedHistory(decoded);
    return decoded;
  } catch (error) {
    decoded?.generations.forEach((entry) => entry.key.fill(0));
    throw error;
  }
}

export async function openHumanRecoveryArchiveV2(
  input: OpenHumanRecoveryArchiveInputV2,
): Promise<readonly NamespaceKeyringPlaintextV2[]> {
  if (!(input.archiveBytes instanceof Uint8Array)) {
    throw new TypeError("Recovery archive bytes must be bytes");
  }
  const archiveBytes = input.archiveBytes;
  if (archiveBytes.length > V2_LIMITS.recoveryArchiveBytes) {
    throw new CanonicalDecodingError(
      "Recovery archive exceeds the 64 MiB aggregate-byte limit",
    );
  }
  const archiveDigest = sha256(archiveBytes);
  assertBytes(
    "Recovery private key",
    input.recoveryPrivateKey,
    V2_LIMITS.hpkePrivateKeyBytes,
  );
  const recoveryPrivateKey = copyOwnedBytesV2(
    input.recoveryPrivateKey,
  );
  try {
  const expectedHuman = humanId(input.humanId);
  assertPortableId("Current recovery key id", input.currentRecoveryKeyId);
  const expectedRecoveryGeneration = recoveryKeyGeneration(
    input.currentRecoveryGeneration,
  );
  const archive = decodeHumanRecoveryArchive(archiveBytes);
  if (archive.humanId !== expectedHuman) {
    throw new Error("Recovery archive belongs to another Human");
  }
  if (
    archive.recoveryKeyId !== input.currentRecoveryKeyId
    || archive.recoveryGeneration !== expectedRecoveryGeneration
  ) {
    throw new Error(
      "Recovery archive does not target the current recovery key generation",
    );
  }
  const inventory = normalizeInventory(
    input.expectedInventory,
    RECOVERY_INVENTORY_FIELDS,
  );
  if (inventory.some((item) => item.authorizedHumanId !== expectedHuman)) {
    throw new Error(
      "Recovery restore inventory does not authorize the target Human",
    );
  }
  if (archive.packages.length !== inventory.length) {
    throw new Error(
      "Recovery archive package inventory is missing or has unauthorized extras",
    );
  }
  for (let index = 0; index < archive.packages.length; index++) {
    assertPackageMatchesInventory(archive.packages[index]!, inventory[index]!);
  }
  const trustedRecoveryKey = resolveTrustedRecoveryKey(
    input.resolveTrustedCurrentRecoveryKey,
    expectedHuman,
  );
  if (
    trustedRecoveryKey.recoveryKeyId !== input.currentRecoveryKeyId
    || trustedRecoveryKey.recoveryGeneration !== expectedRecoveryGeneration
    || !equalBytes(
      trustedRecoveryKey.publicKeyDigest,
      archive.recoveryPublicKeyDigest,
    )
  ) {
    throw new Error(
      "Recovery archive does not match the trusted current recovery key",
    );
  }
  verifyArchiveAndPackageSignatures(input, archive, inventory);

  const restored: NamespaceKeyringPlaintextV2[] = [];
  try {
    for (const item of archive.packages) {
      const plaintext = await input.crypto.openSealed(
        recoveryPrivateKey,
        item.ciphertext,
      );
      if (plaintext === null) {
        throw new Error("Namespace recovery package failed to decrypt");
      }
      let decoded: NamespaceKeyringPlaintextV2 | null = null;
      try {
        decoded = decodeRecoveryPlaintext(plaintext, item);
        restored.push(cloneKeyring(decoded));
      } finally {
        plaintext.fill(0);
        decoded?.generations.forEach((entry) => entry.key.fill(0));
      }
    }
    const opened = Object.freeze(restored);
    openedHumanRecoveryArchives.set(
      opened,
      openedArchiveSnapshot(opened, archiveDigest),
    );
    return opened;
  } catch (error) {
    restored.forEach((keyring) =>
      keyring.generations.forEach((entry) => entry.key.fill(0))
    );
    throw error;
  }
  } finally {
    recoveryPrivateKey.fill(0);
  }
}
