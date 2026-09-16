import {
  CLIENT_PROFILE_VAULT_MAX_BYTES,
  type ClientProfileCoordinates,
  type ClientProfilePublicState,
  type StageClientProfileInput,
} from "./types.ts";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const HASH_HEX = /^[0-9a-f]{64}$/u;

export function coordinatesKey(
  coordinates: ClientProfileCoordinates,
): string {
  assertClientProfileCoordinates(coordinates);
  return [
    coordinates.serverScope,
    coordinates.userId,
    coordinates.humanActorId,
    coordinates.profileId,
    coordinates.deviceId,
    coordinates.installationLineageDigest,
  ].join("\u0000");
}

export function assertClientProfileCoordinates(
  coordinates: ClientProfileCoordinates,
): void {
  let url: URL;
  try {
    url = new URL(coordinates.serverScope);
  } catch {
    throw new TypeError("vault coordinates are invalid");
  }

  const localHttp =
    url.protocol === "http:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    coordinates.serverScope !== url.origin
    || (url.protocol !== "https:" && !localHttp)
    || !UUID_V4.test(coordinates.userId)
    || !UUID_V4.test(coordinates.humanActorId)
    || !PORTABLE_ID.test(coordinates.profileId)
    || !PORTABLE_ID.test(coordinates.deviceId)
    || !HASH_HEX.test(coordinates.installationLineageDigest)
  ) {
    throw new TypeError("vault coordinates are invalid");
  }
}

function assertPublicState(
  publicState: ClientProfilePublicState,
): void {
  if (
    !["browser", "electron", "tui"].includes(publicState.clientKind)
    || !HASH_HEX.test(publicState.publicFingerprint)
  ) {
    throw new TypeError("vault public state is invalid");
  }
}

export function assertStageInput(input: StageClientProfileInput): void {
  assertClientProfileCoordinates(input.coordinates);
  assertPublicState(input.publicState);
  if (
    !PORTABLE_ID.test(input.stageId)
    || !Number.isSafeInteger(input.generation)
    || input.generation < 1
    || input.profileBytes.length < 1
    || input.profileBytes.length > CLIENT_PROFILE_VAULT_MAX_BYTES
  ) {
    throw new TypeError("vault stage input is invalid");
  }
}
