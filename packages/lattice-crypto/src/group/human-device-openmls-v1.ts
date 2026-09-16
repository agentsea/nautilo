import type { LatticeCrypto } from "../crypto/index.ts";
import type {
  SealedProviderStateV2,
} from "../device/v2-state-vault.ts";
import { V2_PROVIDER_STATE_MAX_BYTES } from "../device/v2-state-vault.ts";
import {
  CanonicalDecodingError,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../format/v2-primitives.ts";
import type {
  LocalProviderCandidateV2,
  ProviderApplyResultV2,
  ProviderPublicHeadV2,
  ProviderPublicTransitionV2,
} from "../transition/provider-candidate.ts";
import {
  type CryptoDeviceId,
  type CryptoDomainId,
  type HumanId,
  assertPortableId,
  assertU64Counter,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import type { DeviceProviderStateVaultV2 } from "../device/v2-state-vault.ts";
import {
  type OpenMlsV2AuthenticatedRosterEntry,
  type OpenMlsV2IdentityCodec,
  type OpenMlsV2JoinRequestPublic,
  OpenMlsV2GroupProvider,
} from "./v2-openmls.ts";
import { V2ProviderStateError } from "./v2-provider.ts";

export const HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1 = 1 as const;
export const HUMAN_DEVICE_GROUP_PROVIDER_ID_V1 = "openmls-human-device-v1";
const CREDENTIAL_DOMAIN =
  "nautilo/lattice-crypto/human-device-credential/v1";
const CREDENTIAL_PREFIX = "hd1_";
const HASH_BYTES = 32;
export const HUMAN_DEVICE_GROUP_MAX_ROSTER_BYTES_V1 =
  V2_PROVIDER_STATE_MAX_BYTES;
export const HUMAN_DEVICE_GROUP_MAX_CREDENTIAL_BYTES_V1 =
  CREDENTIAL_PREFIX.length + 2 * (
    4 + CREDENTIAL_DOMAIN.length
    + 4
    + 4 + 36
    + 4 + V2_LIMITS.idBytes
    + 8
    + 4 + V2_LIMITS.idBytes
    + 4 + HASH_BYTES
    + 8
  );
export const HUMAN_DEVICE_GROUP_MAX_TRANSITION_BYTES_V1 =
  3 * V2_PROVIDER_STATE_MAX_BYTES;

const ROSTER_DOMAIN =
  "nautilo/lattice-crypto/human-device-roster/v1";
const GROUP_ID_DOMAIN =
  "nautilo/lattice-crypto/human-device-group-id/v1";
const HEAD_DOMAIN =
  "nautilo/lattice-crypto/human-device-group-head/v1";
const HEAD_DIGEST_DOMAIN =
  "nautilo/lattice-crypto/human-device-group-head-digest/v1";
const TRANSITION_DIGEST_DOMAIN =
  "nautilo/lattice-crypto/human-device-group-transition-digest/v1";
const JOIN_REQUEST_DOMAIN =
  "nautilo/lattice-crypto/human-device-group-join-request/v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface HumanDeviceGroupCoordinatesV1 {
  readonly serverInstanceId: string;
  readonly humanId: HumanId;
  readonly lineageGeneration: number;
}

export interface HumanDeviceCredentialV1
  extends HumanDeviceGroupCoordinatesV1 {
  readonly formatVersion: typeof HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1;
  readonly deviceId: CryptoDeviceId;
  readonly installationLineageDigest: Uint8Array;
  readonly deviceKeyGeneration: number;
}

export interface HumanDeviceRosterEntryV1 extends HumanDeviceCredentialV1 {
  readonly leafIndex: number;
}

export interface HumanDeviceGroupHeadV1
  extends HumanDeviceGroupCoordinatesV1 {
  readonly formatVersion: typeof HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1;
  readonly providerId: typeof HUMAN_DEVICE_GROUP_PROVIDER_ID_V1;
  readonly groupId: CryptoDomainId;
  readonly epoch: number;
  readonly stateHash: Uint8Array;
  readonly rosterDigest: Uint8Array;
  readonly previousHeadDigest: Uint8Array | null;
  readonly securityRevision: number;
}

export interface HumanDeviceGroupJoinRequestV1 {
  readonly formatVersion: typeof HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1;
  readonly coordinates: HumanDeviceGroupCoordinatesV1;
  readonly credential: HumanDeviceCredentialV1;
  readonly expectedHead: HumanDeviceGroupHeadV1;
  readonly keyPackageBytes: Uint8Array;
}

export interface PreparedHumanDeviceGroupJoinV1 {
  readonly publicResult: HumanDeviceGroupJoinRequestV1;
  readonly localState: SealedProviderStateV2;
}

export function encodeHumanDeviceGroupJoinRequestV1(
  request: HumanDeviceGroupJoinRequestV1,
): Uint8Array {
  if (
    request.formatVersion !== HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1
    || !coordinatesEqual(request.coordinates, request.credential)
    || !coordinatesEqual(request.coordinates, request.expectedHead)
    || request.keyPackageBytes.length < 1
    || request.keyPackageBytes.length > V2_PROVIDER_STATE_MAX_BYTES
  ) throw new V2ProviderStateError("Human-device join request is invalid");
  return concatV2(
    frameText(JOIN_REQUEST_DOMAIN),
    encodeU32(HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1),
    frame(encodeHumanDeviceGroupHeadV1(request.expectedHead)),
    frame(encodeCredentialBody(request.credential)),
    frame(request.keyPackageBytes),
  );
}

export function decodeHumanDeviceGroupJoinRequestV1(
  bytes: Uint8Array,
): HumanDeviceGroupJoinRequestV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1
    || bytes.length > 2 * V2_PROVIDER_STATE_MAX_BYTES) {
    throw new V2ProviderStateError("Human-device join request bytes are invalid");
  }
  const request = decodeExact(bytes, (reader) => {
    if (reader.readText(JOIN_REQUEST_DOMAIN.length) !== JOIN_REQUEST_DOMAIN) {
      throw new CanonicalDecodingError(
        "Human-device join request domain is unsupported",
      );
    }
    reader.readVersion(HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1);
    const expectedHead = decodeHumanDeviceGroupHeadV1(
      reader.readFrame(16 * 1024),
    );
    const credential = decodeHumanDeviceCredentialNameV1(
      `${CREDENTIAL_PREFIX}${hex(reader.readFrame(
        HUMAN_DEVICE_GROUP_MAX_CREDENTIAL_BYTES_V1,
      ))}`,
    );
    return Object.freeze({
      formatVersion: HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1,
      coordinates: Object.freeze({
        serverInstanceId: expectedHead.serverInstanceId,
        humanId: expectedHead.humanId,
        lineageGeneration: expectedHead.lineageGeneration,
      }),
      credential,
      expectedHead,
      keyPackageBytes: reader.readFrame(V2_PROVIDER_STATE_MAX_BYTES),
    });
  });
  const canonical = encodeHumanDeviceGroupJoinRequestV1(request);
  if (!sameBytes(canonical, bytes)) {
    throw new V2ProviderStateError("Human-device join request is noncanonical");
  }
  return request;
}

