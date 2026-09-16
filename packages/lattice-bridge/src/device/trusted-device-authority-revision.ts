import type { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  authenticateClientDeviceProfileV3,
  destroyOpenedClientDeviceProfileV3,
  stageAndActivateClientDeviceProfileV3,
  updateClientDeviceProfileV3,
  type OpenedClientDeviceProfileV3,
} from "../client-vault/profile-v3.ts";
import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
  stageAndActivateClientDeviceProfileV4,
  updateClientDeviceProfileV4,
  type OpenedClientDeviceProfileV4,
} from "../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../client-vault/types.ts";

/**
 * Atomically advances the active profile's trusted device revision after the
 * server has durably acknowledged a Human-device Domain transition. All other
 * custody is retained and rollback is rejected.
 */
export async function advanceAndActivateClientTrustedDeviceAuthorityRevision(
  input: Readonly<{
    crypto: LatticeCrypto;
    vault: ClientProfileVault;
    coordinates: ClientProfileCoordinates;
    trustedDeviceRevision: number;
    createStageId(): string;
  }>,
): Promise<void> {
  if (!Number.isSafeInteger(input.trustedDeviceRevision)
    || input.trustedDeviceRevision < 0) {
    throw new TypeError("Trusted device revision is invalid");
  }
  const publicProfile = (await input.vault.listPublicProfiles()).find((entry) =>
    entry.lifecycle === "active"
    && entry.coordinates.profileId === input.coordinates.profileId
    && entry.coordinates.deviceId === input.coordinates.deviceId
  );
  if (publicProfile === undefined) {
    throw new Error("Client profile is unavailable");
  }
  let candidateV3: OpenedClientDeviceProfileV3 | undefined;
  let candidateV4: OpenedClientDeviceProfileV4 | undefined;
  let unchanged = false;
  await input.vault.withOpenProfile(input.coordinates, async (bytes) => {
    let profileV4: OpenedClientDeviceProfileV4 | undefined;
    let profileV3: OpenedClientDeviceProfileV3;
    try {
      profileV4 = await authenticateClientDeviceProfileV4({
        crypto: input.crypto,
        profileBytes: bytes,
        expectedDeviceId: input.coordinates.deviceId,
      });
      profileV3 = profileV4.baseProfile;
    } catch (error) {
      if (!(error instanceof TypeError)
        || error.message !== "Client profile v4 is unavailable") throw error;
      profileV3 = await authenticateClientDeviceProfileV3({
        crypto: input.crypto,
        profileBytes: bytes,
        expectedDeviceId: input.coordinates.deviceId,
      });
    }
    const currentDeviceRevision = profileV3.baseProfile.trustedDeviceRevision;
    const currentHostAuthorizationRevision =
      profileV3.baseProfile.trustedHostAuthorizationRevision;
    if (input.trustedDeviceRevision < currentDeviceRevision
      || input.trustedDeviceRevision < currentHostAuthorizationRevision) {
      if (profileV4) destroyOpenedClientDeviceProfileV4(profileV4);
      else destroyOpenedClientDeviceProfileV3(profileV3);
      throw new Error("Trusted device revision rollback was detected");
    }
    if (input.trustedDeviceRevision === currentDeviceRevision
      && input.trustedDeviceRevision === currentHostAuthorizationRevision) {
      unchanged = true;
      if (profileV4) destroyOpenedClientDeviceProfileV4(profileV4);
      else destroyOpenedClientDeviceProfileV3(profileV3);
      return;
    }
    let updatedV3: OpenedClientDeviceProfileV3 | undefined;
    try {
      updatedV3 = await updateClientDeviceProfileV3({
        crypto: input.crypto,
        profile: profileV3,
        baseProfile: Object.freeze({
          ...profileV3.baseProfile,
          trustedDeviceRevision: input.trustedDeviceRevision,
          trustedHostAuthorizationRevision: input.trustedDeviceRevision,
        }),
      });
      if (profileV4 === undefined) {
        candidateV3 = updatedV3;
        updatedV3 = undefined;
      } else {
        candidateV4 = await updateClientDeviceProfileV4({
          crypto: input.crypto,
          profile: profileV4,
          baseProfile: updatedV3,
        });
      }
    } finally {
      if (updatedV3) destroyOpenedClientDeviceProfileV3(updatedV3);
      if (profileV4) destroyOpenedClientDeviceProfileV4(profileV4);
      else destroyOpenedClientDeviceProfileV3(profileV3);
    }
  });
  if (unchanged) return;
  try {
    const stageId = input.createStageId();
    if (candidateV4 !== undefined) {
      await stageAndActivateClientDeviceProfileV4({
        crypto: input.crypto,
        vault: input.vault,
        coordinates: input.coordinates,
        stageId,
        generation: publicProfile.generation + 1,
        publicState: publicProfile.publicState,
        candidate: candidateV4,
      });
    } else if (candidateV3 !== undefined) {
      await stageAndActivateClientDeviceProfileV3({
        vault: input.vault,
        coordinates: input.coordinates,
        stageId,
        generation: publicProfile.generation + 1,
        publicState: publicProfile.publicState,
        candidate: candidateV3,
      });
    } else {
      throw new Error("Client device revision candidate is unavailable");
    }
  } finally {
    if (candidateV4) destroyOpenedClientDeviceProfileV4(candidateV4);
    if (candidateV3) destroyOpenedClientDeviceProfileV3(candidateV3);
  }
}
