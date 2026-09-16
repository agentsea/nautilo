import { sha256 } from "@noble/hashes/sha2.js";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
import { recoveryKeyGeneration } from "../format/recovery-v2.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../format/v2-primitives.ts";
import type {
  NamespaceKeyClass,
  NamespaceKeyringPlaintextV2,
  VerifiedNamespaceBindingHeadV2,
} from "../namespace/types.ts";
import {
  assertPortableId,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
  type NamespaceId,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import { assertOpenedHumanRecoveryArchiveV2 } from "./human-archive-v2.ts";
import {
  DEVICE_TRANSFER_FORMAT_VERSION,
  HASH_BYTES,
  LIVE_DOMAIN_FIELDS,
  READINESS_INVENTORY_FIELDS,
  RECOVERY_DEVICE_ACTIVATION_DOMAIN,
  RECOVERY_KEY_FIELDS,
  assertBytes,
  assertExactFields,
  currentGeneration,
  deviceTransferInventoryRevision,
  equalBytes,
  normalizeInventory,
  preflightInventoryShape,
  resolveExactInventoryCommitment,
  validatePendingCandidate,
  type DeviceTransferInventoryRevision,
  type DeviceTransferJoinIntentV2,
  type DeviceTransferPendingDeviceV2,
  type ResolveTrustedDeviceTransferInventoryCommitmentV2,
  type TrustedDeviceTransferInventoryCommitmentV2,
} from "./device-transfer-common-v2.ts";

export interface RecoveryReadinessInventoryV2 {
  readonly authorizedHumanId: HumanId;
  readonly trustedNamespaceHead: VerifiedNamespaceBindingHeadV2;
  readonly keyClass: NamespaceKeyClass;
}

export interface RecoveryLiveDomainV2 {
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly committerDeviceId: CryptoDeviceId | null;
}

export type RecoveryDeviceReadinessV2 =
  | {
    readonly kind: "missing-recovery-kit";
    readonly permanentLoss: boolean;
  }
  | {
    readonly kind: "recovery-key-rotated";
  }
  | {
    readonly kind: "unauthorized-namespace";
    readonly namespaceId: NamespaceId;
    readonly keyClass: NamespaceKeyClass;
  }
  | {
    readonly kind: "ready-for-live-join";
    readonly recoveryArchiveDigest: Uint8Array;
    readonly inventoryRevision: DeviceTransferInventoryRevision;
    readonly inventoryCount: number;
    readonly inventoryDigest: Uint8Array;
    readonly readinessDigest: Uint8Array;
    readonly joinIntents: readonly DeviceTransferJoinIntentV2[];
  }
  | {
    readonly kind: "rebootstrap-required";
    readonly recoveryArchiveDigest: Uint8Array;
    readonly inventoryRevision: DeviceTransferInventoryRevision;
    readonly inventoryCount: number;
    readonly inventoryDigest: Uint8Array;
    readonly readinessDigest: Uint8Array;
    readonly joinIntents: readonly DeviceTransferJoinIntentV2[];
    readonly rebootstrapDomains: readonly CryptoDomainId[];
  };

export type VerifiedRecoveryDeviceReadinessV2 = Extract<
  RecoveryDeviceReadinessV2,
  { readonly kind: "ready-for-live-join" | "rebootstrap-required" }
>;

interface RecoveryReadinessSnapshotV2 {
  readonly kind: VerifiedRecoveryDeviceReadinessV2["kind"];
  readonly recoveryArchiveDigest: Uint8Array;
  readonly inventoryRevision: DeviceTransferInventoryRevision;
  readonly inventoryCount: number;
  readonly inventoryDigest: Uint8Array;
  readonly readinessDigest: Uint8Array;
  readonly joinIntents: readonly DeviceTransferJoinIntentV2[];
  readonly rebootstrapDomains: readonly CryptoDomainId[] | null;
}

function cloneJoinIntent(
  intent: DeviceTransferJoinIntentV2,
): DeviceTransferJoinIntentV2 {
  return Object.freeze({
    formatVersion: intent.formatVersion,
    humanId: intent.humanId,
    targetDeviceId: intent.targetDeviceId,
    pendingDeviceRevision: intent.pendingDeviceRevision,
    domainId: intent.domainId,
    domainEpoch: intent.domainEpoch,
    committerDeviceId: intent.committerDeviceId,
  });
}

function snapshotReadiness(
  value: VerifiedRecoveryDeviceReadinessV2,
): RecoveryReadinessSnapshotV2 {
  return Object.freeze({
    kind: value.kind,
    recoveryArchiveDigest: copyOwnedBytesV2(
      value.recoveryArchiveDigest,
    ),
    inventoryRevision: value.inventoryRevision,
    inventoryCount: value.inventoryCount,
    inventoryDigest: copyOwnedBytesV2(value.inventoryDigest),
    readinessDigest: copyOwnedBytesV2(value.readinessDigest),
    joinIntents: Object.freeze(value.joinIntents.map(cloneJoinIntent)),
    rebootstrapDomains: value.kind === "rebootstrap-required"
      ? Object.freeze([...value.rebootstrapDomains])
      : null,
  });
}

function joinIntentsEqual(
  left: readonly DeviceTransferJoinIntentV2[],
  right: readonly DeviceTransferJoinIntentV2[],
): boolean {
  return (
    left.length === right.length
    && left.every((intent, index) => {
      const expected = right[index]!;
      return intent.formatVersion === expected.formatVersion
        && intent.humanId === expected.humanId
        && intent.targetDeviceId === expected.targetDeviceId
        && intent.pendingDeviceRevision === expected.pendingDeviceRevision
        && intent.domainId === expected.domainId
        && intent.domainEpoch === expected.domainEpoch
        && intent.committerDeviceId === expected.committerDeviceId;
    })
  );
}

function readinessMatchesSnapshot(
  value: VerifiedRecoveryDeviceReadinessV2,
  snapshot: RecoveryReadinessSnapshotV2,
): boolean {
  const actualRebootstrap = value.kind === "rebootstrap-required"
    ? value.rebootstrapDomains
    : null;
  return value.kind === snapshot.kind
    && value.inventoryRevision === snapshot.inventoryRevision
    && value.inventoryCount === snapshot.inventoryCount
    && equalBytes(
      value.recoveryArchiveDigest,
      snapshot.recoveryArchiveDigest,
    )
    && equalBytes(value.inventoryDigest, snapshot.inventoryDigest)
    && equalBytes(value.readinessDigest, snapshot.readinessDigest)
    && joinIntentsEqual(value.joinIntents, snapshot.joinIntents)
    && (
      actualRebootstrap === null
        ? snapshot.rebootstrapDomains === null
        : snapshot.rebootstrapDomains !== null
          && actualRebootstrap.length === snapshot.rebootstrapDomains.length
          && actualRebootstrap.every(
            (domain, index) =>
              domain === snapshot.rebootstrapDomains![index],
          )
    );
}

export function recoveryReadinessDigest(
  archiveDigest: Uint8Array,
  commitment: TrustedDeviceTransferInventoryCommitmentV2,
): Uint8Array {
  return sha256(concatV2(
    frameText(RECOVERY_DEVICE_ACTIVATION_DOMAIN),
    frameText("complete-archive-readiness"),
    frame(archiveDigest),
    frameText(commitment.humanId),
    encodeU64(commitment.inventoryRevision),
    encodeU32(commitment.inventoryCount),
    frame(commitment.inventoryDigest),
  ));
}

export interface RecoveryDeviceReadinessEvidenceV2 {
  readonly hasAuthorizedDeviceTransferSource: boolean;
  readonly recoveryCredential: {
    readonly recoveryKeyId: string;
    readonly recoveryGeneration: number;
  } | null;
  readonly archiveRecoveryKey: {
    readonly recoveryKeyId: string;
    readonly recoveryGeneration: number;
  } | null;
  readonly recoveryArchiveDigest: Uint8Array;
  readonly inventoryRevision: DeviceTransferInventoryRevision;
  readonly resolveTrustedInventoryCommitment:
    ResolveTrustedDeviceTransferInventoryCommitmentV2;
  readonly inventory: readonly RecoveryReadinessInventoryV2[];
  readonly restoredKeyrings: readonly NamespaceKeyringPlaintextV2[];
  readonly liveDomains: readonly RecoveryLiveDomainV2[];
}

export interface RecoveryDeviceReadinessAssessmentInputV2
  extends RecoveryDeviceReadinessEvidenceV2 {
  readonly pendingDevice: DeviceTransferPendingDeviceV2;
}

export function assessRecoveryDeviceReadinessV2(
  input: RecoveryDeviceReadinessAssessmentInputV2,
): RecoveryDeviceReadinessV2 {
  const pending = validatePendingCandidate(input.pendingDevice);
  if (typeof input.hasAuthorizedDeviceTransferSource !== "boolean") {
    throw new TypeError(
      "Authorized device-transfer source flag must be a boolean",
    );
  }
  if (input.recoveryCredential === null || input.archiveRecoveryKey === null) {
    return Object.freeze({
      kind: "missing-recovery-kit",
      permanentLoss: !input.hasAuthorizedDeviceTransferSource,
    });
  }
  assertExactFields(
    "Recovery credential",
    input.recoveryCredential,
    RECOVERY_KEY_FIELDS,
  );
  assertExactFields(
    "Recovery archive key",
    input.archiveRecoveryKey,
    RECOVERY_KEY_FIELDS,
  );
  assertPortableId(
    "Recovery credential key id",
    input.recoveryCredential.recoveryKeyId,
  );
  assertPortableId(
    "Recovery archive key id",
    input.archiveRecoveryKey.recoveryKeyId,
  );
  recoveryKeyGeneration(input.recoveryCredential.recoveryGeneration);
  recoveryKeyGeneration(input.archiveRecoveryKey.recoveryGeneration);
  if (
    input.recoveryCredential.recoveryKeyId
      !== input.archiveRecoveryKey.recoveryKeyId
    || input.recoveryCredential.recoveryGeneration
      !== input.archiveRecoveryKey.recoveryGeneration
  ) {
    return Object.freeze({ kind: "recovery-key-rotated" });
  }
  assertBytes(
    "Recovery readiness archive digest",
    input.recoveryArchiveDigest,
    HASH_BYTES,
  );
  preflightInventoryShape(input.inventory, READINESS_INVENTORY_FIELDS);
  assertOpenedHumanRecoveryArchiveV2(
    input.restoredKeyrings,
    input.recoveryArchiveDigest,
  );
  const inventoryRevisionValue = deviceTransferInventoryRevision(
    input.inventoryRevision,
  );
  if (!Array.isArray(input.liveDomains as unknown)) {
    throw new TypeError("Recovery readiness live Domains must be an array");
  }
  assertV2Limit(
    "Recovery readiness live Domain count",
    input.liveDomains.length,
    V2_LIMITS.recoveryPackages,
  );
  const allowed = new Map<string, RecoveryReadinessInventoryV2>();
  for (const item of input.inventory) {
    if (item.authorizedHumanId !== pending.humanId) {
      return Object.freeze({
        kind: "unauthorized-namespace",
        namespaceId: item.trustedNamespaceHead.namespaceId,
        keyClass: item.keyClass,
      });
    }
    const key =
      `${item.trustedNamespaceHead.namespaceId}\u0000${item.keyClass}`;
    if (allowed.has(key)) {
      throw new Error("Recovery readiness inventory contains a duplicate");
    }
    allowed.set(key, item);
  }
  const liveByDomain = new Map<string, RecoveryLiveDomainV2>();
  for (const item of input.liveDomains) {
    if (typeof item !== "object" || item === null) {
      throw new TypeError("Recovery readiness live Domain must be an object");
    }
    assertExactFields(
      "Recovery readiness live Domain",
      item,
      LIVE_DOMAIN_FIELDS,
    );
    cryptoDomainId(item.domainId);
    domainEpoch(item.domainEpoch);
    if (item.committerDeviceId !== null) {
      cryptoDeviceId(item.committerDeviceId);
    }
    if (liveByDomain.has(item.domainId)) {
      throw new Error("Recovery readiness live Domains contain a duplicate");
    }
    liveByDomain.set(item.domainId, item);
  }
  const normalizedInventory = normalizeInventory(
    input.inventory,
    pending.humanId,
    READINESS_INVENTORY_FIELDS,
  );
  const inventoryCommitment = resolveExactInventoryCommitment(
    pending.humanId,
    inventoryRevisionValue,
    normalizedInventory,
    input.resolveTrustedInventoryCommitment,
  );
  for (const keyring of input.restoredKeyrings) {
    const key = `${keyring.namespaceId}\u0000${keyring.keyClass}`;
    const expected = allowed.get(key);
    if (
      expected === undefined
      || keyring.accessRevision !== expected.trustedNamespaceHead.accessRevision
      || keyring.currentGeneration
        !== currentGeneration(expected.trustedNamespaceHead, keyring.keyClass)
    ) {
      return Object.freeze({
        kind: "unauthorized-namespace",
        namespaceId: keyring.namespaceId,
        keyClass: keyring.keyClass,
      });
    }
    allowed.delete(key);
  }
  if (allowed.size > 0) {
    const missing = allowed.values().next().value!;
    return Object.freeze({
      kind: "unauthorized-namespace",
      namespaceId: missing.trustedNamespaceHead.namespaceId,
      keyClass: missing.keyClass,
    });
  }
  const joins: DeviceTransferJoinIntentV2[] = [];
  const rebootstrap: CryptoDomainId[] = [];
  const domains = new Map(
    normalizedInventory.map((item) => [
      item.trustedNamespaceHead.binding.domainId,
      item.trustedNamespaceHead.binding.domainEpoch,
    ]),
  );
  if (liveByDomain.size !== domains.size) {
    throw new Error(
      "Recovery readiness requires an exact live Domain inventory",
    );
  }
  for (
    const [domainIdValue, expectedEpoch] of [...domains.entries()].sort(
      ([left], [right]) => compareUnsignedUtf8(left, right),
    )
  ) {
    const live = liveByDomain.get(domainIdValue);
    if (live === undefined) {
      throw new Error(
        "Recovery readiness requires an exact live Domain inventory",
      );
    }
    if (live.domainEpoch !== expectedEpoch) {
      throw new Error(
        "Recovery readiness live Domain epoch is stale or inconsistent",
      );
    }
    if (live.committerDeviceId === null) {
      rebootstrap.push(cryptoDomainId(domainIdValue));
      continue;
    }
    joins.push(Object.freeze({
      formatVersion: DEVICE_TRANSFER_FORMAT_VERSION,
      humanId: pending.humanId,
      targetDeviceId: pending.deviceId,
      pendingDeviceRevision: pending.pendingDeviceRevision,
      domainId: live.domainId,
      domainEpoch: live.domainEpoch,
      committerDeviceId: live.committerDeviceId,
    }));
  }
  if (rebootstrap.length > 0) {
    const result = Object.freeze({
      kind: "rebootstrap-required",
      recoveryArchiveDigest: copyOwnedBytesV2(
        input.recoveryArchiveDigest,
      ),
      inventoryRevision: inventoryCommitment.inventoryRevision,
      inventoryCount: inventoryCommitment.inventoryCount,
      inventoryDigest: copyOwnedBytesV2(
        inventoryCommitment.inventoryDigest,
      ),
      readinessDigest: recoveryReadinessDigest(
        input.recoveryArchiveDigest,
        inventoryCommitment,
      ),
      joinIntents: Object.freeze(joins),
      rebootstrapDomains: Object.freeze(rebootstrap),
    } as const);
    return result;
  }
  const result = Object.freeze({
    kind: "ready-for-live-join",
    recoveryArchiveDigest: copyOwnedBytesV2(
      input.recoveryArchiveDigest,
    ),
    inventoryRevision: inventoryCommitment.inventoryRevision,
    inventoryCount: inventoryCommitment.inventoryCount,
    inventoryDigest: copyOwnedBytesV2(
      inventoryCommitment.inventoryDigest,
    ),
    readinessDigest: recoveryReadinessDigest(
      input.recoveryArchiveDigest,
      inventoryCommitment,
    ),
    joinIntents: Object.freeze(joins),
  } as const);
  return result;
}

/**
 * Reconstruct a successful readiness result from fresh trusted evidence.
 *
 * The claimed value is intentionally not a nominal process-local capability:
 * detached or decoded values are accepted when every field matches the result
 * independently reconstructed from the canonical archive inventory, its
 * current trust anchors, and the freshly opened local archive keyrings.
 */
export function verifyRecoveryDeviceReadinessV2(input: {
  readonly readiness: RecoveryDeviceReadinessV2;
  readonly evidence: RecoveryDeviceReadinessAssessmentInputV2;
}): VerifiedRecoveryDeviceReadinessV2 {
  const reconstructed = assessRecoveryDeviceReadinessV2(input.evidence);
  if (
    (
      reconstructed.kind !== "ready-for-live-join"
      && reconstructed.kind !== "rebootstrap-required"
    )
    || (
      input.readiness.kind !== "ready-for-live-join"
      && input.readiness.kind !== "rebootstrap-required"
    )
    || !readinessMatchesSnapshot(
      input.readiness,
      snapshotReadiness(reconstructed),
    )
  ) {
    throw new TypeError(
      "Recovery activation requires authenticated complete archive readiness",
    );
  }
  return reconstructed;
}