export interface HumanDeviceGroupTransitionV1 {
  readonly formatVersion: typeof HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1;
  readonly operation: "add" | "remove" | "update";
  readonly coordinates: HumanDeviceGroupCoordinatesV1;
  readonly expectedHead: HumanDeviceGroupHeadV1;
  readonly nextHead: HumanDeviceGroupHeadV1;
  readonly targetCredential: HumanDeviceCredentialV1;
  readonly committerCredential: HumanDeviceCredentialV1;
  readonly joinRequestHash: Uint8Array;
  readonly commitBytes: Uint8Array;
  readonly welcomeHash: Uint8Array;
  readonly welcomeBytes: Uint8Array;
  readonly rosterBytes: Uint8Array;
}

export interface PreparedHumanDeviceGroupTransitionV1 {
  readonly publicResult: HumanDeviceGroupTransitionV1;
  readonly localCandidate: LocalProviderCandidateV2;
  readonly providerTransition: ProviderPublicTransitionV2;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function hex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function fromLowerHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) {
    throw new CanonicalDecodingError(
      "Human-device credential is not canonical lowercase hex",
    );
  }
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(
      value.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return output;
}

function exactDigest(label: string, value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new V2ProviderStateError(`${label} must contain 32 bytes`);
  }
  return copyOwnedBytesV2(value);
}

function counter(label: string, value: unknown, minimum = 0): number {
  assertU64Counter(label, value);
  if (value < minimum) {
    throw new V2ProviderStateError(`${label} is below its minimum`);
  }
  return value;
}

function serverInstanceId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new V2ProviderStateError(
      "Server instance id must be a canonical lowercase UUID",
    );
  }
  return value;
}

function normalizeCoordinates(
  value: HumanDeviceGroupCoordinatesV1,
): HumanDeviceGroupCoordinatesV1 {
  return Object.freeze({
    serverInstanceId: serverInstanceId(value.serverInstanceId),
    humanId: humanId(value.humanId),
    lineageGeneration: counter(
      "Human device-group lineage generation",
      value.lineageGeneration,
      1,
    ),
  });
}

function normalizeCredential(
  value: HumanDeviceCredentialV1,
): HumanDeviceCredentialV1 {
  const coordinates = normalizeCoordinates(value);
  if (value.formatVersion !== HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1) {
    throw new V2ProviderStateError(
      "Human-device credential version is unsupported",
    );
  }
  return Object.freeze({
    formatVersion: HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1,
    ...coordinates,
    deviceId: cryptoDeviceId(value.deviceId),
    installationLineageDigest: exactDigest(
      "Installation lineage digest",
      value.installationLineageDigest,
    ),
    deviceKeyGeneration: counter(
      "Device key generation",
      value.deviceKeyGeneration,
      1,
    ),
  });
}

function coordinatesEqual(
  left: HumanDeviceGroupCoordinatesV1,
  right: HumanDeviceGroupCoordinatesV1,
): boolean {
  return left.serverInstanceId === right.serverInstanceId
    && left.humanId === right.humanId
    && left.lineageGeneration === right.lineageGeneration;
}

function encodeCredentialBody(
  credential: HumanDeviceCredentialV1,
): Uint8Array {
  const value = normalizeCredential(credential);
  return concatV2(
    frameText(CREDENTIAL_DOMAIN),
    encodeU32(HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1),
    frameText(value.serverInstanceId),
    frameText(value.humanId),
    encodeU64(value.lineageGeneration),
    frameText(value.deviceId),
    frame(value.installationLineageDigest),
    encodeU64(value.deviceKeyGeneration),
  );
}

