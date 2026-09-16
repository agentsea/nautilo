import type { LatticeCrypto } from "../crypto/index.ts";
import {
  type SealedProviderStateV2,
  DeviceProviderStateVaultV2,
  V2_PROVIDER_STATE_FORMAT_VERSION,
  V2_PROVIDER_STATE_MAX_BYTES,
} from "../device/v2-state-vault.ts";
import {
  StrictDecoder,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../format/v2-primitives.ts";
import type {
  CryptoDeviceId,
  CryptoDomainId,
  DomainEpoch,
  HumanId,
} from "../v2-types/ids.ts";
import {
  assertPortableId,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const V2_PROVIDER_TRANSITION_FORMAT_VERSION = 2 as const;
const CANDIDATE_STATE_FORMAT_VERSION = 2;
const CANDIDATE_STATE_DOMAIN =
  "nautilo/lattice-crypto/provider-candidate-state/v2";
const CANDIDATE_ID_DOMAIN =
  "nautilo/lattice-crypto/provider-candidate-id/v2";
const PUBLIC_TRANSITION_DIGEST_DOMAIN =
  "nautilo/lattice-crypto/provider-public-transition/v2";
const HEAD_HASH_BYTES = 32;
const PUBLIC_TRANSITION_DIGEST_BYTES = 32;
export const V2_PROVIDER_CANDIDATE_SOURCE_ID =
  "provider-transition";

export interface ProviderPublicHeadV2 {
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly epoch: DomainEpoch;
  readonly stateHash: Uint8Array;
}

/**
 * The only portion of provider preparation that may cross the device boundary.
 * It intentionally contains no sealed local snapshot or exporter-capable
 * state.
 */
export interface ProviderPublicTransitionV2 {
  readonly formatVersion: 2;
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly operation: ProviderTransitionOperationV2;
  readonly targetHumanId: HumanId;
  readonly targetDeviceId: CryptoDeviceId;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly nextHead: ProviderPublicHeadV2;
  readonly commitBytes: Uint8Array;
  /** Recipient-independent commitment to target-only Welcome bytes. */
  readonly welcomeHash: Uint8Array;
  /**
   * Present only for the target device. Existing members receive a redacted
   * empty value and authenticate the transition through `welcomeHash`.
   */
  readonly welcomeBytes: Uint8Array;
  readonly rosterBytes: Uint8Array;
}

export interface ProviderRosterEntryV2 {
  readonly leafIndex: number;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
}

export type ProviderTransitionOperationV2 =
  | "add"
  | "remove"
  | "update";

/**
 * Local-only candidate. Callers must persist this, if at all, in device-local
 * storage. Apply, abort, and stale-CAS replace its encrypted payload with a
 * bounded authenticated lifecycle tombstone; callers may then garbage-collect
 * that terminal record according to their local retention policy.
 */
export interface LocalProviderCandidateV2 {
  readonly candidateId: string;
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly deviceId: CryptoDeviceId;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly nextHead: ProviderPublicHeadV2;
  /**
   * Public coordination commitment mirrored inside the authenticated sealed
   * state. It remains available in terminal tombstones for exact replay after
   * a process restart.
   */
  readonly publicTransitionDigest: Uint8Array;
  readonly snapshot: SealedProviderStateV2;
}

export interface PreparedProviderCommitV2 {
  readonly publicResult: ProviderPublicTransitionV2;
  readonly localCandidate: LocalProviderCandidateV2;
}

export type ProviderApplyStatusV2 =
  | "applied"
  | "duplicate"
  | "stale"
  | "aborted";

export interface ProviderApplyResultV2 {
  readonly status: ProviderApplyStatusV2;
  readonly active: SealedProviderStateV2;
}

export type ProviderAbortStatusV2 =
  | "aborted"
  | "already-aborted"
  | "already-applied";

export interface ProviderAbortResultV2 {
  readonly status: ProviderAbortStatusV2;
}

export type ProviderCandidateLifecycleV2 =
  | "prepared"
  | "applied"
  | "aborted"
  | "stale";

export interface OpenedProviderCandidateStateV2 {
  readonly lifecycle: ProviderCandidateLifecycleV2;
  readonly sourceId: string;
  readonly publicTransitionDigest: Uint8Array;
  readonly payload: Uint8Array;
}

export function destroyOpenedProviderCandidateStateV2(
  state: OpenedProviderCandidateStateV2,
): void {
  state.publicTransitionDigest.fill(0);
  state.payload.fill(0);
}

export class ProviderCandidateStateError extends Error {
  override readonly name = "ProviderCandidateStateError";
}

export function cloneProviderHeadV2(
  head: ProviderPublicHeadV2,
): ProviderPublicHeadV2 {
  return Object.freeze({
    providerId: head.providerId,
    domainId: head.domainId,
    epoch: head.epoch,
    stateHash: copyOwnedBytesV2(head.stateHash),
  });
}

export function providerHeadsEqualV2(
  left: ProviderPublicHeadV2,
  right: ProviderPublicHeadV2,
): boolean {
  return left.providerId === right.providerId
    && left.domainId === right.domainId
    && left.epoch === right.epoch
    && left.stateHash.length === right.stateHash.length
    && left.stateHash.every((byte, index) => byte === right.stateHash[index]);
}

export function cloneProviderPublicTransitionV2(
  transition: ProviderPublicTransitionV2,
): ProviderPublicTransitionV2 {
  if (
    transition.operation !== "add"
    && transition.operation !== "remove"
    && transition.operation !== "update"
  ) {
    throw new ProviderCandidateStateError(
      "Provider transition operation is invalid",
    );
  }
  return Object.freeze({
    formatVersion: V2_PROVIDER_TRANSITION_FORMAT_VERSION,
    providerId: transition.providerId,
    domainId: transition.domainId,
    operation: transition.operation,
    targetHumanId: humanId(transition.targetHumanId),
    targetDeviceId: cryptoDeviceId(transition.targetDeviceId),
    expectedHead: cloneProviderHeadV2(transition.expectedHead),
    nextHead: cloneProviderHeadV2(transition.nextHead),
    commitBytes: copyOwnedBytesV2(transition.commitBytes),
    welcomeHash: copyOwnedBytesV2(transition.welcomeHash),
    welcomeBytes: copyOwnedBytesV2(transition.welcomeBytes),
    rosterBytes: copyOwnedBytesV2(transition.rosterBytes),
  });
}

const PUBLIC_TRANSITION_FIELDS = Object.freeze([
  "formatVersion",
  "providerId",
  "domainId",
  "operation",
  "targetHumanId",
  "targetDeviceId",
  "expectedHead",
  "nextHead",
  "commitBytes",
  "welcomeHash",
  "welcomeBytes",
  "rosterBytes",
].sort());
const PUBLIC_HEAD_FIELDS = Object.freeze([
  "providerId",
  "domainId",
  "epoch",
  "stateHash",
].sort());
const PROVIDER_ROSTER_DOMAINS = Object.freeze({
  "openmls-v2": "nautilo/lattice-crypto/openmls-roster/v2",
  "ts-mls-v2": "nautilo/lattice-crypto/ts-mls-roster/v2",
} as const);

function exactRecord(
  label: string,
  value: unknown,
  fields: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().some(
      (field, index) => field !== fields[index],
    )
    || Object.keys(value).length !== fields.length
  ) {
    throw new ProviderCandidateStateError(
      `${label} fields are invalid`,
    );
  }
}

function validatePublicHead(
  value: unknown,
  label: string,
): ProviderPublicHeadV2 {
  exactRecord(label, value, PUBLIC_HEAD_FIELDS);
  const providerId = value["providerId"];
  const rawDomainId = value["domainId"];
  const rawEpoch = value["epoch"];
  const stateHash = value["stateHash"];
  if (typeof providerId !== "string") {
    throw new ProviderCandidateStateError(
      `${label} provider id is invalid`,
    );
  }
  assertPortableId(`${label} provider id`, providerId);
  if (typeof rawDomainId !== "string") {
    throw new ProviderCandidateStateError(
      `${label} Domain id is invalid`,
    );
  }
  if (typeof rawEpoch !== "number") {
    throw new ProviderCandidateStateError(
      `${label} epoch is invalid`,
    );
  }
  return cloneProviderHeadV2({
    providerId,
    domainId: cryptoDomainId(rawDomainId),
    epoch: domainEpoch(rawEpoch),
    stateHash: exactHeadHash(`${label} hash`, stateHash as Uint8Array),
  });
}

/**
 * Strict runtime validation for a client-produced public provider transition.
 * This checks the complete public wire shape and coordinates, but intentionally
 * does not claim that the server can cryptographically process an MLS commit.
 * Authorized recipient devices perform that stateful validation locally.
 */
export function validateProviderPublicTransitionV2(
  value: unknown,
): ProviderPublicTransitionV2 {
  exactRecord(
    "Provider public transition",
    value,
    PUBLIC_TRANSITION_FIELDS,
  );
  const providerId = value["providerId"];
  const rawDomainId = value["domainId"];
  const operation = value["operation"];
  const rawTargetHumanId = value["targetHumanId"];
  const rawTargetDeviceId = value["targetDeviceId"];
  if (
    value["formatVersion"] !== V2_PROVIDER_TRANSITION_FORMAT_VERSION
    || typeof providerId !== "string"
    || typeof rawDomainId !== "string"
    || typeof rawTargetHumanId !== "string"
    || typeof rawTargetDeviceId !== "string"
    || (
      operation !== "add"
      && operation !== "remove"
      && operation !== "update"
    )
  ) {
    throw new ProviderCandidateStateError(
      "Provider public transition fields are invalid",
    );
  }
  assertPortableId("Provider id", providerId);
  const domainId = cryptoDomainId(rawDomainId);
  const expectedHead = validatePublicHead(
    value["expectedHead"],
    "Provider expected head",
  );
  const nextHead = validatePublicHead(
    value["nextHead"],
    "Provider next head",
  );
  if (
    expectedHead.providerId !== providerId
    || nextHead.providerId !== providerId
    || expectedHead.domainId !== domainId
    || nextHead.domainId !== domainId
  ) {
    throw new ProviderCandidateStateError(
      "Provider public transition coordinates are invalid",
    );
  }
  if (nextHead.epoch !== expectedHead.epoch + 1) {
    throw new ProviderCandidateStateError(
      "Provider public transition epoch must advance exactly once",
    );
  }
  const commitBytes = value["commitBytes"];
  const welcomeHash = value["welcomeHash"];
  const welcomeBytes = value["welcomeBytes"];
  const rosterBytes = value["rosterBytes"];
  if (
    !(commitBytes instanceof Uint8Array)
    || commitBytes.length < 1
    || commitBytes.length > V2_PROVIDER_STATE_MAX_BYTES
  ) {
    throw new ProviderCandidateStateError(
      "Provider public transition commit bytes are invalid",
    );
  }
  if (
    !(welcomeHash instanceof Uint8Array)
    || welcomeHash.length !== HEAD_HASH_BYTES
  ) {
    throw new ProviderCandidateStateError(
      "Provider public transition Welcome hash is invalid",
    );
  }
  if (
    !(welcomeBytes instanceof Uint8Array)
    || welcomeBytes.length > V2_PROVIDER_STATE_MAX_BYTES
  ) {
    throw new ProviderCandidateStateError(
      "Provider public transition Welcome bytes are invalid",
    );
  }
  if (
    !(rosterBytes instanceof Uint8Array)
    || rosterBytes.length < 1
    || rosterBytes.length > V2_LIMITS.namespaceKeyringBytes
  ) {
    throw new ProviderCandidateStateError(
      "Provider public transition roster bytes are invalid",
    );
  }
  return cloneProviderPublicTransitionV2({
    formatVersion: V2_PROVIDER_TRANSITION_FORMAT_VERSION,
    providerId,
    domainId,
    operation,
    targetHumanId: humanId(rawTargetHumanId),
    targetDeviceId: cryptoDeviceId(rawTargetDeviceId),
    expectedHead,
    nextHead,
    commitBytes,
    welcomeHash,
    welcomeBytes,
    rosterBytes,
  });
}

/**
 * Remove target-only Welcome material while preserving the authenticated
 * public transition commitment used by existing Domain members.
 */
export function redactProviderWelcomeV2(
  transition: ProviderPublicTransitionV2,
): ProviderPublicTransitionV2 {
  const canonical = validateProviderPublicTransitionV2(transition);
  return cloneProviderPublicTransitionV2({
    ...canonical,
    welcomeBytes: new Uint8Array(),
  });
}

/**
 * Decode the canonical public roster formats emitted by the two production v2
 * providers. The dummy provider is deliberately excluded because its testing
 * roster has no authenticated leaf indices.
 */
export function decodeProviderRosterV2(
  providerId: string,
  rosterBytes: Uint8Array,
): readonly ProviderRosterEntryV2[] {
  assertPortableId("Provider id", providerId);
  const rosterDomain =
    PROVIDER_ROSTER_DOMAINS[
      providerId as keyof typeof PROVIDER_ROSTER_DOMAINS
    ];
  if (rosterDomain === undefined) {
    throw new ProviderCandidateStateError(
      `Provider roster format ${providerId} is not supported`,
    );
  }
  if (
    !(rosterBytes instanceof Uint8Array)
    || rosterBytes.length < 1
    || rosterBytes.length > V2_LIMITS.namespaceKeyringBytes
  ) {
    throw new ProviderCandidateStateError(
      "Provider roster bytes are invalid",
    );
  }
  return decodeExact(rosterBytes, (reader) => {
    if (reader.readText(V2_LIMITS.idBytes) !== rosterDomain) {
      throw new ProviderCandidateStateError(
        "Provider roster domain is invalid",
      );
    }
    const count = reader.readCount(V2_LIMITS.deviceLeavesPerDomain);
    const entries: ProviderRosterEntryV2[] = [];
    const devices = new Set<string>();
    const leaves = new Set<number>();
    const humans = new Set<string>();
    let previousLeaf = -1;
    for (let index = 0; index < count; index += 1) {
      const leafIndex = reader.readU32();
      if (leafIndex >= V2_LIMITS.deviceLeavesPerDomain) {
        throw new ProviderCandidateStateError(
          "Provider roster leaf index is out of bounds",
        );
      }
      const entry = Object.freeze({
        leafIndex,
        humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
        deviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      });
      if (
        devices.has(entry.deviceId)
        || leaves.has(entry.leafIndex)
      ) {
        throw new ProviderCandidateStateError(
          "Provider roster contains a duplicate identity",
        );
      }
      if (entry.leafIndex <= previousLeaf) {
        throw new ProviderCandidateStateError(
          "Provider roster is not in canonical leaf order",
        );
      }
      previousLeaf = entry.leafIndex;
      devices.add(entry.deviceId);
      leaves.add(entry.leafIndex);
      humans.add(entry.humanId);
      entries.push(entry);
    }
    if (humans.size > V2_LIMITS.humanParticipantsPerDomain) {
      throw new ProviderCandidateStateError(
        "Provider roster exceeds the Human limit",
      );
    }
    return Object.freeze(entries);
  });
}

function exactHeadHash(
  label: string,
  value: Uint8Array,
): Uint8Array {
  if (
    !(value instanceof Uint8Array)
    || value.length !== HEAD_HASH_BYTES
  ) {
    throw new ProviderCandidateStateError(
      `${label} must be exactly ${HEAD_HASH_BYTES} bytes`,
    );
  }
  return value;
}

function encodeHead(head: ProviderPublicHeadV2): Uint8Array {
  assertPortableId("Provider id", head.providerId);
  cryptoDomainId(head.domainId);
  domainEpoch(head.epoch);
  return concatV2(
    frameText(head.providerId),
    frameText(head.domainId),
    encodeU64(head.epoch),
    frame(exactHeadHash("Provider head hash", head.stateHash)),
  );
}

function decodeHead(reader: StrictDecoder): ProviderPublicHeadV2 {
  return cloneProviderHeadV2({
    providerId: reader.readText(V2_LIMITS.idBytes),
    domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
    epoch: domainEpoch(reader.readU64()),
    stateHash: exactHeadHash(
      "Provider head hash",
      reader.readFrame(HEAD_HASH_BYTES),
    ),
  });
}

export function providerPublicTransitionDigestV2(
  crypto: LatticeCrypto,
  transition: ProviderPublicTransitionV2,
): Uint8Array {
  return copyOwnedBytesV2(crypto.hash(concatV2(
    frameText(PUBLIC_TRANSITION_DIGEST_DOMAIN),
    encodeU32(transition.formatVersion),
    frameText(transition.providerId),
    frameText(transition.domainId),
    frameText(transition.operation),
    frameText(transition.targetHumanId),
    frameText(transition.targetDeviceId),
    encodeHead(transition.expectedHead),
    encodeHead(transition.nextHead),
    frame(transition.commitBytes),
    frame(transition.welcomeHash),
    frame(transition.rosterBytes),
  )));
}

export function providerPublicTransitionDigestMatchesV2(
  crypto: LatticeCrypto,
  transition: ProviderPublicTransitionV2,
  expectedDigest: Uint8Array,
): boolean {
  const actualDigest = providerPublicTransitionDigestV2(crypto, transition);
  return actualDigest.length === expectedDigest.length
    && actualDigest.every(
      (byte, index) => byte === expectedDigest[index],
    );
}

function lifecycleCode(
  lifecycle: ProviderCandidateLifecycleV2,
): number {
  switch (lifecycle) {
    case "prepared":
      return 0;
    case "applied":
      return 1;
    case "aborted":
      return 2;
    case "stale":
      return 3;
  }
}

function lifecycleFromCode(
  code: number,
): ProviderCandidateLifecycleV2 {
  switch (code) {
    case 0:
      return "prepared";
    case 1:
      return "applied";
    case 2:
      return "aborted";
    case 3:
      return "stale";
    default:
      throw new ProviderCandidateStateError(
        "Sealed candidate lifecycle is invalid",
      );
  }
}

function encodeCandidateState(input: {
  readonly candidateId: string;
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly deviceId: CryptoDeviceId;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly nextHead: ProviderPublicHeadV2;
  readonly publicTransitionDigest: Uint8Array;
  readonly sourceId: string;
  readonly lifecycle: ProviderCandidateLifecycleV2;
  readonly payload: Uint8Array;
}): Uint8Array {
  return concatV2(
    frameText(CANDIDATE_STATE_DOMAIN),
    encodeU32(CANDIDATE_STATE_FORMAT_VERSION),
    frameText(input.candidateId),
    frameText(input.providerId),
    frameText(input.domainId),
    frameText(input.deviceId),
    frameText(input.sourceId),
    encodeU32(lifecycleCode(input.lifecycle)),
    encodeHead(input.expectedHead),
    encodeHead(input.nextHead),
    frame(input.publicTransitionDigest),
    frame(input.payload),
  );
}

function candidateId(input: {
  readonly crypto: LatticeCrypto;
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly deviceId: CryptoDeviceId;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly nextHead: ProviderPublicHeadV2;
  readonly publicTransitionDigest: Uint8Array;
  readonly sourceId: string;
}): string {
  const digest = input.crypto.hash(concatV2(
    frameText(CANDIDATE_ID_DOMAIN),
    frameText(input.providerId),
    frameText(input.domainId),
    frameText(input.deviceId),
    frameText(input.sourceId),
    encodeHead(input.expectedHead),
    encodeHead(input.nextHead),
    frame(input.publicTransitionDigest),
  ));
  return `candidate_${Array.from(
    digest.subarray(0, 16),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

/**
 * Seal the complete candidate identity and its nested provider snapshot.
 * Candidate ids deliberately do not depend on randomized vault ciphertext.
 */
export function sealLocalProviderCandidateV2(input: {
  readonly crypto: LatticeCrypto;
  readonly vault: DeviceProviderStateVaultV2;
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly nextHead: ProviderPublicHeadV2;
  readonly publicTransition: ProviderPublicTransitionV2;
  readonly payload: Uint8Array;
  readonly sourceId?: string;
}): LocalProviderCandidateV2 {
  const sourceId = input.sourceId ?? V2_PROVIDER_CANDIDATE_SOURCE_ID;
  assertPortableId("Candidate source id", sourceId);
  if (
    input.publicTransition.formatVersion
      !== V2_PROVIDER_TRANSITION_FORMAT_VERSION
    || input.publicTransition.providerId !== input.providerId
    || input.publicTransition.domainId !== input.domainId
    || !providerHeadsEqualV2(
      input.publicTransition.expectedHead,
      input.expectedHead,
    )
    || !providerHeadsEqualV2(
      input.publicTransition.nextHead,
      input.nextHead,
    )
  ) {
    throw new ProviderCandidateStateError(
      "Provider candidate transition coordinates differ",
    );
  }
  const publicTransitionDigest = providerPublicTransitionDigestV2(
    input.crypto,
    input.publicTransition,
  );
  if (publicTransitionDigest.length !== PUBLIC_TRANSITION_DIGEST_BYTES) {
    throw new ProviderCandidateStateError(
      `Provider public transition digest must be exactly ${
        PUBLIC_TRANSITION_DIGEST_BYTES
      } bytes`,
    );
  }
  const id = candidateId({
    crypto: input.crypto,
    providerId: input.providerId,
    domainId: input.domainId,
    deviceId: input.vault.deviceId,
    expectedHead: input.expectedHead,
    nextHead: input.nextHead,
    publicTransitionDigest,
    sourceId,
  });
  const plaintext = encodeCandidateState({
    candidateId: id,
    providerId: input.providerId,
    domainId: input.domainId,
    deviceId: input.vault.deviceId,
    expectedHead: input.expectedHead,
    nextHead: input.nextHead,
    publicTransitionDigest,
    sourceId,
    lifecycle: "prepared",
    payload: input.payload,
  });
  try {
    const snapshot = input.vault.seal(
      {
        providerId: input.providerId,
        domainId: input.domainId,
        revision: input.nextHead.epoch,
        snapshotKind: "candidate",
      },
      plaintext,
    );
    return Object.freeze({
      candidateId: id,
      providerId: input.providerId,
      domainId: input.domainId,
      deviceId: input.vault.deviceId,
      expectedHead: cloneProviderHeadV2(input.expectedHead),
      nextHead: cloneProviderHeadV2(input.nextHead),
      publicTransitionDigest:
        copyOwnedBytesV2(publicTransitionDigest),
      snapshot,
    });
  } finally {
    plaintext.fill(0);
  }
}

export function openLocalProviderCandidateV2(input: {
  readonly vault: DeviceProviderStateVaultV2;
  readonly candidate: LocalProviderCandidateV2;
}): OpenedProviderCandidateStateV2 {
  const { candidate, vault } = input;
  if (
    candidate.providerId !== candidate.expectedHead.providerId
    || candidate.providerId !== candidate.nextHead.providerId
    || candidate.domainId !== candidate.expectedHead.domainId
    || candidate.domainId !== candidate.nextHead.domainId
    || candidate.deviceId !== vault.deviceId
    || candidate.snapshot.providerId !== candidate.providerId
    || candidate.snapshot.domainId !== candidate.domainId
    || candidate.snapshot.deviceId !== candidate.deviceId
    || candidate.snapshot.revision !== candidate.nextHead.epoch
    || candidate.snapshot.snapshotKind !== "candidate"
    || !(candidate.publicTransitionDigest instanceof Uint8Array)
    || candidate.publicTransitionDigest.length
      !== PUBLIC_TRANSITION_DIGEST_BYTES
  ) {
    throw new ProviderCandidateStateError(
      "External candidate coordinates are invalid",
    );
  }
  const plaintext = vault.open(candidate.snapshot, {
    providerId: candidate.providerId,
    domainId: candidate.domainId,
    revision: candidate.nextHead.epoch,
    snapshotKind: "candidate",
  });
  if (!plaintext) {
    throw new ProviderCandidateStateError(
      "Unable to open sealed candidate state",
    );
  }
  try {
    const decoded = decodeExact(plaintext, (reader) => {
      if (
        reader.readText(CANDIDATE_STATE_DOMAIN.length)
        !== CANDIDATE_STATE_DOMAIN
      ) {
        throw new ProviderCandidateStateError(
          "Sealed candidate domain is invalid",
        );
      }
      reader.readVersion(CANDIDATE_STATE_FORMAT_VERSION);
      return {
        candidateId: reader.readText(V2_LIMITS.idBytes),
        providerId: reader.readText(V2_LIMITS.idBytes),
        domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
        deviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
        sourceId: reader.readText(V2_LIMITS.idBytes),
        lifecycle: lifecycleFromCode(reader.readU32()),
        expectedHead: decodeHead(reader),
        nextHead: decodeHead(reader),
        publicTransitionDigest: exactHeadHash(
          "Provider public transition digest",
          reader.readFrame(PUBLIC_TRANSITION_DIGEST_BYTES),
        ),
        payload: reader.readFrame(V2_PROVIDER_STATE_MAX_BYTES),
      };
    });
    if (
      decoded.candidateId !== candidate.candidateId
      || decoded.providerId !== candidate.providerId
      || decoded.domainId !== candidate.domainId
      || decoded.deviceId !== candidate.deviceId
      || !providerHeadsEqualV2(
        decoded.expectedHead,
        candidate.expectedHead,
      )
      || !providerHeadsEqualV2(decoded.nextHead, candidate.nextHead)
      || !decoded.publicTransitionDigest.every(
        (byte, index) => byte === candidate.publicTransitionDigest[index],
      )
    ) {
      decoded.payload.fill(0);
      decoded.publicTransitionDigest.fill(0);
      throw new ProviderCandidateStateError(
        "External candidate does not match its sealed candidate identity",
      );
    }
    return Object.freeze({
      lifecycle: decoded.lifecycle,
      sourceId: decoded.sourceId,
      publicTransitionDigest: decoded.publicTransitionDigest,
      payload: decoded.payload,
    });
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Reconstruct the nested sealed provider snapshot carried by a prepared
 * candidate. The returned ciphertext is detached and should be zeroed after
 * opening.
 */
export function candidatePayloadSnapshotV2(
  candidate: LocalProviderCandidateV2,
  payload: Uint8Array,
): SealedProviderStateV2 {
  return Object.freeze({
    classification: "device-local-provider-ciphertext" as const,
    formatVersion: V2_PROVIDER_STATE_FORMAT_VERSION,
    providerId: candidate.providerId,
    domainId: candidate.domainId,
    deviceId: candidate.deviceId,
    revision: candidate.nextHead.epoch,
    snapshotKind: "candidate" as const,
    ciphertext: copyOwnedBytesV2(payload),
  }) as SealedProviderStateV2;
}

/**
 * Replace candidate payload with an authenticated fixed-size tombstone.
 * Ciphertext remains persistable and bounded; no process-local id set grows.
 */
export function markLocalProviderCandidateV2(input: {
  readonly vault: DeviceProviderStateVaultV2;
  readonly candidate: LocalProviderCandidateV2;
  readonly lifecycle: Exclude<
    ProviderCandidateLifecycleV2,
    "prepared"
  >;
}): void {
  const opened = openLocalProviderCandidateV2(input);
  try {
    const zeroPayload = new Uint8Array(opened.payload.length);
    const plaintext = encodeCandidateState({
      candidateId: input.candidate.candidateId,
      providerId: input.candidate.providerId,
      domainId: input.candidate.domainId,
      deviceId: input.candidate.deviceId,
      expectedHead: input.candidate.expectedHead,
      nextHead: input.candidate.nextHead,
      publicTransitionDigest: opened.publicTransitionDigest,
      sourceId: opened.sourceId,
      lifecycle: input.lifecycle,
      payload: zeroPayload,
    });
    try {
      const tombstone = input.vault.seal(
        {
          providerId: input.candidate.providerId,
          domainId: input.candidate.domainId,
          revision: input.candidate.nextHead.epoch,
          snapshotKind: "candidate",
        },
        plaintext,
      );
      if (
        tombstone.ciphertext.length
        !== input.candidate.snapshot.ciphertext.length
      ) {
        throw new ProviderCandidateStateError(
          "Candidate tombstone length changed unexpectedly",
        );
      }
      input.candidate.snapshot.ciphertext.set(tombstone.ciphertext);
    } finally {
      plaintext.fill(0);
      zeroPayload.fill(0);
    }
  } finally
  // exported destroy helper's exact wipe is tested directly; this call is the
  // ownership boundary but its mutation cannot be observed without weakening
  // the encapsulation that keeps opened provider state local.
  {
    destroyOpenedProviderCandidateStateV2(opened);
  }
}
