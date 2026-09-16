import type { LatticeCrypto } from "@nautilo/lattice-crypto";

import { CLIENT_PROFILE_VAULT_MAX_BYTES } from "./types.ts";

import type {
  ClientProfileCoordinates,
  ClientProfilePublicState,
  ClientProfileVault,
} from "./types.ts";

export const CLIENT_DEVICE_PROFILE_V1_DOMAIN =
  "nautilo/client-device-profile/v1" as const;
export const CLIENT_DEVICE_PROFILE_V2_DOMAIN =
  "nautilo/client-device-profile/v2" as const;
export const CLIENT_DEVICE_PROFILE_MAX_KEYRINGS = 256 as const;
export const CLIENT_DEVICE_PROFILE_MAX_GENERATIONS = 32 as const;
export const CLIENT_DEVICE_PROFILE_MAX_BYTES = CLIENT_PROFILE_VAULT_MAX_BYTES;

const SIGNING_KEY_BYTES = 32;
const ENCRYPTION_PUBLIC_KEY_BYTES = 65;
const ENCRYPTION_PRIVATE_KEY_BYTES = 32;
const HASH_BYTES = 32;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

export type ClientNamespaceKeyClass = "human" | "ai";

export interface RetainedClientNamespaceKeyringV2 {
  readonly deliverySequence: number;
  readonly operationId: string;
  readonly namespaceId: string;
  readonly keyClass: ClientNamespaceKeyClass;
  readonly domainId: string;
  readonly domainEpoch: number;
  readonly accessRevision: number;
  readonly bindingHash: Uint8Array;
  readonly currentGeneration: number;
  readonly generations: readonly Readonly<{
    readonly generation: number;
    readonly key: Uint8Array;
  }>[];
}

interface ClientDeviceKeys {
  readonly deviceId: string;
  readonly signingPublicKey: Uint8Array;
  readonly signingPrivateKey: Uint8Array;
  readonly encryptionPublicKey: Uint8Array;
  readonly encryptionPrivateKey: Uint8Array;
}

export interface OpenedClientDeviceProfileV1 extends ClientDeviceKeys {
  readonly formatVersion: 1;
}

export interface OpenedClientDeviceProfileV2 extends ClientDeviceKeys {
  readonly formatVersion: 2;
  readonly trustedDeviceRevision: number;
  readonly trustedHostAuthorizationRevision: number;
  readonly deliveryHighWatermark: number;
  readonly keyringDeliveries: readonly RetainedClientNamespaceKeyringV2[];
}

export type OpenedClientDeviceProfile =
  | OpenedClientDeviceProfileV1
  | OpenedClientDeviceProfileV2;

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Client profile counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Client profile counter is unsafe");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function frame(bytes: Uint8Array): Uint8Array {
  return concat([u32(bytes.length), bytes]);
}

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce(
    (length, part) => length + part.length,
    0,
  ));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