export function encodeHumanDeviceCredentialNameV1(
  credential: HumanDeviceCredentialV1,
): string {
  const encoded = `${CREDENTIAL_PREFIX}${hex(encodeCredentialBody(credential))}`;
  if (encoded.length > HUMAN_DEVICE_GROUP_MAX_CREDENTIAL_BYTES_V1) {
    throw new V2ProviderStateError(
      "Human-device credential exceeds the protocol byte limit",
    );
  }
  return encoded;
}

export function decodeHumanDeviceCredentialNameV1(
  value: string,
): HumanDeviceCredentialV1 {
  if (
    typeof value !== "string"
    || value.length > HUMAN_DEVICE_GROUP_MAX_CREDENTIAL_BYTES_V1
    || !value.startsWith(CREDENTIAL_PREFIX)
  ) {
    throw new V2ProviderStateError(
      "Human-device credential is unsupported",
    );
  }
  const decoded = decodeExact(
    fromLowerHex(value.slice(CREDENTIAL_PREFIX.length)),
    (reader) => {
      if (reader.readText(CREDENTIAL_DOMAIN.length) !== CREDENTIAL_DOMAIN) {
        throw new CanonicalDecodingError(
          "Human-device credential domain is unsupported",
        );
      }
      reader.readVersion(HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1);
      return normalizeCredential({
        formatVersion: HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1,
        serverInstanceId: reader.readText(36),
        humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
        lineageGeneration: reader.readU64(),
        deviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
        installationLineageDigest: reader.readFrame(HASH_BYTES),
        deviceKeyGeneration: reader.readU64(),
      });
    },
  );
  if (encodeHumanDeviceCredentialNameV1(decoded) !== value) {
    throw new V2ProviderStateError(
      "Human-device credential is noncanonical",
    );
  }
  return decoded;
}

function encodeRoster(
  coordinates: HumanDeviceGroupCoordinatesV1,
  entries: readonly OpenMlsV2AuthenticatedRosterEntry[],
): Uint8Array {
  const normalizedCoordinates = normalizeCoordinates(coordinates);
  const normalized = entries.map((entry) => {
    const credential = decodeHumanDeviceCredentialNameV1(
      entry.credentialName,
    );
    if (
      entry.humanId !== credential.humanId
      || entry.deviceId !== credential.deviceId
      || !coordinatesEqual(normalizedCoordinates, credential)
    ) {
      throw new V2ProviderStateError(
        "Human-device roster credential has foreign coordinates",
      );
    }
    return Object.freeze({
      leafIndex: counter("Human-device roster leaf", entry.leafIndex),
      credential,
    });
  }).sort((left, right) => left.leafIndex - right.leafIndex);
  const devices = new Set<CryptoDeviceId>();
  const leaves = new Set<number>();
  for (const entry of normalized) {
    if (
      devices.has(entry.credential.deviceId)
      || leaves.has(entry.leafIndex)
    ) {
      throw new V2ProviderStateError(
        "Human-device roster contains a duplicate identity",
      );
    }
    devices.add(entry.credential.deviceId);
    leaves.add(entry.leafIndex);
  }
  const encoded = concatV2(
    frameText(ROSTER_DOMAIN),
    encodeU32(HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1),
    frameText(normalizedCoordinates.serverInstanceId),
    frameText(normalizedCoordinates.humanId),
    encodeU64(normalizedCoordinates.lineageGeneration),
    encodeU32(normalized.length),
    ...normalized.map((entry) => concatV2(
      encodeU32(entry.leafIndex),
      frame(encodeCredentialBody(entry.credential)),
    )),
  );
  if (encoded.length > HUMAN_DEVICE_GROUP_MAX_ROSTER_BYTES_V1) {
    throw new V2ProviderStateError(
      "Human-device roster exceeds the protocol byte limit",
    );
  }
  return encoded;
}

export function decodeHumanDeviceRosterV1(
  rosterBytes: Uint8Array,
): readonly HumanDeviceRosterEntryV1[] {
  if (
    !(rosterBytes instanceof Uint8Array)
    || rosterBytes.length < 1
    || rosterBytes.length > HUMAN_DEVICE_GROUP_MAX_ROSTER_BYTES_V1
  ) {
    throw new V2ProviderStateError("Human-device roster bytes are invalid");
  }
  return decodeExact(rosterBytes, (reader) => {
    if (reader.readText(ROSTER_DOMAIN.length) !== ROSTER_DOMAIN) {
      throw new CanonicalDecodingError(
        "Human-device roster domain is unsupported",
      );
    }
    reader.readVersion(HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1);
    const coordinates = normalizeCoordinates({
      serverInstanceId: reader.readText(36),
      humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      lineageGeneration: reader.readU64(),
    });
    const count = reader.readU32();
    const minimumEncodedEntryBytes = 4 + 4 + 1;
    if (count > Math.floor(reader.remaining / minimumEncodedEntryBytes)) {
      throw new CanonicalDecodingError(
        "Human-device roster count exceeds its encoded bytes",
      );
    }
    const entries: HumanDeviceRosterEntryV1[] = [];
    let previousLeaf = -1;
    const devices = new Set<CryptoDeviceId>();
    for (let index = 0; index < count; index += 1) {
      const leafIndex = reader.readU32();
      const credentialBody = reader.readFrame(
        HUMAN_DEVICE_GROUP_MAX_CREDENTIAL_BYTES_V1,
      );
      const credential = decodeHumanDeviceCredentialNameV1(
        `${CREDENTIAL_PREFIX}${hex(credentialBody)}`,
      );
      if (
        !coordinatesEqual(coordinates, credential)
        || leafIndex <= previousLeaf
        || devices.has(credential.deviceId)
      ) {
        credentialBody.fill(0);
        throw new V2ProviderStateError(
          "Human-device roster is not a canonical current membership",
        );
      }
      credentialBody.fill(0);
      previousLeaf = leafIndex;
      devices.add(credential.deviceId);
      entries.push(Object.freeze({ leafIndex, ...credential }));
    }
    return Object.freeze(entries);
  });
}

