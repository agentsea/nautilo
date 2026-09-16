import {
  DeviceProviderStateVault,
  OpenMlsGroupProvider,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  providerHeadsEqual,
  restoreSealedProviderState,
  type HistoricalCommitterResolver,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeProviderRosterV2,
  type ProviderPublicHeadV2 as ProviderPublicHead,
} from "@nautilo/lattice-crypto/wire";

import type { OpenedClientDeviceProfileV4 } from "./profile-v4.ts";

export type SoleFoundingDeviceHistoricalCommitterUnavailableReason =
  | "provider_snapshot_unavailable"
  | "provider_head_mismatch"
  | "not_sole_founding_device";

export type SoleFoundingDeviceHistoricalCommitterResult<T> =
  | Readonly<{ status: "ready"; value: T }>
  | Readonly<{
    status: "unavailable";
    reason: SoleFoundingDeviceHistoricalCommitterUnavailableReason;
  }>;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

/**
 * Supplies the only historical committer fact a fresh live-Shadow installation
 * can prove from local custody alone: its own sole-member Domain genesis.
 * Shared or multi-device Domains remain explicitly unavailable until the
 * separately designed authenticated historical-roster delivery exists.
 */
export async function withSoleFoundingDeviceHistoricalCommitterV4<T>(
  input: Readonly<{
    crypto: LatticeCrypto;
    profile: OpenedClientDeviceProfileV4;
    humanId: string;
    expectedHead: ProviderPublicHead;
    operation(resolveHistoricalCommitter: HistoricalCommitterResolver):
      Promise<T> | T;
  }>,
): Promise<SoleFoundingDeviceHistoricalCommitterResult<T>> {
  const v3 = input.profile.baseProfile;
  const local = v3.baseProfile;
  const record = v3.activeProviderSnapshots.find(
    (candidate) => candidate.domainId === input.expectedHead.domainId,
  );
  if (record === undefined) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "provider_snapshot_unavailable" as const,
    });
  }
  const providerVault = DeviceProviderStateVault.fromKey(
    input.crypto,
    cryptoDeviceId(local.deviceId),
    v3.providerStateSealingKey,
  );
  const active = restoreSealedProviderState({
    providerId: record.providerId,
    domainId: cryptoDomainId(record.domainId),
    deviceId: cryptoDeviceId(local.deviceId),
    revision: domainEpoch(record.epoch),
    snapshotKind: "active",
    ciphertext: record.ciphertext,
  });
  const provider = new OpenMlsGroupProvider(input.crypto, providerVault);
  let rosterBytes: Uint8Array | undefined;
  let localPublicKey: Uint8Array | undefined;
  try {
    await provider.initialize();
    const actualHead = provider.publicHead(active);
    try {
      if (
        !providerHeadsEqual(actualHead, input.expectedHead)
        || !equalBytes(actualHead.stateHash, record.stateHash)
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "provider_head_mismatch" as const,
        });
      }
    } finally { actualHead.stateHash.fill(0); }
    rosterBytes = provider.publicRoster(active);
    const roster = decodeProviderRosterV2(record.providerId, rosterBytes);
    if (
      roster.length !== 1
      || roster[0]?.leafIndex !== 0
      || roster[0]?.humanId !== input.humanId
      || roster[0]?.deviceId !== local.deviceId
    ) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "not_sole_founding_device" as const,
      });
    }
    localPublicKey = local.signingPublicKey.slice();
    const result = await input.operation((context) =>
      context.domainId === input.expectedHead.domainId
        && context.domainEpoch === input.expectedHead.epoch
        && context.committerDeviceId === local.deviceId
        ? localPublicKey!
        : null
    );
    return Object.freeze({ status: "ready" as const, value: result });
  } finally {
    localPublicKey?.fill(0);
    rosterBytes?.fill(0);
    active.ciphertext.fill(0);
    providerVault.destroy();
  }
}