class Reader {
  #offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  u32(): number {
    if (this.#offset + 4 > this.bytes.length) {
      throw new RangeError("Client profile is truncated");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getUint32(this.#offset);
    this.#offset += 4;
    return value;
  }

  u64(): number {
    if (this.#offset + 8 > this.bytes.length) {
      throw new RangeError("Client profile is truncated");
    }
    const value = Number(new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getBigUint64(this.#offset));
    this.#offset += 8;
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("Client profile counter is unsafe");
    }
    return value;
  }

  frame(maximum: number): Uint8Array {
    const length = this.u32();
    if (length > maximum || this.#offset + length > this.bytes.length) {
      throw new RangeError("Client profile frame is invalid");
    }
    const value = this.bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  fixed(label: string, length: number): Uint8Array {
    const value = this.frame(length);
    if (value.length !== length) {
      value.fill(0);
      throw new RangeError(`${label} must be exactly ${length} bytes`);
    }
    return value;
  }

  text(maximum = 128): string {
    const bytes = this.frame(maximum);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  finish(): void {
    if (this.#offset !== this.bytes.length) {
      throw new RangeError("Client profile has trailing bytes");
    }
  }
}

function portable(label: string, value: string): string {
  if (typeof value !== "string" || !PORTABLE_ID.test(value)) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
  return value;
}

function exactBytes(label: string, value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
  }
  return value.slice();
}

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

function canonicalKeyrings(
  value: readonly RetainedClientNamespaceKeyringV2[],
): readonly RetainedClientNamespaceKeyringV2[] {
  if (
    !Array.isArray(value as unknown)
    || value.length > CLIENT_DEVICE_PROFILE_MAX_KEYRINGS
  ) {
    throw new RangeError("Client profile keyring inventory exceeds its bound");
  }
  const keyrings: RetainedClientNamespaceKeyringV2[] = [];
  try {
    for (const entry of value) {
      portable("Client keyring operation", entry.operationId);
      portable("Client keyring Namespace", entry.namespaceId);
      portable("Client keyring Domain", entry.domainId);
      if (entry.keyClass !== "human" && entry.keyClass !== "ai") {
        throw new TypeError("Client keyring class is invalid");
      }
      [
        entry.deliverySequence,
        entry.domainEpoch,
        entry.accessRevision,
        entry.currentGeneration,
      ].forEach(u64);
      const generations: Array<Readonly<{
        generation: number;
        key: Uint8Array;
      }>> = [];
      try {
        for (const generation of entry.generations) {
          u64(generation.generation);
          generations.push(Object.freeze({
            generation: generation.generation,
            key: exactBytes("Client keyring generation", generation.key, 32),
          }));
        }
        if (
          generations.length < 1
          || generations.length > CLIENT_DEVICE_PROFILE_MAX_GENERATIONS
          || generations.some((generation, index) =>
            index > 0
            && generations[index - 1]!.generation >= generation.generation
          )
          || !generations.some((generation) =>
            generation.generation === entry.currentGeneration
          )
        ) throw new TypeError("Client keyring generations are noncanonical");
        const bindingHash = exactBytes(
          "Client keyring binding hash",
          entry.bindingHash,
          32,
        );
        keyrings.push(Object.freeze({
          deliverySequence: entry.deliverySequence,
          operationId: entry.operationId,
          namespaceId: entry.namespaceId,
          keyClass: entry.keyClass,
          domainId: entry.domainId,
          domainEpoch: entry.domainEpoch,
          accessRevision: entry.accessRevision,
          bindingHash,
          currentGeneration: entry.currentGeneration,
          generations: Object.freeze(generations),
        }));
      } catch (error) {
        generations.forEach((generation) => generation.key.fill(0));
        throw error;
      }
    }
    for (let index = 1; index < keyrings.length; index += 1) {
      const previous = keyrings[index - 1]!;
      const current = keyrings[index]!;
      const namespaceOrder = compareUtf8(
        previous.namespaceId,
        current.namespaceId,
      );
      if (
        namespaceOrder > 0
        || (
          namespaceOrder === 0
          && (
            previous.keyClass > current.keyClass
            || (
              previous.keyClass === current.keyClass
              && previous.accessRevision >= current.accessRevision
            )
          )
        )
      ) throw new TypeError("Client keyrings must be canonically ordered");
    }
    return Object.freeze(keyrings);
  } catch (error) {
    destroyKeyrings(keyrings);
    throw error;
  }
}

function encodeKeys(input: ClientDeviceKeys): Uint8Array[] {
  portable("Client profile device", input.deviceId);
  const parts: Uint8Array[] = [text(input.deviceId)];
  try {
    for (const [label, value, length] of [
      ["Signing public key", input.signingPublicKey, SIGNING_KEY_BYTES],
      ["Signing private key", input.signingPrivateKey, SIGNING_KEY_BYTES],
      ["Encryption public key", input.encryptionPublicKey, ENCRYPTION_PUBLIC_KEY_BYTES],
      ["Encryption private key", input.encryptionPrivateKey, ENCRYPTION_PRIVATE_KEY_BYTES],
    ] as const) {
      const owned = exactBytes(label, value, length);
      try {
        parts.push(frame(owned));
      } finally {
        owned.fill(0);
      }
    }
    return parts;
  } catch (error) {
    parts.forEach((part) => part.fill(0));
    throw error;
  }
}

/** Exact legacy encoder retained for byte-compatible initial bootstrap. */
export function encodeClientDeviceProfileV1(input: ClientDeviceKeys): Uint8Array {
  const parts = [text(CLIENT_DEVICE_PROFILE_V1_DOMAIN), ...encodeKeys(input)];
  try {
    return concat(parts);
  } finally {
    parts.forEach((part) => part.fill(0));
  }
}

export function encodeClientDeviceProfileV2(
  input: OpenedClientDeviceProfileV2,
): Uint8Array {
  const keyrings = canonicalKeyrings(input.keyringDeliveries);
  const parts: Uint8Array[] = [
    text(CLIENT_DEVICE_PROFILE_V2_DOMAIN),
    ...encodeKeys(input),
    u64(input.trustedDeviceRevision),
    u64(input.trustedHostAuthorizationRevision),
    u64(input.deliveryHighWatermark),
    u32(keyrings.length),
  ];
  try {
    for (const entry of keyrings) {
      parts.push(
        u64(entry.deliverySequence),
        text(entry.operationId),
        text(entry.namespaceId),
        u32(entry.keyClass === "human" ? 1 : 2),
        text(entry.domainId),
        u64(entry.domainEpoch),
        u64(entry.accessRevision),
        frame(entry.bindingHash),
        u64(entry.currentGeneration),
        u32(entry.generations.length),
      );
      for (const generation of entry.generations) {
        parts.push(u64(generation.generation), frame(generation.key));
      }
    }
    const bytes = concat(parts);
    if (bytes.length > CLIENT_DEVICE_PROFILE_MAX_BYTES) {
      bytes.fill(0);
      throw new RangeError("Client profile exceeds its byte bound");
    }
    return bytes;
  } finally {
    parts.forEach((part) => part.fill(0));
    destroyKeyrings(keyrings);
  }
}

function decodeKeys(reader: Reader): ClientDeviceKeys {
  const owned: Uint8Array[] = [];
  try {
    const deviceId = portable("Client profile device", reader.text());
    const signingPublicKey = reader.fixed(
      "Signing public key",
      SIGNING_KEY_BYTES,
    );
    owned.push(signingPublicKey);
    const signingPrivateKey = reader.fixed(
      "Signing private key",
      SIGNING_KEY_BYTES,
    );
    owned.push(signingPrivateKey);
    const encryptionPublicKey = reader.fixed(
      "Encryption public key",
      ENCRYPTION_PUBLIC_KEY_BYTES,
    );
    owned.push(encryptionPublicKey);
    const encryptionPrivateKey = reader.fixed(
      "Encryption private key",
      ENCRYPTION_PRIVATE_KEY_BYTES,
    );
    owned.push(encryptionPrivateKey);
    return {
      deviceId,
      signingPublicKey,
      signingPrivateKey,
      encryptionPublicKey,
      encryptionPrivateKey,
    };
  } catch (error) {
    owned.forEach((value) => value.fill(0));
    throw error;
  }
}

function destroyKeyrings(
  keyrings: readonly RetainedClientNamespaceKeyringV2[],
): void {
  keyrings.forEach((entry) =>
    entry.generations.forEach((generation) => generation.key.fill(0))
  );
}

function decodeProfile(bytes: Uint8Array): OpenedClientDeviceProfile {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > CLIENT_DEVICE_PROFILE_MAX_BYTES
  ) throw new RangeError("Client profile bytes are invalid");
  const reader = new Reader(bytes);
  const domain = reader.text(CLIENT_DEVICE_PROFILE_V2_DOMAIN.length);
  const keys = decodeKeys(reader);
  const keyrings: RetainedClientNamespaceKeyringV2[] = [];
  try {
    if (domain === CLIENT_DEVICE_PROFILE_V1_DOMAIN) {
      reader.finish();
      return Object.freeze({ formatVersion: 1 as const, ...keys });
    }
    if (domain !== CLIENT_DEVICE_PROFILE_V2_DOMAIN) {
      throw new TypeError("Client profile version is unsupported");
    }
    const trustedDeviceRevision = reader.u64();
    const trustedHostAuthorizationRevision = reader.u64();
    const deliveryHighWatermark = reader.u64();
    const count = reader.u32();
    if (count > CLIENT_DEVICE_PROFILE_MAX_KEYRINGS) {
      throw new RangeError("Client profile keyring inventory exceeds its bound");
    }
    for (let index = 0; index < count; index += 1) {
      const deliverySequence = reader.u64();
      const operationId = reader.text();
      const namespaceId = reader.text();
      const keyClassCode = reader.u32();
      const keyClass = keyClassCode === 1
        ? "human" as const
        : keyClassCode === 2
        ? "ai" as const
        : (() => {
          throw new TypeError("Client keyring class is invalid");
        })();
      const domainId = reader.text();
      const domainEpoch = reader.u64();
      const accessRevision = reader.u64();
      const bindingHash = reader.fixed(
        "Client keyring binding hash",
        HASH_BYTES,
      );
      const currentGeneration = reader.u64();
      const generationCount = reader.u32();
      if (
        generationCount < 1
        || generationCount > CLIENT_DEVICE_PROFILE_MAX_GENERATIONS
      ) throw new RangeError("Client keyring generation count is invalid");
      const generations = Array.from({ length: generationCount }, () =>
        Object.freeze({
          generation: reader.u64(),
          key: reader.fixed(
            "Client keyring generation",
            SIGNING_KEY_BYTES,
          ),
        })
      );
      keyrings.push(Object.freeze({
        deliverySequence,
        operationId,
        namespaceId,
        keyClass,
        domainId,
        domainEpoch,
        accessRevision,
        bindingHash,
        currentGeneration,
        generations: Object.freeze(generations),
      }));
    }
    reader.finish();
    const canonical = canonicalKeyrings(keyrings);
    destroyKeyrings(keyrings);
    return Object.freeze({
      formatVersion: 2 as const,
      ...keys,
      trustedDeviceRevision,
      trustedHostAuthorizationRevision,
      deliveryHighWatermark,
      keyringDeliveries: canonical,
    });
  } catch (error) {
    destroyKeyrings(keyrings);
    Object.values(keys).forEach((value) => {
      if (value instanceof Uint8Array) value.fill(0);
    });
    throw error;
  }
}

async function assertKeypairs(
  crypto: LatticeCrypto,
  profile: OpenedClientDeviceProfile,
): Promise<void> {
  const proof = new TextEncoder().encode("nautilo/client-device-profile-key-proof/v2");
  const signature = crypto.sign(profile.signingPrivateKey, proof);
  if (!crypto.verify(profile.signingPublicKey, proof, signature)) {
    signature.fill(0);
    throw new Error("Client profile signing keypair is invalid");
  }
  signature.fill(0);
  const plaintext = new Uint8Array(32).fill(0x5a);
  let ciphertext: Uint8Array | undefined;
  let opened: Uint8Array | null = null;
  try {
    ciphertext = await crypto.sealTo(profile.encryptionPublicKey, plaintext);
    opened = await crypto.openSealed(profile.encryptionPrivateKey, ciphertext);
    if (
      opened === null
      || opened.length !== plaintext.length
      || opened.some((byte, index) => byte !== plaintext[index])
    ) throw new Error("Client profile encryption keypair is invalid");
  } finally {
    plaintext.fill(0);
    ciphertext?.fill(0);
    opened?.fill(0);
  }
}

export async function authenticateClientDeviceProfile(input: {
  readonly crypto: LatticeCrypto;
  readonly profileBytes: Uint8Array;
  readonly expectedDeviceId: string;
}): Promise<OpenedClientDeviceProfile> {
  const profile = decodeProfile(input.profileBytes);
  try {
    if (profile.deviceId !== portable("Expected client device", input.expectedDeviceId)) {
      throw new Error("Client profile device does not match");
    }
    await assertKeypairs(input.crypto, profile);
    return profile;
  } catch (error) {
    destroyOpenedClientDeviceProfile(profile);
    throw error;
  }
}

export function destroyOpenedClientDeviceProfile(
  profile: OpenedClientDeviceProfile,
): void {
  profile.signingPublicKey.fill(0);
  profile.signingPrivateKey.fill(0);
  profile.encryptionPublicKey.fill(0);
  profile.encryptionPrivateKey.fill(0);
  if (profile.formatVersion === 2) destroyKeyrings(profile.keyringDeliveries);
}

export async function createClientDeviceProfileV2Candidate(input: {
  readonly crypto: LatticeCrypto;
  readonly v1ProfileBytes: Uint8Array;
  readonly expectedDeviceId: string;
  readonly trustedDeviceRevision: number;
  readonly trustedHostAuthorizationRevision: number;
  readonly deliveryHighWatermark: number;
}): Promise<OpenedClientDeviceProfileV2> {
  [
    input.trustedDeviceRevision,
    input.trustedHostAuthorizationRevision,
    input.deliveryHighWatermark,
  ].forEach(u64);
  const v1 = await authenticateClientDeviceProfile({
    crypto: input.crypto,
    profileBytes: input.v1ProfileBytes,
    expectedDeviceId: input.expectedDeviceId,
  });
  try {
    if (v1.formatVersion !== 1) {
      throw new TypeError("Client profile migration requires v1");
    }
    return Object.freeze({
      formatVersion: 2,
      deviceId: v1.deviceId,
      signingPublicKey: v1.signingPublicKey.slice(),
      signingPrivateKey: v1.signingPrivateKey.slice(),
      encryptionPublicKey: v1.encryptionPublicKey.slice(),
      encryptionPrivateKey: v1.encryptionPrivateKey.slice(),
      trustedDeviceRevision: input.trustedDeviceRevision,
      trustedHostAuthorizationRevision: input.trustedHostAuthorizationRevision,
      deliveryHighWatermark: input.deliveryHighWatermark,
      keyringDeliveries: Object.freeze([]),
    });
  } finally {
    destroyOpenedClientDeviceProfile(v1);
  }
}

export async function replaceClientDeviceProfileWithV2(input: {
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly coordinates: ClientProfileCoordinates;
  readonly stageId: string;
  readonly generation: number;
  readonly publicState: ClientProfilePublicState;
  readonly trustedDeviceRevision: number;
  readonly trustedHostAuthorizationRevision: number;
  readonly deliveryHighWatermark: number;
}): Promise<void> {
  let candidate: OpenedClientDeviceProfileV2 | undefined;
  let candidateBytes: Uint8Array | undefined;
  await input.vault.withOpenProfile(input.coordinates, async (activeBytes) => {
    candidate = await createClientDeviceProfileV2Candidate({
      crypto: input.crypto,
      v1ProfileBytes: activeBytes,
      expectedDeviceId: input.coordinates.deviceId,
      trustedDeviceRevision: input.trustedDeviceRevision,
      trustedHostAuthorizationRevision: input.trustedHostAuthorizationRevision,
      deliveryHighWatermark: input.deliveryHighWatermark,
    });
    candidateBytes = encodeClientDeviceProfileV2(candidate);
  });
  try {
    await input.vault.stageProfile({
      coordinates: input.coordinates,
      stageId: input.stageId,
      generation: input.generation,
      profileBytes: candidateBytes!,
      publicState: input.publicState,
    });
    await input.vault.activateProfile(input.coordinates, input.stageId);
  } finally {
    candidateBytes?.fill(0);
    if (candidate) destroyOpenedClientDeviceProfile(candidate);
  }
}