export function deriveHumanDeviceGroupIdV1(
  crypto: LatticeCrypto,
  coordinates: HumanDeviceGroupCoordinatesV1,
): CryptoDomainId {
  const value = normalizeCoordinates(coordinates);
  return cryptoDomainId(`human_device_${hex(crypto.hash(concatV2(
    frameText(GROUP_ID_DOMAIN),
    encodeU32(HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1),
    frameText(value.serverInstanceId),
    frameText(value.humanId),
    encodeU64(value.lineageGeneration),
  )).subarray(0, 16))}`);
}

function encodeNullableDigest(value: Uint8Array | null): Uint8Array {
  return frame(value === null ? new Uint8Array() : exactDigest(
    "Previous Human-device group head digest",
    value,
  ));
}

export function encodeHumanDeviceGroupHeadV1(
  head: HumanDeviceGroupHeadV1,
): Uint8Array {
  const coordinates = normalizeCoordinates(head);
  if (
    head.formatVersion !== HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1
    || head.providerId !== HUMAN_DEVICE_GROUP_PROVIDER_ID_V1
  ) {
    throw new V2ProviderStateError("Human-device group head is unsupported");
  }
  return concatV2(
    frameText(HEAD_DOMAIN),
    encodeU32(HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1),
    frameText(head.providerId),
    frameText(coordinates.serverInstanceId),
    frameText(coordinates.humanId),
    encodeU64(coordinates.lineageGeneration),
    frameText(cryptoDomainId(head.groupId)),
    encodeU64(counter("Human-device group epoch", head.epoch)),
    frame(exactDigest("Human-device group state hash", head.stateHash)),
    frame(exactDigest("Human-device roster digest", head.rosterDigest)),
    encodeNullableDigest(head.previousHeadDigest),
    encodeU64(counter(
      "Human-device membership security revision",
      head.securityRevision,
      1,
    )),
  );
}

export function decodeHumanDeviceGroupHeadV1(
  bytes: Uint8Array,
): HumanDeviceGroupHeadV1 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > 16 * 1024
  ) throw new V2ProviderStateError("Human-device group head bytes are invalid");
  const decoded = decodeExact(bytes, (reader) => {
    if (reader.readText(HEAD_DOMAIN.length) !== HEAD_DOMAIN) {
      throw new CanonicalDecodingError(
        "Human-device group head domain is unsupported",
      );
    }
    reader.readVersion(HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1);
    const providerId = reader.readText(V2_LIMITS.idBytes);
    const coordinates = normalizeCoordinates({
      serverInstanceId: reader.readText(36),
      humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      lineageGeneration: reader.readU64(),
    });
    const groupId = cryptoDomainId(reader.readText(V2_LIMITS.idBytes));
    const epoch = reader.readU64();
    const stateHash = reader.readFrame(HASH_BYTES);
    const rosterDigest = reader.readFrame(HASH_BYTES);
    const previousBytes = reader.readFrame(HASH_BYTES);
    const previousHeadDigest = previousBytes.length === 0
      ? null
      : exactDigest("Previous Human-device group head digest", previousBytes);
    previousBytes.fill(0);
    return Object.freeze({
      formatVersion: HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1,
      providerId: providerId as typeof HUMAN_DEVICE_GROUP_PROVIDER_ID_V1,
      ...coordinates,
      groupId,
      epoch,
      stateHash,
      rosterDigest,
      previousHeadDigest,
      securityRevision: reader.readU64(),
    });
  });
  const canonical = encodeHumanDeviceGroupHeadV1(decoded);
  if (!sameBytes(canonical, bytes)) {
    throw new V2ProviderStateError(
      "Human-device group head bytes are noncanonical",
    );
  }
  return decoded;
}

export function humanDeviceGroupHeadDigestV1(
  crypto: LatticeCrypto,
  head: HumanDeviceGroupHeadV1,
): Uint8Array {
  return copyOwnedBytesV2(crypto.hash(concatV2(
    frameText(HEAD_DIGEST_DOMAIN),
    frame(encodeHumanDeviceGroupHeadV1(head)),
  )));
}

function headFromProvider(input: Readonly<{
  readonly crypto: LatticeCrypto;
  readonly coordinates: HumanDeviceGroupCoordinatesV1;
  readonly providerHead: ProviderPublicHeadV2;
  readonly rosterBytes: Uint8Array;
  readonly previousHead: HumanDeviceGroupHeadV1 | null;
}>): HumanDeviceGroupHeadV1 {
  const coordinates = normalizeCoordinates(input.coordinates);
  return Object.freeze({
    formatVersion: HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1,
    providerId: HUMAN_DEVICE_GROUP_PROVIDER_ID_V1,
    ...coordinates,
    groupId: input.providerHead.domainId,
    epoch: Number(input.providerHead.epoch),
    stateHash: exactDigest(
      "Human-device group state hash",
      input.providerHead.stateHash,
    ),
    rosterDigest: copyOwnedBytesV2(input.crypto.hash(input.rosterBytes)),
    previousHeadDigest: input.previousHead === null
      ? null
      : humanDeviceGroupHeadDigestV1(input.crypto, input.previousHead),
    securityRevision: input.previousHead === null
      ? 1
      : input.previousHead.securityRevision + 1,
  });
}

