import {
  CLIENT_DEVICE_PROFILE_MAX_KEYRINGS,
  type OpenedClientDeviceProfileV2,
  type ClientNamespaceKeyClass,
  type RetainedClientNamespaceKeyringV2,
} from "../client-vault/profile-v2.ts";

function compareUtf8(left: string, right: string): number {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function cloneKeyring(
  keyring: RetainedClientNamespaceKeyringV2,
): RetainedClientNamespaceKeyringV2 {
  return Object.freeze({
    ...keyring,
    bindingHash: keyring.bindingHash.slice(),
    generations: Object.freeze(keyring.generations.map((entry) =>
      Object.freeze({ generation: entry.generation, key: entry.key.slice() })
    )),
  });
}

function wipeKeyring(keyring: RetainedClientNamespaceKeyringV2): void {
  keyring.bindingHash.fill(0);
  keyring.generations.forEach((entry) => entry.key.fill(0));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function equalKeyring(
  left: RetainedClientNamespaceKeyringV2,
  right: RetainedClientNamespaceKeyringV2,
): boolean {
  return left.deliverySequence === right.deliverySequence
    && left.operationId === right.operationId
    && left.namespaceId === right.namespaceId
    && left.keyClass === right.keyClass
    && left.domainId === right.domainId
    && left.domainEpoch === right.domainEpoch
    && left.accessRevision === right.accessRevision
    && equalBytes(left.bindingHash, right.bindingHash)
    && left.currentGeneration === right.currentGeneration
    && left.generations.length === right.generations.length
    && left.generations.every((entry, index) => {
      const other = right.generations[index];
      return other !== undefined
        && entry.generation === other.generation
        && equalBytes(entry.key, other.key);
    });
}

export type ClientNamespaceKeyringMaterial = Readonly<{
  namespaceId: string;
  keyClass: ClientNamespaceKeyClass;
  domainId: string;
  domainEpoch: number;
  accessRevision: number;
  bindingHash: Uint8Array;
  currentGeneration: number;
  generations: readonly Readonly<{
    generation: number;
    key: Uint8Array;
  }>[];
}>;

/**
 * Opens one retained current/historical Human or AI Namespace keyring for the
 * callback lifetime. No key buffer survives success, throw, or abort.
 */
export async function withClientNamespaceKeyring<Value>(input: {
  readonly profile: OpenedClientDeviceProfileV2;
  readonly namespaceId: string;
  readonly keyClass: ClientNamespaceKeyClass;
  readonly requiredAccessRevision?: number;
  readonly requiredGeneration?: number;
  readonly signal?: AbortSignal;
  readonly operation: (
    keyring: ClientNamespaceKeyringMaterial,
  ) => Value | PromiseLike<Value>;
}): Promise<Value> {
  if (input.signal?.aborted === true) {
    throw new Error("Client Namespace keyring operation was aborted");
  }
  const matching = input.profile.keyringDeliveries.filter((entry) =>
    entry.namespaceId === input.namespaceId
    && entry.keyClass === input.keyClass
    && (
      input.requiredAccessRevision === undefined
      || entry.accessRevision === input.requiredAccessRevision
    )
  );
  const retained = matching.reduce<RetainedClientNamespaceKeyringV2 | undefined>(
    (latest, entry) => latest === undefined
        || entry.accessRevision > latest.accessRevision
      ? entry
      : latest,
    undefined,
  );
  if (
    retained === undefined
    || (
      input.requiredGeneration !== undefined
      && !retained.generations.some((entry) =>
        entry.generation === input.requiredGeneration
      )
    )
  ) throw new Error("Client Namespace keyring is unavailable");
  const opened = cloneKeyring(retained);
  try {
    return await input.operation(opened);
  } finally {
    wipeKeyring(opened);
  }
}

/**
 * Produces a detached v2 profile candidate after a strictly forward delivery
 * update. Persistence remains the ClientProfileVault's atomic stage/activate
 * responsibility.
 */
export function writeClientNamespaceKeyrings(input: {
  readonly profile: OpenedClientDeviceProfileV2;
  readonly deliveryHighWatermark: number;
  readonly keyrings: readonly RetainedClientNamespaceKeyringV2[];
}): OpenedClientDeviceProfileV2 {
  if (
    !Number.isSafeInteger(input.deliveryHighWatermark)
    || input.deliveryHighWatermark <= input.profile.deliveryHighWatermark
    || !Array.isArray(input.keyrings as unknown)
    || input.keyrings.length < 1
  ) throw new Error("Client delivery update does not advance");
  const retained = new Map<string, RetainedClientNamespaceKeyringV2>(
    input.profile.keyringDeliveries.map((entry) =>
      [
        `${entry.namespaceId}\u0000${entry.keyClass}\u0000${entry.accessRevision}`,
        cloneKeyring(entry),
      ]
    ),
  );
  try {
    for (const candidateValue of input.keyrings) {
      const candidate = cloneKeyring(candidateValue);
      if (
        candidate.deliverySequence <= input.profile.deliveryHighWatermark
        || candidate.deliverySequence > input.deliveryHighWatermark
      ) {
        wipeKeyring(candidate);
        throw new Error("Client keyring delivery sequence is stale");
      }
      const lineage = [...retained.values()].filter((entry) =>
        entry.namespaceId === candidate.namespaceId
        && entry.keyClass === candidate.keyClass
      );
      const current = lineage.reduce<RetainedClientNamespaceKeyringV2 | undefined>(
        (latest, entry) => latest === undefined
            || entry.accessRevision > latest.accessRevision
          ? entry
          : latest,
        undefined,
      );
      if (
        current !== undefined
        && (
          candidate.accessRevision <= current.accessRevision
          || candidate.domainEpoch < current.domainEpoch
        )
      ) {
        wipeKeyring(candidate);
        throw new Error("Client Namespace keyring rollback was detected");
      }
      const key = `${candidate.namespaceId}\u0000${candidate.keyClass}`
        + `\u0000${candidate.accessRevision}`;
      retained.set(key, candidate);
    }
    if (retained.size > CLIENT_DEVICE_PROFILE_MAX_KEYRINGS) {
      throw new RangeError("Client keyring cache is full");
    }
    return Object.freeze({
      formatVersion: 2,
      deviceId: input.profile.deviceId,
      signingPublicKey: input.profile.signingPublicKey.slice(),
      signingPrivateKey: input.profile.signingPrivateKey.slice(),
      encryptionPublicKey: input.profile.encryptionPublicKey.slice(),
      encryptionPrivateKey: input.profile.encryptionPrivateKey.slice(),
      trustedDeviceRevision: input.profile.trustedDeviceRevision,
      trustedHostAuthorizationRevision:
        input.profile.trustedHostAuthorizationRevision,
      deliveryHighWatermark: input.deliveryHighWatermark,
      keyringDeliveries: Object.freeze([...retained.values()].sort(
        (left, right) =>
          compareUtf8(left.namespaceId, right.namespaceId)
          || compareUtf8(left.keyClass, right.keyClass)
          || left.accessRevision - right.accessRevision,
      )),
    });
  } catch (error) {
    retained.forEach(wipeKeyring);
    throw error;
  }
}

/**
 * Restores an exact, already-acknowledged delivery whose profile revision and
 * high-watermark survived but whose keyring cache did not. Existing lineages
 * are never replaced: an exact duplicate is a no-op and any disagreement is
 * rejected. The acknowledged high-watermark remains unchanged.
 */
export function restoreClientNamespaceKeyringsFromAcknowledgedDelivery(input: {
  readonly profile: OpenedClientDeviceProfileV2;
  readonly keyrings: readonly RetainedClientNamespaceKeyringV2[];
}): OpenedClientDeviceProfileV2 {
  if (!Array.isArray(input.keyrings as unknown) || input.keyrings.length < 1) {
    throw new Error("Acknowledged Client keyring recovery is empty");
  }
  const retained = new Map<string, RetainedClientNamespaceKeyringV2>(
    input.profile.keyringDeliveries.map((entry) => [
      `${entry.namespaceId}\u0000${entry.keyClass}\u0000${entry.accessRevision}`,
      cloneKeyring(entry),
    ]),
  );
  try {
    for (const candidateValue of input.keyrings) {
      const candidate = cloneKeyring(candidateValue);
      if (
        candidate.deliverySequence < 1
        || candidate.deliverySequence > input.profile.deliveryHighWatermark
      ) {
        wipeKeyring(candidate);
        throw new Error("Acknowledged Client keyring recovery is not durable");
      }
      const key = `${candidate.namespaceId}\u0000${candidate.keyClass}`
        + `\u0000${candidate.accessRevision}`;
      const existing = retained.get(key);
      if (existing !== undefined) {
        const exact = equalKeyring(existing, candidate);
        wipeKeyring(candidate);
        if (!exact) {
          throw new Error("Acknowledged Client keyring recovery conflicts");
        }
        continue;
      }
      const lineage = [...retained.values()].filter((entry) =>
        entry.namespaceId === candidate.namespaceId
        && entry.keyClass === candidate.keyClass
      );
      if (lineage.some((entry) =>
        entry.accessRevision >= candidate.accessRevision
        || entry.domainEpoch > candidate.domainEpoch
      )) {
        wipeKeyring(candidate);
        throw new Error("Acknowledged Client keyring recovery rolls back a lineage");
      }
      retained.set(key, candidate);
    }
    if (retained.size > CLIENT_DEVICE_PROFILE_MAX_KEYRINGS) {
      throw new RangeError("Client keyring cache is full");
    }
    return Object.freeze({
      formatVersion: 2,
      deviceId: input.profile.deviceId,
      signingPublicKey: input.profile.signingPublicKey.slice(),
      signingPrivateKey: input.profile.signingPrivateKey.slice(),
      encryptionPublicKey: input.profile.encryptionPublicKey.slice(),
      encryptionPrivateKey: input.profile.encryptionPrivateKey.slice(),
      trustedDeviceRevision: input.profile.trustedDeviceRevision,
      trustedHostAuthorizationRevision:
        input.profile.trustedHostAuthorizationRevision,
      deliveryHighWatermark: input.profile.deliveryHighWatermark,
      keyringDeliveries: Object.freeze([...retained.values()].sort(
        (left, right) =>
          compareUtf8(left.namespaceId, right.namespaceId)
          || compareUtf8(left.keyClass, right.keyClass)
          || left.accessRevision - right.accessRevision,
      )),
    });
  } catch (error) {
    retained.forEach(wipeKeyring);
    throw error;
  }
}
