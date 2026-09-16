import {
  DeviceProviderStateVault,
  OpenMlsGroupProvider,
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  objectId,
  providerHeadsEqual,
  restoreSealedProviderState,
  type DomainRoots,
  type LatticeCrypto,
  type TrustedMinimumObjectAccessHead,
} from "@nautilo/lattice-crypto";
import type {
  ProviderPublicHeadV2 as ProviderPublicHead,
  SealedProviderStateV2 as SealedProviderState,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfile,
  createClientDeviceProfileV2Candidate,
  destroyOpenedClientDeviceProfile,
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "./profile-v2.ts";
import type {
  ClientProfileCoordinates,
  ClientProfilePublicState,
  ClientProfileVault,
} from "./types.ts";
import { CLIENT_PROFILE_VAULT_MAX_BYTES } from "./types.ts";

export const CLIENT_DEVICE_PROFILE_V3_DOMAIN =
  "nautilo/client-device-profile/v3" as const;
export const CLIENT_DEVICE_PROFILE_MAX_PROVIDER_SNAPSHOTS = 256 as const;
export const CLIENT_DEVICE_PROFILE_MAX_OBJECT_ACCESS_ANCHORS = 4_096 as const;

const MAX_BYTES = CLIENT_PROFILE_VAULT_MAX_BYTES;
const KEY_BYTES = 32;
const HASH_BYTES = 32;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

export interface ClientDomainProviderSnapshotV3 {
  readonly providerId: string;
  readonly domainId: string;
  readonly epoch: number;
  readonly stateHash: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export interface OpenedClientDeviceProfileV3 {
  readonly formatVersion: 3;
  readonly baseProfile: OpenedClientDeviceProfileV2;
  readonly providerStateSealingKey: Uint8Array;
  readonly activeProviderSnapshots: readonly ClientDomainProviderSnapshotV3[];
  readonly objectAccessAnchors: readonly TrustedMinimumObjectAccessHead[];
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Client profile v3 counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Client profile v3 counter is unsafe");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function frame(value: Uint8Array): Uint8Array { return concat([u32(value.length), value]); }
function text(value: string): Uint8Array { return frame(new TextEncoder().encode(value)); }

function portable(label: string, value: string): string {
  if (typeof value !== "string" || !PORTABLE.test(value)) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
  return value;
}

function exact(label: string, value: Uint8Array, length?: number): Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) {
    throw new RangeError(`${label} has invalid bytes`);
  }
  return value.slice();
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasProfileDomain(bytes: Uint8Array, domain: string): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return false;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(0);
  if (length !== domain.length || 4 + length > bytes.length) return false;
  return new TextDecoder().decode(bytes.subarray(4, 4 + length)) === domain;
}

function canonicalSnapshots(
  snapshots: readonly ClientDomainProviderSnapshotV3[],
): readonly ClientDomainProviderSnapshotV3[] {
  if (snapshots.length > CLIENT_DEVICE_PROFILE_MAX_PROVIDER_SNAPSHOTS) {
    throw new RangeError("Client provider snapshot inventory exceeds its bound");
  }
  const result = snapshots.map((snapshot) => Object.freeze({
    providerId: portable("Provider", snapshot.providerId),
    domainId: portable("Crypto Domain", snapshot.domainId),
    epoch: domainEpoch(snapshot.epoch),
    stateHash: exact("Provider state hash", snapshot.stateHash, HASH_BYTES),
    ciphertext: exact("Provider ciphertext", snapshot.ciphertext),
  })).sort((left, right) => compare(left.domainId, right.domainId));
  if (result.some((entry, index) => index > 0 && result[index - 1]!.domainId === entry.domainId)) {
    result.forEach(destroySnapshot);
    throw new TypeError("Client provider snapshots must contain one current head per Domain");
  }
  return Object.freeze(result);
}

function destroyAnchor(anchor: TrustedMinimumObjectAccessHead): void {
  anchor.payloadHash.fill(0);
  anchor.manifestHash.fill(0);
}

function canonicalAnchors(
  anchors: readonly TrustedMinimumObjectAccessHead[],
): readonly TrustedMinimumObjectAccessHead[] {
  if (anchors.length > CLIENT_DEVICE_PROFILE_MAX_OBJECT_ACCESS_ANCHORS) {
    throw new RangeError("Client object access anchor inventory exceeds its bound");
  }
  const result = anchors.map((anchor) => Object.freeze({
    objectId: objectId(portable("Client object access anchor", anchor.objectId)),
    payloadHash: exact("Client object payload hash", anchor.payloadHash, HASH_BYTES),
    accessRevision: accessRevision(anchor.accessRevision),
    manifestHash: exact("Client object manifest hash", anchor.manifestHash, HASH_BYTES),
  })).sort((left, right) => compare(left.objectId, right.objectId));
  if (result.some((entry, index) => index > 0
    && result[index - 1]!.objectId === entry.objectId)) {
    result.forEach(destroyAnchor);
    throw new TypeError("Client object access anchors must be unique");
  }
  return Object.freeze(result);
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  u32(): number {
    if (this.offset + 4 > this.bytes.length) throw new RangeError("Client profile v3 is truncated");
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
      .getUint32(this.offset);
    this.offset += 4;
    return value;
  }
  u64(): number {
    if (this.offset + 8 > this.bytes.length) throw new RangeError("Client profile v3 is truncated");
    const value = Number(new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
      .getBigUint64(this.offset));
    this.offset += 8;
    if (!Number.isSafeInteger(value)) throw new RangeError("Client profile v3 counter is unsafe");
    return value;
  }
  frame(max = MAX_BYTES): Uint8Array {
    const length = this.u32();
    if (length > max || this.offset + length > this.bytes.length) {
      throw new RangeError("Client profile v3 frame is invalid");
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  text(): string {
    const bytes = this.frame(128);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    finally { bytes.fill(0); }
  }
  finish(): void {
    if (this.offset !== this.bytes.length) throw new RangeError("Client profile v3 has trailing bytes");
  }
}

function destroySnapshot(snapshot: ClientDomainProviderSnapshotV3): void {
  snapshot.stateHash.fill(0);
  snapshot.ciphertext.fill(0);
}

export function destroyOpenedClientDeviceProfileV3(profile: OpenedClientDeviceProfileV3): void {
  destroyOpenedClientDeviceProfile(profile.baseProfile);
  profile.providerStateSealingKey.fill(0);
  profile.activeProviderSnapshots.forEach(destroySnapshot);
  profile.objectAccessAnchors.forEach(destroyAnchor);
}

export function encodeClientDeviceProfileV3(input: OpenedClientDeviceProfileV3): Uint8Array {
  const key = exact("Provider state sealing key", input.providerStateSealingKey, KEY_BYTES);
  const baseBytes = encodeClientDeviceProfileV2(input.baseProfile);
  const snapshots = canonicalSnapshots(input.activeProviderSnapshots);
  const anchors = canonicalAnchors(input.objectAccessAnchors);
  const parts: Uint8Array[] = [text(CLIENT_DEVICE_PROFILE_V3_DOMAIN), frame(baseBytes), frame(key), u32(snapshots.length)];
  try {
    for (const snapshot of snapshots) {
      parts.push(text(snapshot.providerId), text(snapshot.domainId), u64(snapshot.epoch),
        frame(snapshot.stateHash), frame(snapshot.ciphertext));
    }
    parts.push(u32(anchors.length));
    for (const anchor of anchors) {
      parts.push(text(anchor.objectId), frame(anchor.payloadHash),
        u64(anchor.accessRevision), frame(anchor.manifestHash));
    }
    const bytes = concat(parts);
    if (bytes.length > MAX_BYTES) { bytes.fill(0); throw new RangeError("Client profile v3 exceeds its byte bound"); }
    return bytes;
  } finally {
    key.fill(0); baseBytes.fill(0); parts.forEach((part) => part.fill(0));
    snapshots.forEach(destroySnapshot);
    anchors.forEach(destroyAnchor);
  }
}

export async function authenticateClientDeviceProfileV3(input: Readonly<{
  crypto: LatticeCrypto;
  profileBytes: Uint8Array;
  expectedDeviceId: string;
}>): Promise<OpenedClientDeviceProfileV3> {
  if (!(input.profileBytes instanceof Uint8Array) || input.profileBytes.length < 1 || input.profileBytes.length > MAX_BYTES) {
    throw new RangeError("Client profile v3 bytes are invalid");
  }
  const reader = new Reader(input.profileBytes);
  if (reader.text() !== CLIENT_DEVICE_PROFILE_V3_DOMAIN) throw new TypeError("Client profile v3 is unavailable");
  const baseBytes = reader.frame();
  let base: OpenedClientDeviceProfileV2 | undefined;
  let key: Uint8Array | undefined;
  let snapshots: readonly ClientDomainProviderSnapshotV3[] = [];
  let anchors: readonly TrustedMinimumObjectAccessHead[] = [];
  try {
    const opened = await authenticateClientDeviceProfile({
      crypto: input.crypto, profileBytes: baseBytes, expectedDeviceId: input.expectedDeviceId,
    });
    if (opened.formatVersion !== 2) { destroyOpenedClientDeviceProfile(opened); throw new TypeError("Client profile v3 requires a v2 base"); }
    base = opened;
    key = reader.frame(KEY_BYTES);
    if (key.length !== KEY_BYTES) throw new RangeError("Provider state sealing key must be 32 bytes");
    const count = reader.u32();
    if (count > CLIENT_DEVICE_PROFILE_MAX_PROVIDER_SNAPSHOTS) throw new RangeError("Client provider snapshot inventory exceeds its bound");
    const decoded = Array.from({ length: count }, () => ({
      providerId: reader.text(), domainId: reader.text(), epoch: reader.u64(),
      stateHash: reader.frame(HASH_BYTES), ciphertext: reader.frame(),
    }));
    snapshots = canonicalSnapshots(decoded);
    decoded.forEach(destroySnapshot);
    const anchorCount = reader.u32();
    if (anchorCount > CLIENT_DEVICE_PROFILE_MAX_OBJECT_ACCESS_ANCHORS) {
      throw new RangeError("Client object access anchor inventory exceeds its bound");
    }
    const decodedAnchors = Array.from({ length: anchorCount }, () => ({
      objectId: objectId(reader.text()),
      payloadHash: reader.frame(HASH_BYTES),
      accessRevision: accessRevision(reader.u64()),
      manifestHash: reader.frame(HASH_BYTES),
    }));
    reader.finish();
    anchors = canonicalAnchors(decodedAnchors);
    decodedAnchors.forEach(destroyAnchor);
    return Object.freeze({ formatVersion: 3 as const, baseProfile: base,
      providerStateSealingKey: key, activeProviderSnapshots: snapshots,
      objectAccessAnchors: anchors });
  } catch (error) {
    if (base) destroyOpenedClientDeviceProfile(base);
    key?.fill(0); snapshots.forEach(destroySnapshot);
    anchors.forEach(destroyAnchor);
    throw error;
  } finally { baseBytes.fill(0); }
}

export async function createClientDeviceProfileV3Candidate(input: Readonly<{
  crypto: LatticeCrypto;
  currentProfileBytes: Uint8Array;
  expectedDeviceId: string;
  v1Migration?: Readonly<{
    trustedDeviceRevision: number;
    trustedHostAuthorizationRevision: number;
    deliveryHighWatermark: number;
  }>;
}>): Promise<OpenedClientDeviceProfileV3> {
  if (hasProfileDomain(input.currentProfileBytes, CLIENT_DEVICE_PROFILE_V3_DOMAIN)) {
    throw new TypeError(
      "Client profile is already v3; use the provider snapshot update lifecycle",
    );
  }
  let base: OpenedClientDeviceProfileV2 | undefined;
  const current = await authenticateClientDeviceProfile({
    crypto: input.crypto, profileBytes: input.currentProfileBytes,
    expectedDeviceId: input.expectedDeviceId,
  });
  try {
    if (current.formatVersion === 1) {
      if (input.v1Migration === undefined) throw new TypeError("Client profile v1 migration coordinates are required");
      base = await createClientDeviceProfileV2Candidate({
        crypto: input.crypto, v1ProfileBytes: input.currentProfileBytes,
        expectedDeviceId: input.expectedDeviceId, ...input.v1Migration,
      });
    } else {
      base = Object.freeze({ ...current,
        signingPublicKey: current.signingPublicKey.slice(), signingPrivateKey: current.signingPrivateKey.slice(),
        encryptionPublicKey: current.encryptionPublicKey.slice(), encryptionPrivateKey: current.encryptionPrivateKey.slice(),
        keyringDeliveries: current.keyringDeliveries.map((entry) => Object.freeze({ ...entry,
          bindingHash: entry.bindingHash.slice(), generations: entry.generations.map((g) => Object.freeze({ ...g, key: g.key.slice() })) })),
      });
    }
    return Object.freeze({ formatVersion: 3 as const, baseProfile: base,
      providerStateSealingKey: input.crypto.randomBytes(KEY_BYTES),
      activeProviderSnapshots: Object.freeze([]),
      objectAccessAnchors: Object.freeze([]) });
  } finally { destroyOpenedClientDeviceProfile(current); }
}

export async function withClientDomainRoots<T>(input: Readonly<{
  crypto: LatticeCrypto;
  profile: OpenedClientDeviceProfileV3;
  expectedHead: ProviderPublicHead;
  operation(roots: DomainRoots): Promise<T> | T;
}>): Promise<T> {
  const record = input.profile.activeProviderSnapshots.find((entry) => entry.domainId === input.expectedHead.domainId);
  if (record === undefined) throw new Error("Client Domain provider snapshot is unavailable");
  const vault = DeviceProviderStateVault.fromKey(input.crypto,
    cryptoDeviceId(input.profile.baseProfile.deviceId), input.profile.providerStateSealingKey);
  const active = restoreSealedProviderState({ providerId: record.providerId,
    domainId: cryptoDomainId(record.domainId), deviceId: cryptoDeviceId(input.profile.baseProfile.deviceId),
    revision: domainEpoch(record.epoch), snapshotKind: "active", ciphertext: record.ciphertext });
  const provider = new OpenMlsGroupProvider(input.crypto, vault);
  let roots: DomainRoots | undefined;
  try {
    await provider.initialize();
    const actual = provider.publicHead(active);
    if (!providerHeadsEqual(actual, input.expectedHead)
      || !actual.stateHash.every((byte, index) => byte === record.stateHash[index])) {
      actual.stateHash.fill(0);
      throw new Error("Client Domain provider snapshot does not match the exact current head");
    }
    actual.stateHash.fill(0);
    roots = await provider.exportDomainRoots(active);
    return await input.operation(roots);
  } finally {
    roots?.human.fill(0); roots?.ai.fill(0); active.ciphertext.fill(0); vault.destroy();
  }
}

export async function addClientDomainProviderSnapshot(input: Readonly<{
  crypto: LatticeCrypto;
  profile: OpenedClientDeviceProfileV3;
  snapshot: SealedProviderState;
  expectedHead: ProviderPublicHead;
}>): Promise<OpenedClientDeviceProfileV3> {
  if (input.snapshot.snapshotKind !== "active"
    || input.snapshot.deviceId !== input.profile.baseProfile.deviceId
    || input.snapshot.providerId !== input.expectedHead.providerId
    || input.snapshot.domainId !== input.expectedHead.domainId
    || input.snapshot.revision !== input.expectedHead.epoch) {
    throw new Error("Delivered provider snapshot coordinates do not match the expected head");
  }
  const record = Object.freeze({ providerId: input.snapshot.providerId, domainId: input.snapshot.domainId,
    epoch: input.snapshot.revision, stateHash: input.expectedHead.stateHash.slice(), ciphertext: input.snapshot.ciphertext.slice() });
  const existing = input.profile.activeProviderSnapshots.find((entry) => entry.domainId === record.domainId);
  if (existing && (existing.epoch > record.epoch
    || (existing.epoch === record.epoch && (!existing.stateHash.every((b, i) => b === record.stateHash[i])
      || !existing.ciphertext.every((b, i) => b === record.ciphertext[i]))))) {
    destroySnapshot(record); throw new Error("Client provider snapshot rollback or substitution was detected");
  }
  const candidate = Object.freeze({ formatVersion: 3 as const, baseProfile: input.profile.baseProfile,
    providerStateSealingKey: input.profile.providerStateSealingKey,
    activeProviderSnapshots: Object.freeze([...input.profile.activeProviderSnapshots.filter((e) => e.domainId !== record.domainId), record]),
    objectAccessAnchors: input.profile.objectAccessAnchors });
  await withClientDomainRoots({ crypto: input.crypto, profile: candidate, expectedHead: input.expectedHead, operation: () => undefined });
  const candidateBytes = encodeClientDeviceProfileV3(candidate);
  try {
    return await authenticateClientDeviceProfileV3({ crypto: input.crypto,
      profileBytes: candidateBytes, expectedDeviceId: input.profile.baseProfile.deviceId });
  } finally { candidateBytes.fill(0); }
}

/**
 * Produces one fully detached authenticated v3 candidate while replacing only
 * selected top-level state. Keyring delivery can replace `baseProfile`; anchor
 * updates can replace `objectAccessAnchors`; omitted provider snapshots are
 * preserved exactly.
 */
export async function updateClientDeviceProfileV3(input: Readonly<{
  crypto: LatticeCrypto;
  profile: OpenedClientDeviceProfileV3;
  baseProfile?: OpenedClientDeviceProfileV2;
  objectAccessAnchors?: readonly TrustedMinimumObjectAccessHead[];
}>): Promise<OpenedClientDeviceProfileV3> {
  const candidateBytes = encodeClientDeviceProfileV3(Object.freeze({
    ...input.profile,
    baseProfile: input.baseProfile ?? input.profile.baseProfile,
    objectAccessAnchors:
      input.objectAccessAnchors ?? input.profile.objectAccessAnchors,
  }));
  try {
    return await authenticateClientDeviceProfileV3({ crypto: input.crypto,
      profileBytes: candidateBytes,
      expectedDeviceId: input.profile.baseProfile.deviceId });
  } finally { candidateBytes.fill(0); }
}

/** Atomically activates a previously constructed, authenticated v3 candidate. */
export async function stageAndActivateClientDeviceProfileV3(input: Readonly<{
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  stageId: string;
  generation: number;
  publicState: ClientProfilePublicState;
  candidate: OpenedClientDeviceProfileV3;
}>): Promise<void> {
  const candidateBytes = encodeClientDeviceProfileV3(input.candidate);
  try {
    await input.vault.stageProfile({ coordinates: input.coordinates,
      stageId: input.stageId, generation: input.generation,
      profileBytes: candidateBytes, publicState: input.publicState });
    await input.vault.activateProfile(input.coordinates, input.stageId);
  } finally { candidateBytes.fill(0); }
}

export async function replaceClientDeviceProfileWithV3(input: Readonly<{
  crypto: LatticeCrypto; vault: ClientProfileVault; coordinates: ClientProfileCoordinates;
  stageId: string; generation: number; publicState: ClientProfilePublicState;
  v1Migration?: Readonly<{ trustedDeviceRevision: number; trustedHostAuthorizationRevision: number; deliveryHighWatermark: number }>;
}>): Promise<void> {
  let candidate: OpenedClientDeviceProfileV3 | undefined;
  let bytes: Uint8Array | undefined;
  await input.vault.withOpenProfile(input.coordinates, async (currentProfileBytes) => {
    candidate = await createClientDeviceProfileV3Candidate({ crypto: input.crypto, currentProfileBytes,
      expectedDeviceId: input.coordinates.deviceId,
      ...(input.v1Migration === undefined ? {} : { v1Migration: input.v1Migration }) });
    bytes = encodeClientDeviceProfileV3(candidate);
  });
  try {
    await input.vault.stageProfile({ coordinates: input.coordinates, stageId: input.stageId,
      generation: input.generation, profileBytes: bytes!, publicState: input.publicState });
    await input.vault.activateProfile(input.coordinates, input.stageId);
  } finally { bytes?.fill(0); if (candidate) destroyOpenedClientDeviceProfileV3(candidate); }
}

/** Atomically stage and activate one authenticated current Domain snapshot. */
export async function stageAndActivateClientDomainProviderSnapshot(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  stageId: string;
  generation: number;
  publicState: ClientProfilePublicState;
  snapshot: SealedProviderState;
  expectedHead: ProviderPublicHead;
}>): Promise<void> {
  let candidateBytes: Uint8Array | undefined;
  await input.vault.withOpenProfile(input.coordinates, async (activeBytes) => {
    const active = await authenticateClientDeviceProfileV3({ crypto: input.crypto,
      profileBytes: activeBytes, expectedDeviceId: input.coordinates.deviceId });
    try {
      const candidate = await addClientDomainProviderSnapshot({ crypto: input.crypto,
        profile: active, snapshot: input.snapshot, expectedHead: input.expectedHead });
      try { candidateBytes = encodeClientDeviceProfileV3(candidate); }
      finally { destroyOpenedClientDeviceProfileV3(candidate); }
    } finally { destroyOpenedClientDeviceProfileV3(active); }
  });
  try {
    await input.vault.stageProfile({ coordinates: input.coordinates, stageId: input.stageId,
      generation: input.generation, profileBytes: candidateBytes!, publicState: input.publicState });
    await input.vault.activateProfile(input.coordinates, input.stageId);
  } finally { candidateBytes?.fill(0); }
}

function equalAnchor(
  left: TrustedMinimumObjectAccessHead | null,
  right: TrustedMinimumObjectAccessHead | null,
): boolean {
  return left === right || (left !== null && right !== null
    && left.objectId === right.objectId
    && left.accessRevision === right.accessRevision
    && left.payloadHash.every((byte, index) => byte === right.payloadHash[index])
    && left.manifestHash.every((byte, index) => byte === right.manifestHash[index]));
}

const anchorUpdateQueues = new WeakMap<object, Map<string, Promise<void>>>();

async function withAnchorUpdateLock<T>(
  vault: ClientProfileVault,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = anchorUpdateQueues.get(vault);
  if (queues === undefined) {
    queues = new Map();
    anchorUpdateQueues.set(vault, queues);
  }
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  queues.set(key, queued);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (queues.get(key) === queued) queues.delete(key);
  }
}

/** Shared authenticated rollback-anchor staging/CAS; codecs preserve the full profile. */
export function createClientProfileObjectAccessAnchorPortOwner<Profile>(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  createStageId(): string;
  authenticate(profileBytes: Uint8Array): Promise<Profile>;
  anchors(profile: Profile): readonly TrustedMinimumObjectAccessHead[];
  encode(profile: Profile, anchors: readonly TrustedMinimumObjectAccessHead[]): Uint8Array;
  destroy(profile: Profile): void;
}>) {
  return Object.freeze({
    async load(targetObjectId: string): Promise<TrustedMinimumObjectAccessHead | null> {
      return input.vault.withOpenProfile(input.coordinates, async (bytes) => {
        const profile = await input.authenticate(bytes);
        try {
          const anchor = input.anchors(profile).find((entry) =>
            entry.objectId === targetObjectId
          );
          return anchor === undefined ? null : Object.freeze({ ...anchor,
            payloadHash: anchor.payloadHash.slice(),
            manifestHash: anchor.manifestHash.slice() });
        } finally { input.destroy(profile); }
      });
    },
    async advance(update: Readonly<{
      expected: TrustedMinimumObjectAccessHead | null;
      next: TrustedMinimumObjectAccessHead;
    }>): Promise<boolean> {
      return withAnchorUpdateLock(input.vault,
        `${input.coordinates.serverScope}\u0000${input.coordinates.profileId}`,
        async () => {
          const publicProfile = (await input.vault.listPublicProfiles()).find((entry) =>
            entry.lifecycle === "active"
            && entry.coordinates.profileId === input.coordinates.profileId
            && entry.coordinates.deviceId === input.coordinates.deviceId
          );
          if (publicProfile === undefined) throw new Error("Client profile is unavailable");
          let candidateBytes: Uint8Array | undefined;
          let matched = false;
          await input.vault.withOpenProfile(input.coordinates, async (bytes) => {
            const profile = await input.authenticate(bytes);
            try {
              const anchors = [...input.anchors(profile)];
              const index = anchors.findIndex((entry) => entry.objectId === update.next.objectId);
              const current = index < 0 ? null : anchors[index]!;
              if (!equalAnchor(current, update.expected)) return;
              if (current !== null && update.next.accessRevision < current.accessRevision) {
                throw new Error("Client object access anchor rollback was detected");
              }
              if (index < 0) anchors.push(update.next);
              else anchors[index] = update.next;
              candidateBytes = input.encode(profile, Object.freeze(anchors));
              matched = true;
            } finally { input.destroy(profile); }
          });
          if (!matched) return false;
          const stageId = input.createStageId();
          try {
            await input.vault.stageProfile({ coordinates: input.coordinates,
              stageId, generation: publicProfile.generation + 1,
              profileBytes: candidateBytes!, publicState: publicProfile.publicState });
            await input.vault.activateProfile(input.coordinates, stageId);
            return true;
          } finally { candidateBytes?.fill(0); }
        });
    },
  });
}

export function createClientProfileObjectAccessAnchorPort(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  createStageId(): string;
}>) {
  return createClientProfileObjectAccessAnchorPortOwner({
    ...input,
    authenticate: (profileBytes) => authenticateClientDeviceProfileV3({
      crypto: input.crypto, profileBytes,
      expectedDeviceId: input.coordinates.deviceId,
    }),
    anchors: (profile) => profile.objectAccessAnchors,
    encode: (profile, objectAccessAnchors) =>
      encodeClientDeviceProfileV3(Object.freeze({ ...profile,
        objectAccessAnchors })),
    destroy: destroyOpenedClientDeviceProfileV3,
  });
}