function providerHead(head: HumanDeviceGroupHeadV1): ProviderPublicHeadV2 {
  return Object.freeze({
    providerId: "openmls-v2",
    domainId: head.groupId,
    epoch: domainEpoch(head.epoch),
    stateHash: copyOwnedBytesV2(head.stateHash),
  });
}

function sameHead(
  left: HumanDeviceGroupHeadV1,
  right: HumanDeviceGroupHeadV1,
): boolean {
  return sameBytes(
    encodeHumanDeviceGroupHeadV1(left),
    encodeHumanDeviceGroupHeadV1(right),
  );
}

export function encodeHumanDeviceGroupTransitionV1(
  transition: HumanDeviceGroupTransitionV1,
): Uint8Array {
  if (
    transition.formatVersion !== HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1
    || !coordinatesEqual(transition.coordinates, transition.expectedHead)
    || !coordinatesEqual(transition.coordinates, transition.nextHead)
    || !coordinatesEqual(transition.coordinates, transition.targetCredential)
    || !coordinatesEqual(
      transition.coordinates,
      transition.committerCredential,
    )
    || transition.joinRequestHash.length !== HASH_BYTES
    || !["add", "remove", "update"].includes(transition.operation)
  ) throw new V2ProviderStateError("Human-device group transition is invalid");
  return concatV2(
    frameText(TRANSITION_DIGEST_DOMAIN),
    encodeU32(HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1),
    frameText(transition.operation),
    frame(encodeHumanDeviceGroupHeadV1(transition.expectedHead)),
    frame(encodeHumanDeviceGroupHeadV1(transition.nextHead)),
    frame(encodeCredentialBody(transition.targetCredential)),
    frame(encodeCredentialBody(transition.committerCredential)),
    frame(transition.joinRequestHash),
    frame(transition.commitBytes),
    frame(transition.welcomeHash),
    frame(transition.rosterBytes),
  );
}

export function decodeHumanDeviceGroupTransitionV1(
  crypto: LatticeCrypto,
  bytes: Uint8Array,
): HumanDeviceGroupTransitionV1 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > HUMAN_DEVICE_GROUP_MAX_TRANSITION_BYTES_V1
  ) throw new V2ProviderStateError(
    "Human-device group transition bytes are invalid",
  );
  const transition = decodeExact(bytes, (reader) => {
    if (
      reader.readText(TRANSITION_DIGEST_DOMAIN.length)
        !== TRANSITION_DIGEST_DOMAIN
    ) throw new CanonicalDecodingError(
      "Human-device group transition domain is unsupported",
    );
    reader.readVersion(HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1);
    const operation = reader.readText(16);
    if (operation !== "add" && operation !== "remove"
      && operation !== "update") {
      throw new CanonicalDecodingError(
        "Human-device group transition operation is unsupported",
      );
    }
    const expectedHead = decodeHumanDeviceGroupHeadV1(
      reader.readFrame(16 * 1024),
    );
    const nextHead = decodeHumanDeviceGroupHeadV1(
      reader.readFrame(16 * 1024),
    );
    const targetCredential = decodeHumanDeviceCredentialNameV1(
      `${CREDENTIAL_PREFIX}${hex(reader.readFrame(
        HUMAN_DEVICE_GROUP_MAX_CREDENTIAL_BYTES_V1,
      ))}`,
    );
    const committerCredential = decodeHumanDeviceCredentialNameV1(
      `${CREDENTIAL_PREFIX}${hex(reader.readFrame(
        HUMAN_DEVICE_GROUP_MAX_CREDENTIAL_BYTES_V1,
      ))}`,
    );
    const joinRequestHash = reader.readFrame(HASH_BYTES);
    const commitBytes = reader.readFrame(V2_PROVIDER_STATE_MAX_BYTES);
    const welcomeHash = reader.readFrame(HASH_BYTES);
    const rosterBytes = reader.readFrame(
      HUMAN_DEVICE_GROUP_MAX_ROSTER_BYTES_V1,
    );
    return Object.freeze({
      formatVersion: HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1,
      operation,
      coordinates: Object.freeze({
        serverInstanceId: expectedHead.serverInstanceId,
        humanId: expectedHead.humanId,
        lineageGeneration: expectedHead.lineageGeneration,
      }),
      expectedHead,
      nextHead,
      targetCredential,
      committerCredential,
      joinRequestHash,
      commitBytes,
      welcomeHash,
      welcomeBytes: new Uint8Array(),
      rosterBytes,
    });
  });
  const canonical = encodeHumanDeviceGroupTransitionV1(transition);
  if (
    !sameBytes(canonical, bytes)
    || transition.nextHead.epoch !== transition.expectedHead.epoch + 1
    || transition.nextHead.securityRevision
      !== transition.expectedHead.securityRevision + 1
    || transition.nextHead.previousHeadDigest === null
    || !sameBytes(
      transition.nextHead.previousHeadDigest,
      humanDeviceGroupHeadDigestV1(crypto, transition.expectedHead),
    )
    || !sameBytes(
      transition.nextHead.rosterDigest,
      crypto.hash(transition.rosterBytes),
    )
  ) throw new V2ProviderStateError(
    "Human-device group transition does not close over its exact heads",
  );
  const roster = decodeHumanDeviceRosterV1(transition.rosterBytes);
  const targetIsPresent = roster.some((entry) =>
    entry.deviceId === transition.targetCredential.deviceId
    && entry.deviceKeyGeneration
      === transition.targetCredential.deviceKeyGeneration
    && sameBytes(
      entry.installationLineageDigest,
      transition.targetCredential.installationLineageDigest,
    )
  );
  if (
    (transition.operation === "remove" ? targetIsPresent : !targetIsPresent)
    || !roster.some((entry) =>
      entry.deviceId === transition.committerCredential.deviceId
      && entry.deviceKeyGeneration
        === transition.committerCredential.deviceKeyGeneration
    )
  ) throw new V2ProviderStateError(
    "Human-device group transition roster omits an exact participant",
  );
  return transition;
}

export function humanDeviceGroupTransitionDigestV1(
  crypto: LatticeCrypto,
  transition: HumanDeviceGroupTransitionV1,
): Uint8Array {
  return copyOwnedBytesV2(
    crypto.hash(encodeHumanDeviceGroupTransitionV1(transition)),
  );
}

class HumanDeviceIdentityCodec implements OpenMlsV2IdentityCodec {
  readonly maxCredentialStringBytes =
    HUMAN_DEVICE_GROUP_MAX_CREDENTIAL_BYTES_V1;
  readonly maxRosterBytes = HUMAN_DEVICE_GROUP_MAX_ROSTER_BYTES_V1;

  constructor(
    private readonly coordinates: HumanDeviceGroupCoordinatesV1,
    private readonly ownCredential: HumanDeviceCredentialV1,
  ) {}

  credentialName(input: Readonly<{
    readonly humanId: HumanId;
    readonly deviceId: CryptoDeviceId;
  }>): string {
    if (
      input.humanId !== this.ownCredential.humanId
      || input.deviceId !== this.ownCredential.deviceId
    ) {
      throw new V2ProviderStateError(
        "OpenMLS requested a credential for another local identity",
      );
    }
    return encodeHumanDeviceCredentialNameV1(this.ownCredential);
  }

  parseCredentialName(value: string): Readonly<{
    readonly humanId: HumanId;
    readonly deviceId: CryptoDeviceId;
  }> {
    const credential = decodeHumanDeviceCredentialNameV1(value);
    if (!coordinatesEqual(this.coordinates, credential)) {
      throw new V2ProviderStateError(
        "OpenMLS credential belongs to another Human-device group",
      );
    }
    return Object.freeze({
      humanId: credential.humanId,
      deviceId: credential.deviceId,
    });
  }

  encodeRoster(
    roster: readonly OpenMlsV2AuthenticatedRosterEntry[],
  ): Uint8Array {
    return encodeRoster(this.coordinates, roster);
  }
}

/**
 * Membership-only adapter over the audited OpenMLS provider. It deliberately
 * exposes no MLS exporter or content-key method.
 */
export class HumanDeviceOpenMlsGroupV1 {
  readonly coordinates: HumanDeviceGroupCoordinatesV1;
  readonly ownCredential: HumanDeviceCredentialV1;
  readonly groupId: CryptoDomainId;
  private readonly provider: OpenMlsV2GroupProvider;

  constructor(
    private readonly crypto: LatticeCrypto,
    vault: DeviceProviderStateVaultV2,
    input: Readonly<{
      readonly coordinates: HumanDeviceGroupCoordinatesV1;
      readonly ownCredential: HumanDeviceCredentialV1;
    }>,
  ) {
    this.coordinates = normalizeCoordinates(input.coordinates);
    this.ownCredential = normalizeCredential(input.ownCredential);
    if (
      !coordinatesEqual(this.coordinates, this.ownCredential)
      || this.ownCredential.deviceId !== vault.deviceId
    ) {
      throw new V2ProviderStateError(
        "Human-device group local credential does not match its custody",
      );
    }
    this.groupId = deriveHumanDeviceGroupIdV1(crypto, this.coordinates);
    this.provider = new OpenMlsV2GroupProvider(
      crypto,
      vault,
      new HumanDeviceIdentityCodec(
        this.coordinates,
        this.ownCredential,
      ),
    );
  }

  initialize(): Promise<void> {
    return this.provider.initialize();
  }

  async createInitialState(): Promise<Readonly<{
    readonly active: SealedProviderStateV2;
    readonly head: HumanDeviceGroupHeadV1;
    readonly roster: readonly HumanDeviceRosterEntryV1[];
    readonly rosterBytes: Uint8Array;
  }>> {
    const active = await this.provider.createInitialState({
      domainId: this.groupId,
      humanId: this.coordinates.humanId,
    });
    const rosterBytes = this.provider.publicRoster(active);
    const head = headFromProvider({
      crypto: this.crypto,
      coordinates: this.coordinates,
      providerHead: this.provider.publicHead(active),
      rosterBytes,
      previousHead: null,
    });
    return Object.freeze({
      active,
      head,
      roster: decodeHumanDeviceRosterV1(rosterBytes),
      rosterBytes: copyOwnedBytesV2(rosterBytes),
    });
  }

  async createJoinRequest(
    expectedHead: HumanDeviceGroupHeadV1,
  ): Promise<PreparedHumanDeviceGroupJoinV1> {
    this.assertHead(expectedHead);
    const result = await this.provider.createJoinRequest({
      domainId: this.groupId,
      humanId: this.coordinates.humanId,
      expectedHead: providerHead(expectedHead),
    });
    return Object.freeze({
      publicResult: Object.freeze({
        formatVersion: HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1,
        coordinates: this.coordinates,
        credential: this.ownCredential,
        expectedHead,
        keyPackageBytes: copyOwnedBytesV2(
          result.publicResult.keyPackageBytes,
        ),
      }),
      localState: result.localState,
    });
  }

  async prepareAdd(input: Readonly<{
    readonly active: SealedProviderStateV2;
    readonly currentHead: HumanDeviceGroupHeadV1;
    readonly joinRequest: HumanDeviceGroupJoinRequestV1;
  }>): Promise<PreparedHumanDeviceGroupTransitionV1> {
    this.assertHead(input.currentHead);
    if (
      !coordinatesEqual(this.coordinates, input.joinRequest.coordinates)
      || !sameHead(input.currentHead, input.joinRequest.expectedHead)
      || !coordinatesEqual(this.coordinates, input.joinRequest.credential)
    ) {
      throw new V2ProviderStateError(
        "Human-device join request does not match the current group",
      );
    }
    const providerResult = await this.provider.prepareAdd({
      active: input.active,
      joinRequest: this.providerJoinRequest(input.joinRequest),
    });
    const nextHead = headFromProvider({
      crypto: this.crypto,
      coordinates: this.coordinates,
      providerHead: providerResult.publicResult.nextHead,
      rosterBytes: providerResult.publicResult.rosterBytes,
      previousHead: input.currentHead,
    });
    const publicResult = Object.freeze({
      formatVersion: HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1,
      operation: "add" as const,
      coordinates: this.coordinates,
      expectedHead: input.currentHead,
      nextHead,
      targetCredential: normalizeCredential(
        input.joinRequest.credential,
      ),
      committerCredential: this.ownCredential,
      joinRequestHash: copyOwnedBytesV2(this.crypto.hash(
        encodeHumanDeviceGroupJoinRequestV1(input.joinRequest),
      )),
      commitBytes: copyOwnedBytesV2(providerResult.publicResult.commitBytes),
      welcomeHash: copyOwnedBytesV2(providerResult.publicResult.welcomeHash),
      welcomeBytes: copyOwnedBytesV2(providerResult.publicResult.welcomeBytes),
      rosterBytes: copyOwnedBytesV2(providerResult.publicResult.rosterBytes),
    });
    return Object.freeze({
      publicResult,
      localCandidate: providerResult.localCandidate,
      providerTransition: providerResult.publicResult,
    });
  }

  async prepareRemove(input: Readonly<{
    readonly active: SealedProviderStateV2;
    readonly currentHead: HumanDeviceGroupHeadV1;
    readonly removedCredential: HumanDeviceCredentialV1;
  }>): Promise<PreparedHumanDeviceGroupTransitionV1> {
    this.assertHead(input.currentHead);
    const removedCredential = normalizeCredential(input.removedCredential);
    if (!coordinatesEqual(this.coordinates, removedCredential)
      || removedCredential.deviceId === this.ownCredential.deviceId) {
      throw new V2ProviderStateError(
        "Human-device removal must target another current device",
      );
    }
    this.publicHead({
      active: input.active,
      trustedHead: input.currentHead,
    });
    const currentRoster = this.publicRoster(input.active);
    const exactTarget = currentRoster.find((entry) =>
      entry.deviceId === removedCredential.deviceId
      && entry.deviceKeyGeneration === removedCredential.deviceKeyGeneration
      && sameBytes(
        entry.installationLineageDigest,
        removedCredential.installationLineageDigest,
      )
    );
    if (exactTarget === undefined) {
      throw new V2ProviderStateError(
        "Removed Human device is not an exact current roster member",
      );
    }
    const providerResult = await this.provider.prepareRemove({
      active: input.active,
      removedDeviceId: removedCredential.deviceId,
    });
    const nextHead = headFromProvider({
      crypto: this.crypto,
      coordinates: this.coordinates,
      providerHead: providerResult.publicResult.nextHead,
      rosterBytes: providerResult.publicResult.rosterBytes,
      previousHead: input.currentHead,
    });
    const publicResult = Object.freeze({
      formatVersion: HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1,
      operation: "remove" as const,
      coordinates: this.coordinates,
      expectedHead: input.currentHead,
      nextHead,
      targetCredential: removedCredential,
      committerCredential: this.ownCredential,
      joinRequestHash: copyOwnedBytesV2(this.crypto.hash(new Uint8Array())),
      commitBytes: copyOwnedBytesV2(providerResult.publicResult.commitBytes),
      welcomeHash: copyOwnedBytesV2(providerResult.publicResult.welcomeHash),
      welcomeBytes: new Uint8Array(),
      rosterBytes: copyOwnedBytesV2(providerResult.publicResult.rosterBytes),
    });
    return Object.freeze({
      publicResult,
      localCandidate: providerResult.localCandidate,
      providerTransition: providerResult.publicResult,
    });
  }

  async prepareIncoming(input: Readonly<{
    readonly active: SealedProviderStateV2;
    readonly transition: HumanDeviceGroupTransitionV1;
    readonly providerTransition?: ProviderPublicTransitionV2;
  }>): Promise<LocalProviderCandidateV2> {
    const providerTransition = input.providerTransition
      ?? this.providerTransition(input.transition);
    this.assertTransition(input.transition, providerTransition);
    return this.provider.prepareIncoming({
      active: input.active,
      publicResult: providerTransition,
    });
  }

  async prepareWelcome(input: Readonly<{
    readonly joinState: SealedProviderStateV2;
    readonly joinRequest: HumanDeviceGroupJoinRequestV1;
    readonly transition: HumanDeviceGroupTransitionV1;
    readonly welcomeBytes?: Uint8Array;
    readonly providerTransition?: ProviderPublicTransitionV2;
  }>): Promise<LocalProviderCandidateV2> {
    const providerTransition = input.providerTransition
      ?? this.providerTransition(input.transition, input.welcomeBytes);
    this.assertTransition(input.transition, providerTransition);
    if (
      input.transition.targetCredential.deviceId
        !== this.ownCredential.deviceId
      || !sameHead(
        input.joinRequest.expectedHead,
        input.transition.expectedHead,
      )
    ) {
      throw new V2ProviderStateError(
        "Human-device Welcome targets another join request",
      );
    }
    return this.provider.prepareWelcome({
      joinState: input.joinState,
      publicResult: providerTransition,
    });
  }

  activateWelcome(input: Readonly<{
    readonly candidate: LocalProviderCandidateV2;
    readonly joinState: SealedProviderStateV2;
  }>): ProviderApplyResultV2 {
    return this.provider.activateWelcome(input);
  }

  applyCandidate(input: Readonly<{
    readonly active: SealedProviderStateV2;
    readonly candidate: LocalProviderCandidateV2;
  }>): ProviderApplyResultV2 {
    return this.provider.applyCandidate(input);
  }

  publicHead(input: Readonly<{
    readonly active: SealedProviderStateV2;
    readonly trustedHead: HumanDeviceGroupHeadV1;
  }>): HumanDeviceGroupHeadV1 {
    this.assertHead(input.trustedHead);
    const actual = this.provider.publicHead(input.active);
    if (
      actual.domainId !== input.trustedHead.groupId
      || Number(actual.epoch) !== input.trustedHead.epoch
      || !sameBytes(actual.stateHash, input.trustedHead.stateHash)
    ) {
      throw new V2ProviderStateError(
        "Local Human-device group state does not match its trusted head",
      );
    }
    return input.trustedHead;
  }

  publicRoster(active: SealedProviderStateV2):
    readonly HumanDeviceRosterEntryV1[] {
    return decodeHumanDeviceRosterV1(this.provider.publicRoster(active));
  }

  private providerJoinRequest(
    request: HumanDeviceGroupJoinRequestV1,
  ): OpenMlsV2JoinRequestPublic {
    return Object.freeze({
      formatVersion: 2,
      providerId: "openmls-v2",
      domainId: this.groupId,
      humanId: request.credential.humanId,
      deviceId: request.credential.deviceId,
      credentialName: encodeHumanDeviceCredentialNameV1(
        request.credential,
      ),
      expectedHead: providerHead(request.expectedHead),
      keyPackageBytes: copyOwnedBytesV2(request.keyPackageBytes),
    });
  }

  private providerTransition(
    transition: HumanDeviceGroupTransitionV1,
    welcomeBytes: Uint8Array = new Uint8Array(),
  ): ProviderPublicTransitionV2 {
    return Object.freeze({
      formatVersion: 2,
      providerId: "openmls-v2",
      domainId: transition.nextHead.groupId,
      operation: transition.operation,
      targetHumanId: transition.targetCredential.humanId,
      targetDeviceId: transition.targetCredential.deviceId,
      expectedHead: providerHead(transition.expectedHead),
      nextHead: providerHead(transition.nextHead),
      commitBytes: copyOwnedBytesV2(transition.commitBytes),
      welcomeHash: copyOwnedBytesV2(transition.welcomeHash),
      welcomeBytes: copyOwnedBytesV2(welcomeBytes),
      rosterBytes: copyOwnedBytesV2(transition.rosterBytes),
    });
  }

  private assertHead(head: HumanDeviceGroupHeadV1): void {
    const bytes = encodeHumanDeviceGroupHeadV1(head);
    bytes.fill(0);
    if (
      !coordinatesEqual(this.coordinates, head)
      || head.groupId !== this.groupId
    ) {
      throw new V2ProviderStateError(
        "Human-device group head has foreign coordinates",
      );
    }
  }

  private assertTransition(
    transition: HumanDeviceGroupTransitionV1,
    providerTransition: ProviderPublicTransitionV2,
  ): void {
    this.assertHead(transition.expectedHead);
    this.assertHead(transition.nextHead);
    assertPortableId("Provider id", providerTransition.providerId);
    if (
      transition.formatVersion !== HUMAN_DEVICE_GROUP_FORMAT_VERSION_V1
      || !coordinatesEqual(this.coordinates, transition.coordinates)
      || transition.operation !== providerTransition.operation
      || !sameBytes(
        transition.commitBytes,
        providerTransition.commitBytes,
      )
      || !sameBytes(
        transition.welcomeHash,
        providerTransition.welcomeHash,
      )
      || !sameBytes(
        transition.rosterBytes,
        providerTransition.rosterBytes,
      )
      || !sameBytes(
        transition.expectedHead.stateHash,
        providerTransition.expectedHead.stateHash,
      )
      || !sameBytes(
        transition.nextHead.stateHash,
        providerTransition.nextHead.stateHash,
      )
      || transition.nextHead.previousHeadDigest === null
      || !sameBytes(
        transition.nextHead.previousHeadDigest,
        humanDeviceGroupHeadDigestV1(this.crypto, transition.expectedHead),
      )
    ) {
      throw new V2ProviderStateError(
        "Human-device group transition does not match its OpenMLS bytes",
      );
    }
  }
}
