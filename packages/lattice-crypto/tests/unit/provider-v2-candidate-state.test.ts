import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  AI_DOMAIN_ROOT_EXPORTER_LABEL,
  HUMAN_DOMAIN_ROOT_EXPORTER_LABEL,
  exportDomainRoot,
} from "../../src/domain/roots.ts";
import {
  DeviceProviderStateVaultV2,
  V2_PROVIDER_STATE_FORMAT_VERSION,
  V2_PROVIDER_STATE_MAX_BYTES,
  restoreSealedProviderStateV2,
  type ProviderSnapshotCoordinatesV2,
  type SealedProviderStateV2,
} from "../../src/device/v2-state-vault.ts";
import {
  concatV2,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../../src/format/v2-primitives.ts";
import { DummyV2GroupProvider } from "../../src/group/v2-dummy.ts";
import { V2ProviderStateError } from "../../src/group/v2-provider.ts";
import {
  V2_PROVIDER_CANDIDATE_SOURCE_ID,
  V2_PROVIDER_TRANSITION_FORMAT_VERSION,
  candidatePayloadSnapshotV2,
  cloneProviderHeadV2,
  cloneProviderPublicTransitionV2,
  decodeProviderRosterV2,
  destroyOpenedProviderCandidateStateV2,
  markLocalProviderCandidateV2,
  openLocalProviderCandidateV2,
  ProviderCandidateStateError,
  providerHeadsEqualV2,
  providerPublicTransitionDigestMatchesV2,
  providerPublicTransitionDigestV2,
  redactProviderWelcomeV2,
  sealLocalProviderCandidateV2,
  validateProviderPublicTransitionV2,
  type LocalProviderCandidateV2,
  type ProviderPublicHeadV2,
  type ProviderPublicTransitionV2,
} from "../../src/transition/provider-candidate.ts";
import {
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function recordZeroFills(): {
  readonly snapshots: Uint8Array[];
  readonly restore: () => void;
} {
  const snapshots: Uint8Array[] = [];
  const originalFill = Uint8Array.prototype.fill;
  Uint8Array.prototype.fill = function (
    ...args: Parameters<Uint8Array["fill"]>
  ): Uint8Array {
    if (args[0] === 0) snapshots.push(Uint8Array.from(this));
    return originalFill.apply(this, args);
  };
  return {
    snapshots,
    restore: () => {
      Uint8Array.prototype.fill = originalFill;
    },
  };
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return haystack.some((_, offset) =>
    offset + needle.length <= haystack.length
    && needle.every((byte, index) => haystack[offset + index] === byte)
  );
}

class RecordingCrypto extends LatticeCrypto {
  readonly derivationLabels: string[] = [];
  readonly derivationOutputs: Uint8Array[] = [];
  readonly hashOutputs: Uint8Array[] = [];
  sealedPlaintext: Uint8Array | null = null;
  sealedAad: Uint8Array | null = null;
  sealedCiphertext: Uint8Array | null = null;
  openedPlaintext: Uint8Array | null = null;
  openedAad: Uint8Array | null = null;
  openedCiphertext: Uint8Array | null = null;
  openCalls = 0;
  private failDerivation = false;
  private failDerivationLabel: string | null = null;
  private failRandom = false;
  private replaceRandom = false;
  private derivationFailure: unknown;
  private randomFailure: unknown;
  private randomReplacement: Uint8Array = new Uint8Array();

  failNextDerivationWith(error: unknown): void {
    this.failDerivation = true;
    this.derivationFailure = error;
  }

  failDerivationForLabel(label: string, error: unknown): void {
    this.failDerivationLabel = label;
    this.derivationFailure = error;
  }

  failNextRandomWith(error: unknown): void {
    this.failRandom = true;
    this.randomFailure = error;
  }

  replaceNextRandomWith(bytes: Uint8Array): void {
    this.replaceRandom = true;
    this.randomReplacement = bytes;
  }

  override deriveKey(
    ikm: Uint8Array,
    label: string,
    length?: number,
  ): Uint8Array {
    if (this.failDerivation || this.failDerivationLabel === label) {
      this.failDerivation = false;
      this.failDerivationLabel = null;
      throw this.derivationFailure;
    }
    this.derivationLabels.push(label);
    const output = super.deriveKey(ikm, label, length);
    this.derivationOutputs.push(output);
    return output;
  }

  override randomBytes(length: number): Uint8Array {
    if (this.failRandom) {
      this.failRandom = false;
      throw this.randomFailure;
    }
    if (this.replaceRandom) {
      this.replaceRandom = false;
      return this.randomReplacement;
    }
    return super.randomBytes(length);
  }

  override hash(data: Uint8Array): Uint8Array {
    const output = super.hash(data);
    this.hashOutputs.push(output);
    return output;
  }

  override aeadSeal(
    key: Uint8Array,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array {
    this.sealedPlaintext = plaintext;
    this.sealedAad = aad?.slice() ?? null;
    const ciphertext = super.aeadSeal(key, plaintext, aad);
    this.sealedCiphertext = ciphertext;
    return ciphertext;
  }

  override aeadOpen(
    key: Uint8Array,
    blob: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array | null {
    this.openCalls += 1;
    this.openedAad = aad?.slice() ?? null;
    this.openedCiphertext = blob;
    const plaintext = super.aeadOpen(key, blob, aad);
    this.openedPlaintext = plaintext;
    return plaintext;
  }
}

class ShortHashCrypto extends LatticeCrypto {
  override hash(data: Uint8Array): Uint8Array {
    return super.hash(data).subarray(0, 31);
  }
}

interface DirectCandidateFixture {
  readonly crypto: RecordingCrypto;
  readonly vault: DeviceProviderStateVaultV2;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly nextHead: ProviderPublicHeadV2;
  readonly publicTransition: ProviderPublicTransitionV2;
  readonly payload: Uint8Array;
}

function directCandidateFixture(seed = 909): DirectCandidateFixture {
  const crypto = new RecordingCrypto(seededRng(seed));
  const domainId = cryptoDomainId("domain_direct");
  const expectedHead = Object.freeze({
    providerId: "provider-direct",
    domainId,
    epoch: domainEpoch(10),
    stateHash: bytes(0x31),
  });
  const nextHead = Object.freeze({
    providerId: "provider-direct",
    domainId,
    epoch: domainEpoch(11),
    stateHash: bytes(0x32),
  });
  const publicTransition = Object.freeze({
    formatVersion: V2_PROVIDER_TRANSITION_FORMAT_VERSION,
    providerId: "provider-direct",
    domainId,
    operation: "update" as const,
    targetHumanId: humanId("human_direct"),
    targetDeviceId: cryptoDeviceId("device_direct"),
    expectedHead,
    nextHead,
    commitBytes: new Uint8Array([0x41, 0x42]),
    welcomeHash: crypto.hash(new Uint8Array([0x51, 0x52, 0x53])),
    welcomeBytes: new Uint8Array([0x51, 0x52, 0x53]),
    rosterBytes: new Uint8Array([0x61, 0x62, 0x63, 0x64]),
  });
  return {
    crypto,
    vault: DeviceProviderStateVaultV2.fromKey(
      crypto,
      cryptoDeviceId("device_direct"),
      bytes(0xa5),
    ),
    expectedHead,
    nextHead,
    publicTransition,
    payload: new Uint8Array([0x71, 0x72, 0x73]),
  };
}

function sealDirectCandidate(
  fixture: DirectCandidateFixture,
  overrides: Partial<{
    readonly providerId: string;
    readonly domainId: ReturnType<typeof cryptoDomainId>;
    readonly expectedHead: ProviderPublicHeadV2;
    readonly nextHead: ProviderPublicHeadV2;
    readonly publicTransition: ProviderPublicTransitionV2;
    readonly payload: Uint8Array;
    readonly sourceId: string;
  }> = {},
): LocalProviderCandidateV2 {
  return sealLocalProviderCandidateV2({
    crypto: fixture.crypto,
    vault: fixture.vault,
    providerId: overrides.providerId ?? fixture.expectedHead.providerId,
    domainId: overrides.domainId ?? fixture.expectedHead.domainId,
    expectedHead: overrides.expectedHead ?? fixture.expectedHead,
    nextHead: overrides.nextHead ?? fixture.nextHead,
    publicTransition:
      overrides.publicTransition ?? fixture.publicTransition,
    payload: overrides.payload ?? fixture.payload,
    ...(overrides.sourceId === undefined
      ? {}
      : { sourceId: overrides.sourceId }),
  });
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset);
}

function frameValueOffset(_bytes: Uint8Array, offset: number): number {
  return offset + 4;
}

function afterFrame(bytes: Uint8Array, offset: number): number {
  return offset + 4 + readU32(bytes, offset);
}

function candidatePlaintextOffsets(plaintext: Uint8Array): {
  readonly stateDomain: number;
  readonly candidateId: number;
  readonly providerId: number;
  readonly domainId: number;
  readonly deviceId: number;
  readonly lifecycle: number;
  readonly expectedHash: number;
  readonly nextHash: number;
  readonly transitionDigest: number;
} {
  const stateDomain = frameValueOffset(plaintext, 0);
  let offset = afterFrame(plaintext, 0) + 4;
  const candidateId = frameValueOffset(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  const providerId = frameValueOffset(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  const domainId = frameValueOffset(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  const deviceId = frameValueOffset(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  const lifecycle = offset;
  offset += 4;
  const headHash = (): number => {
    offset = afterFrame(plaintext, offset);
    offset = afterFrame(plaintext, offset);
    offset += 8;
    const hashOffset = frameValueOffset(plaintext, offset);
    offset = afterFrame(plaintext, offset);
    return hashOffset;
  };
  const expectedHash = headHash();
  const nextHash = headHash();
  const transitionDigest = frameValueOffset(plaintext, offset);
  return {
    stateDomain,
    candidateId,
    providerId,
    domainId,
    deviceId,
    lifecycle,
    expectedHash,
    nextHash,
    transitionDigest,
  };
}

function resealCandidatePlaintext(
  fixture: DirectCandidateFixture,
  candidate: LocalProviderCandidateV2,
  plaintext: Uint8Array,
): LocalProviderCandidateV2 {
  return {
    ...candidate,
    snapshot: fixture.vault.seal(
      {
        providerId: candidate.providerId,
        domainId: candidate.domainId,
        revision: candidate.nextHead.epoch,
        snapshotKind: "candidate",
      },
      plaintext,
    ),
  };
}

function shortenFixedFrame(
  plaintext: Uint8Array,
  valueOffset: number,
): Uint8Array {
  const lengthOffset = valueOffset - 4;
  const length = readU32(plaintext, lengthOffset);
  const shortened = new Uint8Array(plaintext.length - 1);
  shortened.set(plaintext.subarray(0, lengthOffset));
  new DataView(shortened.buffer).setUint32(lengthOffset, length - 1);
  shortened.set(
    plaintext.subarray(valueOffset, valueOffset + length - 1),
    valueOffset,
  );
  shortened.set(
    plaintext.subarray(valueOffset + length),
    valueOffset + length - 1,
  );
  return shortened;
}

function setup(seed = 101) {
  const crypto = new RecordingCrypto(seededRng(seed));
  const domainId = cryptoDomainId("domain_ab");
  const deviceId = cryptoDeviceId("alice_phone");
  const vault = DeviceProviderStateVaultV2.fromKey(
    crypto,
    deviceId,
    bytes(0xa1),
  );
  const provider = new DummyV2GroupProvider(crypto, vault);
  const active = provider.bootstrapForTesting({
    domainId,
    epoch: domainEpoch(7),
    exporterSecret: bytes(0x5a),
  });
  return { active, crypto, deviceId, domainId, provider, vault };
}

function dummyStatePlaintextOffsets(plaintext: Uint8Array): {
  readonly stateDomain: number;
  readonly providerId: number;
  readonly domainId: number;
  readonly deviceId: number;
  readonly epoch: number;
  readonly exporterSecret: number;
  readonly stateHash: number;
} {
  let offset = 4;
  const stateDomain = frameValueOffset(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  const providerId = frameValueOffset(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  const domainId = frameValueOffset(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  const deviceId = frameValueOffset(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  const epoch = offset;
  offset += 8;
  const exporterSecret = frameValueOffset(plaintext, offset);
  offset = afterFrame(plaintext, offset);
  const stateHash = frameValueOffset(plaintext, offset);
  return {
    stateDomain,
    providerId,
    domainId,
    deviceId,
    epoch,
    exporterSecret,
    stateHash,
  };
}

describe("v2 device-local provider state vault", () => {
  test("restores only a validated detached device-local sealed snapshot", () => {
    const ciphertext = new Uint8Array(64).fill(0x72);
    const restored = restoreSealedProviderStateV2({
      providerId: "provider-v2", domainId: cryptoDomainId("domain_restore"),
      deviceId: cryptoDeviceId("device_restore"), revision: domainEpoch(4),
      snapshotKind: "active", ciphertext,
    });
    ciphertext.fill(0);
    expect(restored.ciphertext.every((byte) => byte === 0x72)).toBeTrue();
    expect(() => restoreSealedProviderStateV2({ ...restored,
      snapshotKind: "unknown" as never })).toThrow("unsupported");
    expect(() => restoreSealedProviderStateV2({ ...restored,
      ciphertext: new Uint8Array() })).toThrow("ciphertext");
    for (const boundaryLength of [
      1,
      V2_PROVIDER_STATE_MAX_BYTES + 40,
    ]) {
      const boundary = restoreSealedProviderStateV2({
        ...restored,
        ciphertext: new Uint8Array(boundaryLength),
      });
      expect(boundary.ciphertext).toHaveLength(boundaryLength);
      boundary.ciphertext.fill(0);
    }
    expect(() => restoreSealedProviderStateV2({
      ...restored,
      ciphertext: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 41),
    })).toThrow("ciphertext");
    restored.ciphertext.fill(0);
  });
  const deviceId = cryptoDeviceId("device_vault");
  const coordinates: ProviderSnapshotCoordinatesV2 = {
    providerId: "provider-vault",
    domainId: cryptoDomainId("domain_vault"),
    revision: domainEpoch(4),
    snapshotKind: "active",
  };

  function vaultFixture(seed = 90_001) {
    const crypto = new RecordingCrypto(seededRng(seed));
    const key = bytes(0x6a);
    const vault = DeviceProviderStateVaultV2.fromKey(
      crypto,
      deviceId,
      key,
    );
    return { crypto, key, vault };
  }

  test("binds the exact v2 domain and every snapshot coordinate in AAD", () => {
    const { crypto, vault } = vaultFixture();
    const plaintext = new Uint8Array([1, 2, 3]);
    const snapshot = vault.seal(coordinates, plaintext);
    const expectedAad = concatV2(
      frameText(
        "nautilo/lattice-crypto/device-provider-state-vault/v2",
      ),
      encodeU32(V2_PROVIDER_STATE_FORMAT_VERSION),
      frameText(coordinates.providerId),
      frameText(coordinates.domainId),
      frameText(deviceId),
      encodeU64(coordinates.revision),
      frameText(coordinates.snapshotKind),
    );

    expect(crypto.sealedAad).toEqual(expectedAad);
    expect(vault.open(snapshot, coordinates)).toEqual(plaintext);
    expect(crypto.openedAad).toEqual(expectedAad);
  });

  test("detaches opened provider plaintext and wipes the crypto-owned result", () => {
    const { crypto, vault } = vaultFixture(90_004);
    const plaintext = new Uint8Array([4, 5, 6]);
    const snapshot = vault.seal(coordinates, plaintext);
    const opened = vault.open(snapshot, coordinates);
    const providerPlaintext = crypto.openedPlaintext;

    expect(opened).toEqual(plaintext);
    expect(providerPlaintext).not.toBeNull();
    expect(opened).not.toBe(providerPlaintext);
    expect(providerPlaintext).toEqual(new Uint8Array(plaintext.length));
    expect(opened).toEqual(plaintext);
  });

  test("validates and owns the device-local vault key", () => {
    const crypto = new RecordingCrypto(seededRng(90_002));
    expect(() =>
      DeviceProviderStateVaultV2.fromKey(
        crypto,
        deviceId,
        null as never,
      )
    ).toThrow(
      "Provider state vault key must be 32 bytes",
    );
    for (const length of [31, 33]) {
      expect(() =>
        DeviceProviderStateVaultV2.fromKey(
          crypto,
          deviceId,
          new Uint8Array(length),
        )
      ).toThrow(
        "Provider state vault key must be 32 bytes",
      );
    }

    const key = Buffer.from(bytes(0x6b));
    const vault = DeviceProviderStateVaultV2.fromKey(
      crypto,
      deviceId,
      key,
    );
    const snapshot = vault.seal(coordinates, new Uint8Array([7]));
    key.fill(0);
    expect(vault.open(snapshot, coordinates)).toEqual(new Uint8Array([7]));
  });

  test("destroys its local key and fails closed after device shutdown", () => {
    const crypto = new RecordingCrypto(seededRng(90_003));
    const callerKey = Buffer.from(bytes(0x6c));
    const vault = DeviceProviderStateVaultV2.fromKey(
      crypto,
      deviceId,
      callerKey,
    );
    const snapshot = vault.seal(coordinates, new Uint8Array([8]));
    const originalFill = Uint8Array.prototype.fill;
    let destroyedKeyFillCalls = 0;
    Uint8Array.prototype.fill = function (
      ...args: Parameters<Uint8Array["fill"]>
    ): Uint8Array {
      if (
        args[0] === 0
        && this.length === 32
      ) {
        destroyedKeyFillCalls += 1;
      }
      return originalFill.apply(this, args);
    };
    try {
      vault.destroy();
      vault.destroy();
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    expect(destroyedKeyFillCalls).toBe(1);
    expect(callerKey).toEqual(Buffer.from(bytes(0x6c)));
    expect(() =>
      vault.seal(coordinates, new Uint8Array([9]))
    ).toThrow("Provider state vault is destroyed");
    const openCalls = crypto.openCalls;
    expect(vault.open(snapshot, coordinates)).toBeNull();
    expect(crypto.openCalls).toBe(openCalls);
  });

  test("rejects malformed coordinates with exact diagnostics", () => {
    const { vault } = vaultFixture();
    const invalidCoordinates: ReadonlyArray<{
      readonly value: ProviderSnapshotCoordinatesV2;
      readonly message: string;
    }> = [
      {
        value: { ...coordinates, providerId: "" },
        message:
          "Provider id must be 1-128 ASCII bytes using the portable identifier grammar",
      },
      {
        value: {
          ...coordinates,
          domainId: "" as ReturnType<typeof cryptoDomainId>,
        },
        message:
          "Crypto Domain id must be 1-128 ASCII bytes using the portable identifier grammar",
      },
      {
        value: {
          ...coordinates,
          revision: -1 as ReturnType<typeof domainEpoch>,
        },
        message: "Provider state revision must be a non-negative safe integer",
      },
      {
        value: {
          ...coordinates,
          snapshotKind: "future" as never,
        },
        message: "Provider snapshot kind is unsupported",
      },
    ];

    for (const invalid of invalidCoordinates) {
      expect(() =>
        vault.seal(invalid.value, new Uint8Array([1]))
      ).toThrow(invalid.message);
    }
  });

  test("enforces the exact plaintext size interval", () => {
    const { vault } = vaultFixture();
    for (const invalid of [
      null as never,
      new Uint8Array(0),
      new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
    ]) {
      expect(() => vault.seal(coordinates, invalid)).toThrow(
        `Provider state must be 1-${V2_PROVIDER_STATE_MAX_BYTES} bytes`,
      );
    }

    expect(
      vault.seal(coordinates, new Uint8Array(1)).ciphertext.length,
    ).toBeGreaterThan(1);
    expect(
      vault.seal(
        coordinates,
        new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES),
      ).ciphertext.length,
    ).toBeGreaterThan(V2_PROVIDER_STATE_MAX_BYTES);
  });

  test("detaches caller plaintext and provider ciphertext buffers", () => {
    const { crypto, vault } = vaultFixture();
    const plaintext = new Uint8Array([9, 8, 7]);
    const snapshot = vault.seal(coordinates, plaintext);
    const expectedCiphertext = snapshot.ciphertext.slice();

    plaintext.fill(0);
    crypto.sealedCiphertext?.fill(0);
    expect(snapshot.ciphertext).toEqual(expectedCiphertext);
    expect(vault.open(snapshot, coordinates)).toEqual(
      new Uint8Array([9, 8, 7]),
    );
  });

  test("fails closed for every mismatched or malformed sealed coordinate", () => {
    const { vault } = vaultFixture();
    const snapshot = vault.seal(coordinates, new Uint8Array([5, 4, 3]));
    const variants: SealedProviderStateV2[] = [
      {
        ...snapshot,
        classification: "server-secret" as never,
      },
      {
        ...snapshot,
        formatVersion: 1 as never,
      },
      {
        ...snapshot,
        deviceId: cryptoDeviceId("device_other"),
      },
      {
        ...snapshot,
        providerId: "provider-other",
      },
      {
        ...snapshot,
        domainId: cryptoDomainId("domain_other"),
      },
      {
        ...snapshot,
        revision: domainEpoch(5),
      },
      {
        ...snapshot,
        snapshotKind: "candidate",
      },
      {
        ...snapshot,
        ciphertext: null as never,
      },
    ];

    for (const variant of variants) {
      expect(vault.open(variant, coordinates)).toBeNull();
    }
  });

  test("validates expected coordinates and checks ciphertext limits before AEAD", () => {
    const { crypto, vault } = vaultFixture();
    const snapshot = vault.seal(coordinates, new Uint8Array([1]));
    const callsBeforeInvalidExpected = crypto.openCalls;
    expect(
      vault.open(snapshot, {
        ...coordinates,
        snapshotKind: "future" as never,
      }),
    ).toBeNull();
    expect(crypto.openCalls).toBe(callsBeforeInvalidExpected);

    const exactLimit = {
      ...snapshot,
      ciphertext: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 40),
    } as SealedProviderStateV2;
    const callsBeforeExactLimit = crypto.openCalls;
    expect(vault.open(exactLimit, coordinates)).toBeNull();
    expect(crypto.openCalls).toBe(callsBeforeExactLimit + 1);

    const aboveLimit = {
      ...snapshot,
      ciphertext: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 41),
    } as SealedProviderStateV2;
    const callsBeforeAboveLimit = crypto.openCalls;
    expect(vault.open(aboveLimit, coordinates)).toBeNull();
    expect(crypto.openCalls).toBe(callsBeforeAboveLimit);
  });
});

describe("v2 device-local provider candidate lifecycle", () => {
  test("preserves the typed candidate-state diagnostic name", () => {
    expect(new ProviderCandidateStateError("failure").name).toBe(
      "ProviderCandidateStateError",
    );
  });

  test("locks dummy bootstrap state bytes, validates its secret, and owns it", () => {
    const crypto = new RecordingCrypto(seededRng(100));
    const deviceId = cryptoDeviceId("alice_phone");
    const domainId = cryptoDomainId("domain_ab");
    const vault = DeviceProviderStateVaultV2.fromKey(
      crypto,
      deviceId,
      bytes(0xa1),
    );
    const provider = new DummyV2GroupProvider(crypto, vault);
    for (const exporterSecret of [
      null as never,
      new Uint8Array(31),
      new Uint8Array(33),
    ]) {
      expect(() =>
        provider.bootstrapForTesting({
          domainId,
          epoch: domainEpoch(7),
          exporterSecret,
        })
      ).toThrow("Dummy exporter secret must be exactly 32 bytes");
    }

    const exporterSecret = bytes(0x5a);
    const active = provider.bootstrapForTesting({
      domainId,
      epoch: domainEpoch(7),
      exporterSecret,
    });
    const expectedStateHash = crypto.hash(
      concatV2(
        frameText(
          "nautilo/lattice-crypto/dummy-provider-initial-head/v2",
        ),
        frameText(domainId),
        encodeU64(domainEpoch(7)),
        frame(bytes(0x5a)),
      ),
    );
    expect(crypto.sealedPlaintext).toEqual(
      concatV2(
        encodeU32(2),
        frameText(
          "nautilo/lattice-crypto/dummy-provider-state/v2",
        ),
        frameText("dummy-v2"),
        frameText(domainId),
        frameText(deviceId),
        encodeU64(domainEpoch(7)),
        frame(bytes(0x5a)),
        frame(expectedStateHash),
      ),
    );
    expect(provider.publicHead(active)).toEqual({
      providerId: "dummy-v2",
      domainId,
      epoch: domainEpoch(7),
      stateHash: expectedStateHash,
    });
    expect(provider.publicRoster(active)).toEqual(new Uint8Array());

    exporterSecret.fill(0xff);
    expect(provider.publicHead(active).stateHash).toEqual(expectedStateHash);
  });

  test("rejects every malformed field in sealed dummy active state exactly", () => {
    const fixture = setup(102);
    const coordinates: ProviderSnapshotCoordinatesV2 = {
      providerId: fixture.provider.id,
      domainId: fixture.domainId,
      revision: domainEpoch(7),
      snapshotKind: "active",
    };
    const plaintext = fixture.vault.open(fixture.active, coordinates)!;
    const offsets = dummyStatePlaintextOffsets(plaintext);
    const corruptAt = (offset: number): Uint8Array => {
      const copy = plaintext.slice();
      copy[offset] = copy[offset]! ^ 1;
      return copy;
    };
    const malformed = [
      {
        plaintext: corruptAt(offsets.stateDomain),
        message: "Dummy provider state domain is invalid",
      },
      {
        plaintext: corruptAt(offsets.providerId),
        message: "Dummy provider id is invalid",
      },
      {
        plaintext: corruptAt(offsets.deviceId),
        message: "Dummy provider state belongs to another device",
      },
      {
        plaintext: shortenFixedFrame(
          plaintext,
          offsets.exporterSecret,
        ),
        message: "Dummy exporter secret must be exactly 32 bytes",
      },
      {
        plaintext: shortenFixedFrame(plaintext, offsets.stateHash),
        message: "Dummy public state hash must be exactly 32 bytes",
      },
    ];

    for (const variant of malformed) {
      const active = fixture.vault.seal(coordinates, variant.plaintext);
      expect(() => fixture.provider.publicHead(active)).toThrow(
        variant.message,
      );
      variant.plaintext.fill(0);
    }
    plaintext.fill(0);
  });

  test("locks dummy update derivation and detaches exported roots", async () => {
    const fixture = setup(103);
    const oldHead = fixture.provider.publicHead(fixture.active);
    const prepared = await fixture.provider.prepareCommit({
      active: fixture.active,
    });
    const nextEpoch = domainEpoch(8);
    const expectedExporterSecret = fixture.crypto.deriveKey(
      concatV2(
        bytes(0x5a),
        frameText(fixture.domainId),
        encodeU64(nextEpoch),
        frame(prepared.publicResult.commitBytes),
      ),
      "nautilo/lattice-crypto/dummy-provider-update/v2",
      32,
    );
    const expectedNextHash = fixture.crypto.hash(
      concatV2(
        frameText(
          "nautilo/lattice-crypto/dummy-provider-next-head/v2",
        ),
        frameText("dummy-v2"),
        frameText(fixture.domainId),
        encodeU64(nextEpoch),
        frame(oldHead.stateHash),
        frame(prepared.publicResult.commitBytes),
      ),
    );
    expect(prepared.publicResult.nextHead.stateHash).toEqual(
      expectedNextHash,
    );

    const applied = fixture.provider.applyCandidate({
      active: fixture.active,
      candidate: prepared.localCandidate,
    });
    expect(applied.status).toBe("applied");
    const exporter = (
      label: string,
      context: Uint8Array,
      length: number,
    ) =>
      Promise.resolve(
        fixture.crypto.deriveKey(
          concatV2(expectedExporterSecret, context),
          label,
          length,
        ),
      );
    const expectedRoots = {
      human: await exportDomainRoot(
        "human",
        fixture.domainId,
        nextEpoch,
        exporter,
      ),
      ai: await exportDomainRoot(
        "ai",
        fixture.domainId,
        nextEpoch,
        exporter,
      ),
    };
    const beforeExport = fixture.crypto.derivationOutputs.length;
    const actualRoots = await fixture.provider.exportDomainRoots(
      applied.active,
    );
    expect(actualRoots).toEqual(expectedRoots);
    expect(actualRoots.human).not.toBe(
      fixture.crypto.derivationOutputs[beforeExport],
    );
    expect(actualRoots.ai).not.toBe(
      fixture.crypto.derivationOutputs[beforeExport + 1],
    );
  });

  test("compares every public-head coordinate and owns cloned head bytes", () => {
    const fixture = directCandidateFixture();
    const head = fixture.expectedHead;
    const variants: ProviderPublicHeadV2[] = [
      { ...head, providerId: "provider-other" },
      { ...head, domainId: cryptoDomainId("domain_other") },
      { ...head, epoch: domainEpoch(9) },
      { ...head, stateHash: bytes(0x31).subarray(0, 31) },
      {
        ...head,
        stateHash: (() => {
          const hash = head.stateHash.slice();
          hash[0] = hash[0]! ^ 1;
          return hash;
        })(),
      },
    ];

    expect(providerHeadsEqualV2(head, { ...head })).toBe(true);
    for (const candidate of variants) {
      expect(providerHeadsEqualV2(head, candidate)).toBe(false);
    }
    expect(
      providerHeadsEqualV2(
        { ...head, stateHash: head.stateHash.subarray(0, 31) },
        head,
      ),
    ).toBe(false);

    const cloned = cloneProviderHeadV2(head);
    expect(Object.isFrozen(cloned)).toBe(true);
    expect(cloned.stateHash).not.toBe(head.stateHash);
    head.stateHash[0] = head.stateHash[0]! ^ 1;
    expect(cloned.stateHash).toEqual(bytes(0x31));
  });

  test("clones every public transition buffer and nested head", () => {
    const fixture = directCandidateFixture();
    const source = fixture.publicTransition;
    const cloned = cloneProviderPublicTransitionV2(source);
    const expectedCommit = source.commitBytes.slice();
    const expectedWelcome = source.welcomeBytes.slice();
    const expectedRoster = source.rosterBytes.slice();
    const expectedHeadHash = source.expectedHead.stateHash.slice();
    const nextHeadHash = source.nextHead.stateHash.slice();

    expect(Object.isFrozen(cloned)).toBe(true);
    expect(cloned.formatVersion).toBe(2);
    expect(cloned.commitBytes).not.toBe(source.commitBytes);
    expect(cloned.welcomeBytes).not.toBe(source.welcomeBytes);
    expect(cloned.rosterBytes).not.toBe(source.rosterBytes);
    source.commitBytes.fill(0xff);
    source.welcomeBytes.fill(0xff);
    source.rosterBytes.fill(0xff);
    source.expectedHead.stateHash.fill(0xff);
    source.nextHead.stateHash.fill(0xff);
    expect(cloned.commitBytes).toEqual(expectedCommit);
    expect(cloned.welcomeBytes).toEqual(expectedWelcome);
    expect(cloned.rosterBytes).toEqual(expectedRoster);
    expect(cloned.expectedHead.stateHash).toEqual(expectedHeadHash);
    expect(cloned.nextHead.stateHash).toEqual(nextHeadHash);
  });

  test("clones each valid provider operation and rejects an invalid operation exactly", () => {
    const source = directCandidateFixture().publicTransition;
    for (const operation of ["add", "remove", "update"] as const) {
      expect(
        cloneProviderPublicTransitionV2({ ...source, operation }).operation,
      ).toBe(operation);
    }
    expect(() =>
      cloneProviderPublicTransitionV2({
        ...source,
        operation: "invalid" as never,
      })
    ).toThrow(
      new ProviderCandidateStateError(
        "Provider transition operation is invalid",
      ),
    );
  });

  test("strictly validates every public transition field and boundary", () => {
    const fixture = directCandidateFixture();
    const source = fixture.publicTransition;
    const validate = (changes: Record<string, unknown>) =>
      validateProviderPublicTransitionV2({ ...source, ...changes });
    const message = (changes: Record<string, unknown>): string => {
      try {
        validate(changes);
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    };

    const validated = validate({});
    expect(validated).toEqual(source);
    expect(validated).not.toBe(source);
    for (const value of [null, [], "transition", 1]) {
      expect(() =>
        validateProviderPublicTransitionV2(value)
      ).toThrow("Provider public transition fields are invalid");
    }
    expect(message({ unexpected: true })).toBe(
      "Provider public transition fields are invalid",
    );
    const { rosterBytes: substitutedRoster, ...substitutedFields } = source;
    expect(() =>
      validateProviderPublicTransitionV2({
        ...substitutedFields,
        unexpected: substitutedRoster,
      })
    ).toThrow("Provider public transition fields are invalid");
    const { rosterBytes: _rosterBytes, ...missingRoster } = source;
    expect(() =>
      validateProviderPublicTransitionV2(missingRoster)
    ).toThrow("Provider public transition fields are invalid");
    const { welcomeHash: _welcomeHash, ...missingLastField } = source;
    expect(() =>
      validateProviderPublicTransitionV2(missingLastField)
    ).toThrow("Provider public transition fields are invalid");

    for (const [changes, expected] of [
      [{ formatVersion: 1 }, "Provider public transition fields are invalid"],
      [{ providerId: 1 }, "Provider public transition fields are invalid"],
      [{ domainId: 1 }, "Provider public transition fields are invalid"],
      [{ targetHumanId: 1 }, "Provider public transition fields are invalid"],
      [{ targetDeviceId: 1 }, "Provider public transition fields are invalid"],
      [{ operation: "invalid" }, "Provider public transition fields are invalid"],
    ] as const) {
      expect(message(changes)).toBe(expected);
    }
    for (const operation of ["add", "remove", "update"] as const) {
      expect(validate({ operation }).operation).toBe(operation);
    }
    expect(message({ providerId: "" })).toContain("Provider id");

    const invalidHeadCases: readonly [string, unknown, string][] = [
      ["null", null, "Provider expected head fields are invalid"],
      ["array", [], "Provider expected head fields are invalid"],
      ["extra", { ...source.expectedHead, unexpected: true },
        "Provider expected head fields are invalid"],
      ["provider", { ...source.expectedHead, providerId: 1 },
        "Provider expected head provider id is invalid"],
      ["provider-id", { ...source.expectedHead, providerId: "" },
        "Provider expected head provider id must be 1-128 ASCII bytes using the portable identifier grammar"],
      ["domain", { ...source.expectedHead, domainId: 1 },
        "Provider expected head Domain id is invalid"],
      ["epoch", { ...source.expectedHead, epoch: "10" },
        "Provider expected head epoch is invalid"],
      ["hash-type", { ...source.expectedHead, stateHash: "hash" },
        "Provider expected head hash must be exactly 32 bytes"],
      ["hash-length", { ...source.expectedHead, stateHash: bytes(1).slice(1) },
        "Provider expected head hash must be exactly 32 bytes"],
    ];
    for (const [name, expectedHead, expected] of invalidHeadCases) {
      expect(message({ expectedHead }), name).toBe(expected);
    }
    expect(message({
      nextHead: { ...source.nextHead, providerId: 1 },
    })).toBe("Provider next head provider id is invalid");

    const coordinateCases = [
      { expectedHead: { ...source.expectedHead, providerId: "provider-other" } },
      { nextHead: { ...source.nextHead, providerId: "provider-other" } },
      { expectedHead: {
        ...source.expectedHead,
        domainId: cryptoDomainId("domain_other"),
      } },
      { nextHead: {
        ...source.nextHead,
        domainId: cryptoDomainId("domain_other"),
      } },
    ];
    for (const changes of coordinateCases) {
      expect(message(changes)).toBe(
        "Provider public transition coordinates are invalid",
      );
    }
    for (const epoch of [source.expectedHead.epoch, domainEpoch(12)]) {
      expect(message({
        nextHead: { ...source.nextHead, epoch },
      })).toBe(
        "Provider public transition epoch must advance exactly once",
      );
    }

    for (const commitBytes of [
      "commit",
      new Uint8Array(),
      new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
    ]) {
      expect(message({ commitBytes })).toBe(
        "Provider public transition commit bytes are invalid",
      );
    }
    for (const commitBytes of [
      new Uint8Array([1]),
      new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES),
    ]) {
      expect(validate({ commitBytes }).commitBytes).toHaveLength(
        commitBytes.length,
      );
    }
    for (const welcomeHash of ["hash", bytes(1).slice(1)]) {
      expect(message({ welcomeHash })).toBe(
        "Provider public transition Welcome hash is invalid",
      );
    }
    expect(validate({ welcomeBytes: new Uint8Array() }).welcomeBytes)
      .toHaveLength(0);
    for (const welcomeBytes of [
      "welcome",
      new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
    ]) {
      expect(message({ welcomeBytes })).toBe(
        "Provider public transition Welcome bytes are invalid",
      );
    }
    expect(validate({
      welcomeBytes: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES),
    }).welcomeBytes).toHaveLength(V2_PROVIDER_STATE_MAX_BYTES);
    for (const rosterBytes of [
      "roster",
      new Uint8Array(),
      new Uint8Array(256 * 1024 + 1),
    ]) {
      expect(message({ rosterBytes })).toBe(
        "Provider public transition roster bytes are invalid",
      );
    }
    for (const rosterBytes of [
      new Uint8Array([1]),
      new Uint8Array(256 * 1024),
    ]) {
      expect(validate({ rosterBytes }).rosterBytes).toHaveLength(
        rosterBytes.length,
      );
    }
  });

  test("strictly decodes authenticated provider rosters and canonical membership", () => {
    const roster = (
      domain: string,
      entries: readonly {
        leafIndex: number;
        human: string;
        device: string;
      }[],
    ) => concatV2(
      frameText(domain),
      encodeU32(entries.length),
      ...entries.flatMap((entry) => [
        encodeU32(entry.leafIndex),
        frameText(entry.human),
        frameText(entry.device),
      ]),
    );
    const entries = [
      { leafIndex: 2, human: "human_alice", device: "device_alice" },
      { leafIndex: 7, human: "human_bob", device: "device_bob" },
    ] as const;
    for (const [providerId, domain] of [
      ["ts-mls-v2", "nautilo/lattice-crypto/ts-mls-roster/v2"],
      ["openmls-v2", "nautilo/lattice-crypto/openmls-roster/v2"],
    ] as const) {
      expect(decodeProviderRosterV2(
        providerId,
        roster(domain, entries),
      )).toEqual(entries.map((entry) => ({
        leafIndex: entry.leafIndex,
        humanId: humanId(entry.human),
        deviceId: cryptoDeviceId(entry.device),
      })));
    }
    expect(() =>
      decodeProviderRosterV2(
        "dummy-v2",
        roster("nautilo/lattice-crypto/ts-mls-roster/v2", entries),
      )
    ).toThrow("Provider roster format dummy-v2 is not supported");
    expect(() => decodeProviderRosterV2("", new Uint8Array([1])))
      .toThrow(
        "Provider id must be 1-128 ASCII bytes using the portable identifier grammar",
      );
    for (const bytes of ["roster", new Uint8Array()]) {
      expect(() =>
        decodeProviderRosterV2("ts-mls-v2", bytes as never)
      ).toThrow("Provider roster bytes are invalid");
    }
    expect(() =>
      decodeProviderRosterV2(
        "ts-mls-v2",
        new Uint8Array(V2_LIMITS.namespaceKeyringBytes + 1),
      )
    ).toThrow("Provider roster bytes are invalid");
    for (const boundary of [
      new Uint8Array([1]),
      new Uint8Array(V2_LIMITS.namespaceKeyringBytes),
    ]) {
      try {
        decodeProviderRosterV2("ts-mls-v2", boundary);
        throw new Error("expected malformed boundary roster rejection");
      } catch (error) {
        expect((error as Error).message).not.toBe(
          "Provider roster bytes are invalid",
        );
      }
    }
    expect(() =>
      decodeProviderRosterV2(
        "ts-mls-v2",
        roster("nautilo/lattice-crypto/openmls-roster/v2", entries),
      )
    ).toThrow("Provider roster domain is invalid");
    expect(() =>
      decodeProviderRosterV2("ts-mls-v2", roster(
        "nautilo/lattice-crypto/ts-mls-roster/v2",
        [{ ...entries[0], leafIndex: V2_LIMITS.deviceLeavesPerDomain }],
      ))
    ).toThrow("Provider roster leaf index is out of bounds");
    for (const duplicate of [
      [entries[0], { ...entries[1], device: entries[0].device }],
      [entries[0], { ...entries[1], leafIndex: entries[0].leafIndex }],
    ]) {
      expect(() =>
        decodeProviderRosterV2("ts-mls-v2", roster(
          "nautilo/lattice-crypto/ts-mls-roster/v2",
          duplicate,
        ))
      ).toThrow("Provider roster contains a duplicate identity");
    }
    expect(() =>
      decodeProviderRosterV2("ts-mls-v2", roster(
        "nautilo/lattice-crypto/ts-mls-roster/v2",
        [entries[1], entries[0]],
      ))
    ).toThrow("Provider roster is not in canonical leaf order");
    const tooManyHumans = Array.from(
      { length: V2_LIMITS.humanParticipantsPerDomain + 1 },
      (_, index) => ({
        leafIndex: index,
        human: `human_${index}`,
        device: `device_${index}`,
      }),
    );
    expect(() =>
      decodeProviderRosterV2("ts-mls-v2", roster(
        "nautilo/lattice-crypto/ts-mls-roster/v2",
        tooManyHumans,
      ))
    ).toThrow("Provider roster exceeds the Human limit");
    const maximumHumans = tooManyHumans.slice(
      0,
      V2_LIMITS.humanParticipantsPerDomain,
    );
    expect(decodeProviderRosterV2("ts-mls-v2", roster(
      "nautilo/lattice-crypto/ts-mls-roster/v2",
      maximumHumans,
    ))).toHaveLength(V2_LIMITS.humanParticipantsPerDomain);
  });

  test("redacts only target Welcome bytes from a validated transition", () => {
    const source = directCandidateFixture().publicTransition;
    const redacted = redactProviderWelcomeV2(source);
    expect(redacted).toEqual({
      ...source,
      welcomeBytes: new Uint8Array(),
    });
    expect(redacted).not.toBe(source);
    expect(redacted.expectedHead).not.toBe(source.expectedHead);
    expect(redacted.commitBytes).not.toBe(source.commitBytes);
    expect(redacted.welcomeHash).not.toBe(source.welcomeHash);
    expect(() =>
      redactProviderWelcomeV2({
        ...source,
        commitBytes: new Uint8Array(),
      })
    ).toThrow("Provider public transition commit bytes are invalid");
  });

  test("binds the public-transition digest to every coordinate and byte field", () => {
    const fixture = directCandidateFixture();
    const digest = providerPublicTransitionDigestV2(
      fixture.crypto,
      fixture.publicTransition,
    );
    expect(digest).toHaveLength(32);
    expect(
      providerPublicTransitionDigestMatchesV2(
        fixture.crypto,
        fixture.publicTransition,
        digest,
      ),
    ).toBe(true);
    expect(
      providerPublicTransitionDigestMatchesV2(
        fixture.crypto,
        fixture.publicTransition,
        digest.subarray(0, 31),
      ),
    ).toBe(false);
    expect(
      providerPublicTransitionDigestMatchesV2(
        fixture.crypto,
        fixture.publicTransition,
        new Uint8Array([...digest, 0]),
      ),
    ).toBe(false);
    const oneByteWrong = digest.slice();
    oneByteWrong[0] = oneByteWrong[0]! ^ 1;
    expect(
      providerPublicTransitionDigestMatchesV2(
        fixture.crypto,
        fixture.publicTransition,
        oneByteWrong,
      ),
    ).toBe(false);

    const variants: ProviderPublicTransitionV2[] = [
      { ...fixture.publicTransition, providerId: "provider-other" },
      {
        ...fixture.publicTransition,
        domainId: cryptoDomainId("domain_other"),
      },
      {
        ...fixture.publicTransition,
        operation: "remove",
      },
      {
        ...fixture.publicTransition,
        targetHumanId: humanId("human_other"),
      },
      {
        ...fixture.publicTransition,
        targetDeviceId: cryptoDeviceId("device_other"),
      },
      {
        ...fixture.publicTransition,
        expectedHead: {
          ...fixture.expectedHead,
          epoch: domainEpoch(9),
        },
      },
      {
        ...fixture.publicTransition,
        nextHead: {
          ...fixture.nextHead,
          epoch: domainEpoch(12),
        },
      },
      {
        ...fixture.publicTransition,
        commitBytes: new Uint8Array([0x41, 0x43]),
      },
      {
        ...fixture.publicTransition,
        welcomeHash: new Uint8Array(32).fill(0x54),
      },
      {
        ...fixture.publicTransition,
        rosterBytes: new Uint8Array([0x61, 0x62, 0x63, 0x65]),
      },
    ];
    for (const transition of variants) {
      expect(
        providerPublicTransitionDigestV2(fixture.crypto, transition),
      ).not.toEqual(digest);
    }
  });

  test("owns the public-transition digest returned by the crypto provider", () => {
    const fixture = directCandidateFixture();
    const providerDigest = Buffer.alloc(32, 0xd1);
    fixture.crypto.hash = () => providerDigest;

    const digest = providerPublicTransitionDigestV2(
      fixture.crypto,
      fixture.publicTransition,
    );
    expect(digest).not.toBe(providerDigest);
    expect(Buffer.isBuffer(digest)).toBe(false);
    providerDigest.fill(0);
    expect(digest).toEqual(new Uint8Array(32).fill(0xd1));
  });

  test("validates provider head hashes and computed transition digests exactly", () => {
    const fixture = directCandidateFixture();
    expect(() =>
      providerPublicTransitionDigestV2(fixture.crypto, {
        ...fixture.publicTransition,
        expectedHead: {
          ...fixture.expectedHead,
          stateHash: bytes(1).subarray(0, 31),
        },
      })
    ).toThrow("Provider head hash must be exactly 32 bytes");
    expect(() =>
      providerPublicTransitionDigestV2(fixture.crypto, {
        ...fixture.publicTransition,
        expectedHead: {
          ...fixture.expectedHead,
          stateHash: null as never,
        },
      })
    ).toThrow("Provider head hash must be exactly 32 bytes");
    expect(() =>
      providerPublicTransitionDigestV2(fixture.crypto, {
        ...fixture.publicTransition,
        expectedHead: {
          ...fixture.expectedHead,
          providerId: "",
        },
      })
    ).toThrow("Provider id");

    const crypto = new ShortHashCrypto(seededRng(919));
    const shortFixture = directCandidateFixture();
    const vault = DeviceProviderStateVaultV2.fromKey(
      crypto,
      cryptoDeviceId("device_short_hash"),
      bytes(0xa6),
    );
    expect(() =>
      sealLocalProviderCandidateV2({
        crypto,
        vault,
        providerId: shortFixture.expectedHead.providerId,
        domainId: shortFixture.expectedHead.domainId,
        expectedHead: shortFixture.expectedHead,
        nextHead: shortFixture.nextHead,
        publicTransition: shortFixture.publicTransition,
        payload: shortFixture.payload,
      })
    ).toThrow(
      "Provider public transition digest must be exactly 32 bytes",
    );
  });

  test("rejects every mismatched public-transition coordinate before sealing", () => {
    const make = () => directCandidateFixture();
    const mutateTransition = (
      mutate: (transition: ProviderPublicTransitionV2) =>
        ProviderPublicTransitionV2,
    ) => {
      const fixture = make();
      expect(() =>
        sealDirectCandidate(fixture, {
          publicTransition: mutate(fixture.publicTransition),
        })
      ).toThrow("Provider candidate transition coordinates differ");
      expect(fixture.crypto.sealedPlaintext).toBeNull();
    };

    mutateTransition((transition) => ({
      ...transition,
      formatVersion: 1 as never,
    }));
    mutateTransition((transition) => ({
      ...transition,
      providerId: "provider-other",
    }));
    mutateTransition((transition) => ({
      ...transition,
      domainId: cryptoDomainId("domain_other"),
    }));
    mutateTransition((transition) => ({
      ...transition,
      expectedHead: {
        ...transition.expectedHead,
        stateHash: bytes(0xee),
      },
    }));
    mutateTransition((transition) => ({
      ...transition,
      nextHead: {
        ...transition.nextHead,
        stateHash: bytes(0xee),
      },
    }));
  });

  test("locks deterministic candidate ids and owns digest, payload, and plaintext bytes", () => {
    const fixture = directCandidateFixture(929);
    fixture.crypto.hashOutputs.length = 0;
    const payload = fixture.payload.slice();
    const candidate = sealDirectCandidate(fixture, { payload });
    const publicDigestOutput = fixture.crypto.hashOutputs[0]!;

    expect(candidate.candidateId).toMatch(/^candidate_[0-9a-f]{32}$/);
    expect(candidate.candidateId).toBe(
      "candidate_2b8839d008f7a59079268621bd1679b9",
    );
    expect(candidate.publicTransitionDigest).toHaveLength(32);
    expect(candidate.publicTransitionDigest).not.toBe(publicDigestOutput);
    publicDigestOutput.fill(0xff);
    payload.fill(0xff);
    expect(candidate.publicTransitionDigest.some((byte) => byte !== 0xff))
      .toBe(true);
    const opened = openLocalProviderCandidateV2({
      vault: fixture.vault,
      candidate,
    });
    expect(opened.payload).toEqual(fixture.payload);
    destroyOpenedProviderCandidateStateV2(opened);
    expect(opened.payload.every((byte) => byte === 0)).toBe(true);
    expect(
      opened.publicTransitionDigest.every((byte) => byte === 0),
    ).toBe(true);
    expect(
      fixture.crypto.sealedPlaintext!.every((byte) => byte === 0),
    ).toBe(true);
    expect(
      fixture.crypto.openedPlaintext!.every((byte) => byte === 0),
    ).toBe(true);

    const same = sealDirectCandidate(directCandidateFixture(929));
    expect(same.candidateId).toBe(candidate.candidateId);
    const differentSource = sealDirectCandidate(directCandidateFixture(929), {
      sourceId: "provider-transition-other",
    });
    expect(differentSource.candidateId).not.toBe(candidate.candidateId);
    const differentPublic = directCandidateFixture(929);
    differentPublic.publicTransition.commitBytes[0] =
      differentPublic.publicTransition.commitBytes[0]! ^ 1;
    expect(sealDirectCandidate(differentPublic).candidateId).not.toBe(
      candidate.candidateId,
    );
    expect(() =>
      sealDirectCandidate(directCandidateFixture(), { sourceId: "" })
    ).toThrow("Candidate source id");
  });

  test("encodes and reopens every terminal lifecycle tombstone exactly", () => {
    for (const lifecycle of ["applied", "aborted", "stale"] as const) {
      const fixture = directCandidateFixture(939);
      const candidate = sealDirectCandidate(fixture);
      const digest = candidate.publicTransitionDigest.slice();
      markLocalProviderCandidateV2({
        vault: fixture.vault,
        candidate,
        lifecycle,
      });
      const opened = openLocalProviderCandidateV2({
        vault: fixture.vault,
        candidate,
      });
      expect(opened.lifecycle).toBe(lifecycle);
      expect(opened.sourceId).toBe(V2_PROVIDER_CANDIDATE_SOURCE_ID);
      expect(opened.publicTransitionDigest).toEqual(digest);
      expect(opened.payload.every((byte) => byte === 0)).toBe(true);
      destroyOpenedProviderCandidateStateV2(opened);
    }
  });

  test("rejects a non-size-preserving tombstone and wipes its plaintext", () => {
    const fixture = directCandidateFixture(940);
    const candidate = sealDirectCandidate(fixture);
    const originalSeal = fixture.vault.seal.bind(fixture.vault);
    fixture.vault.seal = (...args) => {
      const sealed = originalSeal(...args);
      return Object.freeze({
        ...sealed,
        ciphertext: new Uint8Array(sealed.ciphertext.length + 1),
      }) as SealedProviderStateV2;
    };

    expect(() =>
      markLocalProviderCandidateV2({
        vault: fixture.vault,
        candidate,
        lifecycle: "aborted",
      })
    ).toThrow("Candidate tombstone length changed unexpectedly");
    expect(
      fixture.crypto.sealedPlaintext!.every((byte) => byte === 0),
    ).toBe(true);
  });

  test("rejects every invalid external candidate coordinate before opening", () => {
    const variants: Array<
      (candidate: LocalProviderCandidateV2) => void
    > = [
      (candidate) => {
        (candidate as unknown as { providerId: string }).providerId =
          "provider-other";
      },
      (candidate) => {
        (candidate.expectedHead as unknown as { providerId: string })
          .providerId = "provider-other";
      },
      (candidate) => {
        (candidate.nextHead as unknown as { providerId: string }).providerId =
          "provider-other";
      },
      (candidate) => {
        (candidate.expectedHead as unknown as { domainId: string }).domainId =
          "domain-other";
      },
      (candidate) => {
        (candidate.nextHead as unknown as { domainId: string }).domainId =
          "domain-other";
      },
      (candidate) => {
        (candidate as unknown as { deviceId: string }).deviceId =
          "device-other";
      },
      (candidate) => {
        (candidate as unknown as { deviceId: string }).deviceId =
          "device-other";
        (candidate.snapshot as unknown as { deviceId: string }).deviceId =
          "device-other";
      },
      (candidate) => {
        (candidate.snapshot as unknown as { providerId: string }).providerId =
          "provider-other";
      },
      (candidate) => {
        (candidate.snapshot as unknown as { domainId: string }).domainId =
          "domain-other";
      },
      (candidate) => {
        (candidate.snapshot as unknown as { deviceId: string }).deviceId =
          "device-other";
      },
      (candidate) => {
        (candidate.snapshot as unknown as { revision: number }).revision = 12;
      },
      (candidate) => {
        (candidate.snapshot as unknown as { snapshotKind: string })
          .snapshotKind = "active";
      },
      (candidate) => {
        (candidate as unknown as { publicTransitionDigest: unknown })
          .publicTransitionDigest = null;
      },
      (candidate) => {
        (candidate as unknown as { publicTransitionDigest: Uint8Array })
          .publicTransitionDigest = bytes(1).subarray(0, 31);
      },
    ];

    for (const mutate of variants) {
      const fixture = directCandidateFixture();
      const candidate = structuredClone(
        sealDirectCandidate(fixture),
      );
      mutate(candidate);
      expect(() =>
        openLocalProviderCandidateV2({
          vault: fixture.vault,
          candidate,
        })
      ).toThrow("External candidate coordinates are invalid");
    }
  });

  test("rejects each sealed identity coordinate and malformed lifecycle exactly", () => {
    const mutations: Array<{
      readonly field:
        | "candidateId"
        | "providerId"
        | "domainId"
        | "deviceId"
        | "expectedHash"
        | "nextHash"
        | "transitionDigest";
    }> = [
      { field: "candidateId" },
      { field: "providerId" },
      { field: "domainId" },
      { field: "deviceId" },
      { field: "expectedHash" },
      { field: "nextHash" },
      { field: "transitionDigest" },
    ];
    for (const { field } of mutations) {
      const fixture = directCandidateFixture();
      const candidate = sealDirectCandidate(fixture);
      const plaintext = fixture.vault.open(candidate.snapshot, {
        providerId: candidate.providerId,
        domainId: candidate.domainId,
        revision: candidate.nextHead.epoch,
        snapshotKind: "candidate",
      })!;
      const offsets = candidatePlaintextOffsets(plaintext);
      plaintext[offsets[field]] = plaintext[offsets[field]]! ^ 1;
      const malformed = resealCandidatePlaintext(
        fixture,
        candidate,
        plaintext,
      );
      plaintext.fill(0);
      expect(() =>
        openLocalProviderCandidateV2({
          vault: fixture.vault,
          candidate: malformed,
        })
      ).toThrow(
        "External candidate does not match its sealed candidate identity",
      );
      expect(
        fixture.crypto.openedPlaintext!.every((byte) => byte === 0),
      ).toBe(true);
    }

    const lifecycleFixture = directCandidateFixture();
    const candidate = sealDirectCandidate(lifecycleFixture);
    const plaintext = lifecycleFixture.vault.open(candidate.snapshot, {
      providerId: candidate.providerId,
      domainId: candidate.domainId,
      revision: candidate.nextHead.epoch,
      snapshotKind: "candidate",
    })!;
    const offsets = candidatePlaintextOffsets(plaintext);
    new DataView(
      plaintext.buffer,
      plaintext.byteOffset,
      plaintext.byteLength,
    ).setUint32(offsets.lifecycle, 9);
    const malformedLifecycle = resealCandidatePlaintext(
      lifecycleFixture,
      candidate,
      plaintext,
    );
    expect(() =>
      openLocalProviderCandidateV2({
        vault: lifecycleFixture.vault,
        candidate: malformedLifecycle,
      })
    ).toThrow("Sealed candidate lifecycle is invalid");
  });

  test("rejects a malformed sealed candidate domain and an unopened snapshot exactly", () => {
    const fixture = directCandidateFixture();
    const candidate = sealDirectCandidate(fixture);
    const plaintext = fixture.vault.open(candidate.snapshot, {
      providerId: candidate.providerId,
      domainId: candidate.domainId,
      revision: candidate.nextHead.epoch,
      snapshotKind: "candidate",
    })!;
    const offsets = candidatePlaintextOffsets(plaintext);
    plaintext[offsets.stateDomain] = plaintext[offsets.stateDomain]! ^ 1;
    const malformedDomain = resealCandidatePlaintext(
      fixture,
      candidate,
      plaintext,
    );
    expect(() =>
      openLocalProviderCandidateV2({
        vault: fixture.vault,
        candidate: malformedDomain,
      })
    ).toThrow("Sealed candidate domain is invalid");

    const unopened = structuredClone(candidate);
    unopened.snapshot.ciphertext[0] =
      unopened.snapshot.ciphertext[0]! ^ 1;
    expect(() =>
      openLocalProviderCandidateV2({
        vault: fixture.vault,
        candidate: unopened,
      })
    ).toThrow("Unable to open sealed candidate state");
  });

  test("reports exact labels for malformed sealed hash and digest frames", () => {
    for (
      const [field, message] of [
        ["expectedHash", "Provider head hash must be exactly 32 bytes"],
        [
          "transitionDigest",
          "Provider public transition digest must be exactly 32 bytes",
        ],
      ] as const
    ) {
      const fixture = directCandidateFixture();
      const candidate = sealDirectCandidate(fixture);
      const plaintext = fixture.vault.open(candidate.snapshot, {
        providerId: candidate.providerId,
        domainId: candidate.domainId,
        revision: candidate.nextHead.epoch,
        snapshotKind: "candidate",
      })!;
      const offsets = candidatePlaintextOffsets(plaintext);
      const malformed = shortenFixedFrame(plaintext, offsets[field]);
      const malformedCandidate = resealCandidatePlaintext(
        fixture,
        candidate,
        malformed,
      );
      plaintext.fill(0);
      malformed.fill(0);

      expect(() =>
        openLocalProviderCandidateV2({
          vault: fixture.vault,
          candidate: malformedCandidate,
        })
      ).toThrow(message);
    }
  });

  test("detaches candidate payload snapshots from opened payload bytes", () => {
    const fixture = directCandidateFixture();
    const candidate = sealDirectCandidate(fixture);
    const opened = openLocalProviderCandidateV2({
      vault: fixture.vault,
      candidate,
    });
    const snapshot = candidatePayloadSnapshotV2(
      candidate,
      opened.payload,
    );
    const expected = snapshot.ciphertext.slice();
    opened.payload.fill(0xff);
    expect(snapshot.ciphertext).toEqual(expected);
    expect(snapshot.ciphertext).not.toBe(opened.payload);
    destroyOpenedProviderCandidateStateV2(opened);
  });

  test("wipes both decrypted copies of sealed candidate plaintext", () => {
    const fixture = directCandidateFixture(909_1);
    const candidate = sealDirectCandidate(fixture);
    const fills = recordZeroFills();
    let opened: ReturnType<typeof openLocalProviderCandidateV2>;
    try {
      opened = openLocalProviderCandidateV2({
        vault: fixture.vault,
        candidate,
      });
    } finally {
      fills.restore();
    }
    const domain = new TextEncoder().encode(
      "nautilo/lattice-crypto/provider-candidate-state/v2",
    );
    expect(
      fills.snapshots.filter((snapshot) => containsBytes(snapshot, domain)),
    ).toHaveLength(4);
    destroyOpenedProviderCandidateStateV2(opened!);
  });

  test("wipes opened candidate material after lifecycle tombstoning", () => {
    const fixture = directCandidateFixture(909_2);
    const candidate = sealDirectCandidate(fixture);
    const probe = openLocalProviderCandidateV2({
      vault: fixture.vault,
      candidate,
    });
    const expectedPayload = probe.payload.slice();
    destroyOpenedProviderCandidateStateV2(probe);
    const fills = recordZeroFills();
    try {
      markLocalProviderCandidateV2({
        vault: fixture.vault,
        candidate,
        lifecycle: "aborted",
      });
    } finally {
      fills.restore();
    }
    expect(
      fills.snapshots.some((snapshot) =>
        snapshot.length === expectedPayload.length
        && snapshot.every((byte, index) => byte === expectedPayload[index])
      ),
    ).toBe(true);
    expectedPayload.fill(0);
  });

  test("exports Human and AI roots through the exact direct v2 exporter labels", async () => {
    const { active, crypto, provider } = setup();

    const roots = await provider.exportDomainRoots(active);

    expect(roots.human).toHaveLength(32);
    expect(roots.ai).toHaveLength(32);
    expect(roots.human).not.toEqual(roots.ai);
    expect(crypto.derivationLabels).toContain(
      HUMAN_DOMAIN_ROOT_EXPORTER_LABEL,
    );
    expect(crypto.derivationLabels).toContain(AI_DOMAIN_ROOT_EXPORTER_LABEL);
  });

  test("wipes a derived Human root when the AI root export fails", async () => {
    const { active, crypto, provider } = setup(109_1);
    crypto.failDerivationForLabel(
      AI_DOMAIN_ROOT_EXPORTER_LABEL,
      new Error("AI root export failed"),
    );

    expect(provider.exportDomainRoots(active)).rejects.toThrow(
      "AI root export failed",
    );
    expect(crypto.derivationOutputs).toHaveLength(1);
    expect(crypto.derivationOutputs[0]?.every((byte) => byte === 0)).toBe(
      true,
    );
  });

  test("preserves a Human root export failure before any root exists", () => {
    const { active, crypto, provider } = setup(109_2);
    crypto.failNextDerivationWith(new Error("Human root export failed"));

    expect(provider.exportDomainRoots(active)).rejects.toThrow(
      "Human root export failed",
    );
    expect(crypto.derivationOutputs).toHaveLength(0);
  });

  test("exposes the stable provider-state error identity", () => {
    const error = new V2ProviderStateError("provider failed");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("V2ProviderStateError");
    expect(error.message).toBe("provider failed");
  });

  test("separates detached relay-safe output from the sealed local candidate", async () => {
    const { active, provider } = setup();

    const prepared = await provider.prepareCommit({ active });
    const serializedPublic = JSON.stringify(prepared.publicResult);

    expect(prepared.publicResult).not.toHaveProperty("candidate");
    expect(prepared.publicResult).not.toHaveProperty("ciphertext");
    expect(serializedPublic).not.toContain(bytes(0x5a).join(","));
    expect(prepared.localCandidate.snapshot.classification).toBe(
      "device-local-provider-ciphertext",
    );
    expect(Number(prepared.publicResult.expectedHead.epoch)).toBe(7);
    expect(Number(prepared.publicResult.nextHead.epoch)).toBe(8);

    const originalCommitByte = prepared.publicResult.commitBytes[0]!;
    prepared.publicResult.commitBytes[0] = originalCommitByte ^ 0xff;
    const applied = provider.applyCandidate({
      active,
      candidate: prepared.localCandidate,
    });

    expect(applied.status).toBe("applied");
    expect(Number(provider.publicHead(applied.active).epoch)).toBe(8);
  });

  test("fails closed on tampered state or the wrong device-local vault key", () => {
    const { active, crypto, deviceId, domainId, provider, vault } = setup(109);
    for (
      const invalid of [
        { ...active, providerId: "other-v2" },
        { ...active, deviceId: cryptoDeviceId("other_phone") },
        { ...active, snapshotKind: "candidate" as const },
      ]
    ) {
      expect(() => provider.publicHead(invalid)).toThrow(
        "Invalid active provider snapshot coordinates",
      );
    }

    const plaintext = vault.open(active, {
      providerId: active.providerId,
      domainId: active.domainId,
      revision: active.revision,
      snapshotKind: "active",
    })!;
    const offsets = dummyStatePlaintextOffsets(plaintext);
    const wrongDomainPlaintext = plaintext.slice();
    wrongDomainPlaintext.set(
      new TextEncoder().encode("domain_cd"),
      offsets.domainId,
    );
    const wrongDomainState = vault.seal(
      {
        providerId: active.providerId,
        domainId,
        revision: active.revision,
        snapshotKind: "active",
      },
      wrongDomainPlaintext,
    );
    expect(() => provider.publicHead(wrongDomainState)).toThrow(
      "active provider snapshot metadata mismatch",
    );
    const wrongEpochPlaintext = plaintext.slice();
    new DataView(
      wrongEpochPlaintext.buffer,
      wrongEpochPlaintext.byteOffset,
      wrongEpochPlaintext.byteLength,
    ).setBigUint64(offsets.epoch, 8n);
    const wrongEpochState = vault.seal(
      {
        providerId: active.providerId,
        domainId,
        revision: active.revision,
        snapshotKind: "active",
      },
      wrongEpochPlaintext,
    );
    expect(() => provider.publicHead(wrongEpochState)).toThrow(
      "active provider snapshot metadata mismatch",
    );

    const tampered = structuredClone(active);
    const lastCiphertextIndex = tampered.ciphertext.length - 1;
    tampered.ciphertext[lastCiphertextIndex] =
      tampered.ciphertext[lastCiphertextIndex]! ^ 0x01;
    expect(() => provider.publicHead(tampered)).toThrow(
      "Unable to open active provider snapshot",
    );

    const wrongVaultProvider = new DummyV2GroupProvider(
      crypto,
      DeviceProviderStateVaultV2.fromKey(crypto, deviceId, bytes(0xff)),
    );
    expect(() => wrongVaultProvider.publicHead(active)).toThrow(
      "Unable to open active provider snapshot",
    );
    plaintext.fill(0);
    wrongDomainPlaintext.fill(0);
    wrongEpochPlaintext.fill(0);
  });

  test("prepares an incoming commit on an isolated device snapshot", async () => {
    const alice = setup(111);
    const bobCrypto = new RecordingCrypto(seededRng(222));
    const bobVault = DeviceProviderStateVaultV2.fromKey(
      bobCrypto,
      cryptoDeviceId("bob_phone"),
      bytes(0xb2),
    );
    const bob = new DummyV2GroupProvider(bobCrypto, bobVault);
    const bobActive = bob.bootstrapForTesting({
      domainId: alice.domainId,
      epoch: domainEpoch(7),
      exporterSecret: bytes(0x5a),
    });

    const outbound = await alice.provider.prepareCommit({
      active: alice.active,
    });
    const bobCandidate = await bob.prepareIncoming({
      active: bobActive,
      publicResult: outbound.publicResult,
    });

    expect(Number(bob.publicHead(bobActive).epoch)).toBe(7);
    const aliceApplied = alice.provider.applyCandidate({
      active: alice.active,
      candidate: outbound.localCandidate,
    });
    const bobApplied = bob.applyCandidate({
      active: bobActive,
      candidate: bobCandidate,
    });
    expect(aliceApplied.status).toBe("applied");
    expect(bobApplied.status).toBe("applied");
    expect(
      await alice.provider.exportDomainRoots(aliceApplied.active),
    ).toEqual(await bob.exportDomainRoots(bobApplied.active));
    expect(alice.provider.publicHead(aliceApplied.active)).toEqual(
      bob.publicHead(bobApplied.active),
    );
  });

  test("abort and stale CAS preserve the prior usable state", async () => {
    const { active, provider } = setup(303);
    const rootsBefore = await provider.exportDomainRoots(active);
    const first = await provider.prepareCommit({ active });
    const second = await provider.prepareCommit({ active });

    expect(provider.abortCandidate(first.localCandidate).status).toBe(
      "aborted",
    );
    expect(provider.abortCandidate(first.localCandidate).status).toBe(
      "already-aborted",
    );
    expect(first.localCandidate.snapshot.ciphertext.some((byte) => byte !== 0))
      .toBe(true);
    expect(
      provider.applyCandidate({
        active,
        candidate: first.localCandidate,
      }).status,
    ).toBe("aborted");
    expect(await provider.exportDomainRoots(active)).toEqual(rootsBefore);

    const advanced = provider.applyCandidate({
      active,
      candidate: second.localCandidate,
    });
    expect(advanced.status).toBe("applied");
    expect(
      provider.applyCandidate({
        active: advanced.active,
        candidate: first.localCandidate,
      }).status,
    ).toBe("aborted");
    expect(Number(provider.publicHead(advanced.active).epoch)).toBe(8);
  });

  test("duplicate apply is idempotent and a competing candidate becomes stale", async () => {
    const { active, provider } = setup(404);
    const winner = await provider.prepareCommit({ active });
    const loser = await provider.prepareCommit({ active });

    const applied = provider.applyCandidate({
      active,
      candidate: winner.localCandidate,
    });
    expect(applied.status).toBe("applied");

    const appliedTombstone = winner.localCandidate.snapshot.ciphertext.slice();
    const duplicate = provider.applyCandidate({
      active: applied.active,
      candidate: winner.localCandidate,
    });
    expect(duplicate.status).toBe("duplicate");
    expect(winner.localCandidate.snapshot.ciphertext).toEqual(
      appliedTombstone,
    );
    expect(Number(provider.publicHead(duplicate.active).epoch)).toBe(8);

    const stale = provider.applyCandidate({
      active: duplicate.active,
      candidate: loser.localCandidate,
    });
    expect(stale.status).toBe("stale");
    expect(loser.localCandidate.snapshot.ciphertext.some((byte) => byte !== 0))
      .toBe(true);
    expect(provider.abortCandidate(loser.localCandidate).status).toBe(
      "already-aborted",
    );
    expect(
      provider.applyCandidate({
        active: duplicate.active,
        candidate: loser.localCandidate,
      }).status,
    ).toBe("aborted");
    expect(Number(provider.publicHead(stale.active).epoch)).toBe(8);
  });

  test("persists duplicate and applied candidate lifecycle decisions exactly", async () => {
    const { active, domainId, provider } = setup(405);
    const winner = await provider.prepareCommit({ active });
    const independentlyPreparedDuplicate = await provider.prepareIncoming({
      active,
      publicResult: winner.publicResult,
    });
    const applied = provider.applyCandidate({
      active,
      candidate: winner.localCandidate,
    });
    expect(applied.status).toBe("applied");

    expect(
      provider.applyCandidate({
        active: applied.active,
        candidate: independentlyPreparedDuplicate,
      }).status,
    ).toBe("duplicate");
    expect(
      provider.abortCandidate(independentlyPreparedDuplicate).status,
    ).toBe("already-applied");

    expect(() =>
      provider.applyCandidate({
        active,
        candidate: winner.localCandidate,
      })
    ).toThrow("Applied candidate cannot be replayed against its old active head");

    const unrelated = provider.bootstrapForTesting({
      domainId,
      epoch: domainEpoch(99),
      exporterSecret: bytes(0x77),
    });
    expect(
      provider.applyCandidate({
        active: unrelated,
        candidate: winner.localCandidate,
      }).status,
    ).toBe("stale");
    expect(provider.abortCandidate(winner.localCandidate).status).toBe(
      "already-applied",
    );
  });

  test("resolves an ambiguous commit after restart from the sealed candidate", async () => {
    const firstProcess = setup(454);
    const prepared = await firstProcess.provider.prepareCommit({
      active: firstProcess.active,
    });
    const observedCommittedHead = prepared.publicResult.nextHead;

    const restartedCrypto = new RecordingCrypto(seededRng(455));
    const restarted = new DummyV2GroupProvider(
      restartedCrypto,
      DeviceProviderStateVaultV2.fromKey(
        restartedCrypto,
        firstProcess.deviceId,
        bytes(0xa1),
      ),
    );
    expect(prepared.localCandidate.nextHead).toEqual(observedCommittedHead);

    const resolved = restarted.applyCandidate({
      active: firstProcess.active,
      candidate: prepared.localCandidate,
    });
    expect(resolved.status).toBe("applied");
    expect(Number(restarted.publicHead(resolved.active).epoch)).toBe(8);

    const afterApplyRestart = new DummyV2GroupProvider(
      restartedCrypto,
      DeviceProviderStateVaultV2.fromKey(
        restartedCrypto,
        firstProcess.deviceId,
        bytes(0xa1),
      ),
    );
    const duplicate = afterApplyRestart.applyCandidate({
      active: resolved.active,
      candidate: prepared.localCandidate,
    });
    expect(duplicate.status).toBe("duplicate");
    expect(Number(afterApplyRestart.publicHead(duplicate.active).epoch)).toBe(8);
  });

  test("crash-before-apply and retry from the old snapshot advance only once", async () => {
    const firstProcess = setup(505);
    const rootsBefore = await firstProcess.provider.exportDomainRoots(
      firstProcess.active,
    );
    await firstProcess.provider.prepareCommit({ active: firstProcess.active });

    const restartedCrypto = new RecordingCrypto(seededRng(606));
    const restarted = new DummyV2GroupProvider(
      restartedCrypto,
      DeviceProviderStateVaultV2.fromKey(
        restartedCrypto,
        firstProcess.deviceId,
        bytes(0xa1),
      ),
    );

    expect(
      await restarted.exportDomainRoots(firstProcess.active),
    ).toEqual(rootsBefore);
    const retry = await restarted.prepareCommit({
      active: firstProcess.active,
    });
    const applied = restarted.applyCandidate({
      active: firstProcess.active,
      candidate: retry.localCandidate,
    });
    expect(applied.status).toBe("applied");
    expect(Number(restarted.publicHead(applied.active).epoch)).toBe(8);
  });

  test("rejects incoming commits whose exact expected or next head is forged", async () => {
    const { active, provider } = setup(707);
    const prepared = await provider.prepareCommit({ active });

    expect(
      provider.prepareIncoming({
        active,
        publicResult: {
          ...prepared.publicResult,
          expectedHead: {
            ...prepared.publicResult.expectedHead,
            stateHash: bytes(0xed),
          },
        },
      }),
    ).rejects.toThrow("exact expected public head");
    expect(
      provider.prepareIncoming({
        active,
        publicResult: {
          ...prepared.publicResult,
          nextHead: {
            ...prepared.publicResult.nextHead,
            stateHash: bytes(0xee),
          },
        },
      }),
    ).rejects.toThrow("next public head");
  });

  test("normalizes non-error failures while preparing outgoing and incoming commits", async () => {
    const outgoing = setup(707_1);
    outgoing.crypto.failNextRandomWith("random source failed");
    expect(
      outgoing.provider.prepareCommit({ active: outgoing.active }),
    ).rejects.toThrow("Unable to prepare dummy commit");

    const incoming = setup(707_2);
    const prepared = await incoming.provider.prepareCommit({
      active: incoming.active,
    });
    incoming.crypto.failNextDerivationWith("derivation failed");
    expect(
      incoming.provider.prepareIncoming({
        active: incoming.active,
        publicResult: prepared.publicResult,
      }),
    ).rejects.toThrow("Unable to prepare incoming dummy commit");

    const malformedCommit = setup(707_5);
    malformedCommit.crypto.replaceNextRandomWith(new Uint8Array(31));
    expect(
      malformedCommit.provider.prepareCommit({
        active: malformedCommit.active,
      }),
    ).rejects.toThrow("Dummy public commit must be exactly 32 bytes");
  });

  test("validates prepared, applied, stale, and aborted candidate lifecycles exactly", async () => {
    const { active, crypto, provider } = setup(707_3);
    const winner = await provider.prepareCommit({ active });
    const loser = await provider.prepareCommit({ active });
    const aborted = await provider.prepareCommit({ active });

    expect(
      await provider.validatePreparedCandidate({ active, prepared: winner }),
    ).toBeUndefined();
    expect(crypto.openedCiphertext?.every((byte) => byte === 0)).toBe(true);

    const applied = provider.applyCandidate({
      active,
      candidate: winner.localCandidate,
    });
    expect(applied.status).toBe("applied");
    expect(
      await provider.validatePreparedCandidate({
        active: applied.active,
        prepared: winner,
      }),
    ).toBeUndefined();
    expect(() =>
      provider.validatePreparedCandidate({ active, prepared: winner })
    ).toThrow("Applied dummy candidate does not match the active public head");

    expect(() =>
      provider.validatePreparedCandidate({
        active: applied.active,
        prepared: loser,
      })
    ).toThrow("Dummy prepared candidate does not match the active public head");

    expect(provider.abortCandidate(aborted.localCandidate).status).toBe(
      "aborted",
    );
    expect(() =>
      provider.validatePreparedCandidate({ active, prepared: aborted })
    ).toThrow("Dummy prepared candidate does not match the active public head");
  });

  test("wipes every dummy-provider candidate copy at its ownership boundary", async () => {
    const validation = setup(707_31);
    const preparedForValidation = await validation.provider.prepareCommit({
      active: validation.active,
    });
    const validationProbe = openLocalProviderCandidateV2({
      vault: validation.vault,
      candidate: preparedForValidation.localCandidate,
    });
    const validationPayload = validationProbe.payload.slice();
    destroyOpenedProviderCandidateStateV2(validationProbe);
    const validationFills = recordZeroFills();
    try {
      await validation.provider.validatePreparedCandidate({
        active: validation.active,
        prepared: preparedForValidation,
      });
    } finally {
      validationFills.restore();
    }
    expect(
      validationFills.snapshots.filter((snapshot) =>
        snapshot.length === validationPayload.length
        && snapshot.every((byte, index) => byte === validationPayload[index])
      ),
    ).toHaveLength(2);

    const application = setup(707_32);
    const preparedForApplication = await application.provider.prepareCommit({
      active: application.active,
    });
    const applicationProbe = openLocalProviderCandidateV2({
      vault: application.vault,
      candidate: preparedForApplication.localCandidate,
    });
    const applicationPayload = applicationProbe.payload.slice();
    destroyOpenedProviderCandidateStateV2(applicationProbe);
    const applicationFills = recordZeroFills();
    try {
      application.provider.applyCandidate({
        active: application.active,
        candidate: preparedForApplication.localCandidate,
      });
    } finally {
      applicationFills.restore();
    }
    expect(
      applicationFills.snapshots.filter((snapshot) =>
        snapshot.length === applicationPayload.length
        && snapshot.every((byte, index) => byte === applicationPayload[index])
      ),
    ).toHaveLength(3);

    const abortion = setup(707_33);
    const preparedForAbortion = await abortion.provider.prepareCommit({
      active: abortion.active,
    });
    const abortionProbe = openLocalProviderCandidateV2({
      vault: abortion.vault,
      candidate: preparedForAbortion.localCandidate,
    });
    const abortionPayload = abortionProbe.payload.slice();
    destroyOpenedProviderCandidateStateV2(abortionProbe);
    const abortionFills = recordZeroFills();
    try {
      abortion.provider.abortCandidate(
        preparedForAbortion.localCandidate,
      );
    } finally {
      abortionFills.restore();
    }
    expect(
      abortionFills.snapshots.filter((snapshot) =>
        snapshot.length === abortionPayload.length
        && snapshot.every((byte, index) => byte === abortionPayload[index])
      ),
    ).toHaveLength(2);

    validationPayload.fill(0);
    applicationPayload.fill(0);
    abortionPayload.fill(0);
  });

  test("wipes the nested candidate ciphertext after sealing its outer copy", async () => {
    const fixture = setup(707_34);
    const fills = recordZeroFills();
    let prepared: Awaited<ReturnType<typeof fixture.provider.prepareCommit>>;
    try {
      prepared = await fixture.provider.prepareCommit({
        active: fixture.active,
      });
    } finally {
      fills.restore();
    }
    const opened = openLocalProviderCandidateV2({
      vault: fixture.vault,
      candidate: prepared!.localCandidate,
    });
    expect(
      fills.snapshots.some((snapshot) =>
        snapshot.length === opened.payload.length
        && snapshot.every((byte, index) => byte === opened.payload[index])
      ),
    ).toBe(true);
    destroyOpenedProviderCandidateStateV2(opened);
  });

  test("binds a prepared candidate to its public transition and sealed next state", async () => {
    const { active, crypto, provider, vault } = setup(707_4);
    const prepared = await provider.prepareCommit({ active });
    const changedCommit = prepared.publicResult.commitBytes.slice();
    changedCommit[0] = changedCommit[0]! ^ 0xff;

    expect(() =>
      provider.validatePreparedCandidate({
        active,
        prepared: {
          ...prepared,
          publicResult: {
            ...prepared.publicResult,
            commitBytes: changedCommit,
          },
        },
      })
    ).toThrow(
      "Dummy prepared candidate does not match its public transition",
    );

    const opened = openLocalProviderCandidateV2({
      vault,
      candidate: prepared.localCandidate,
    });
    const nested = candidatePayloadSnapshotV2(
      prepared.localCandidate,
      opened.payload,
    );
    destroyOpenedProviderCandidateStateV2(opened);
    const nestedPlaintext = vault.open(nested, {
      providerId: prepared.localCandidate.providerId,
      domainId: prepared.localCandidate.domainId,
      revision: prepared.localCandidate.nextHead.epoch,
      snapshotKind: "candidate",
    })!;
    const offsets = dummyStatePlaintextOffsets(nestedPlaintext);
    nestedPlaintext[offsets.stateHash] =
      nestedPlaintext[offsets.stateHash]! ^ 0xff;
    const mismatchedNested = vault.seal(
      {
        providerId: prepared.localCandidate.providerId,
        domainId: prepared.localCandidate.domainId,
        revision: prepared.localCandidate.nextHead.epoch,
        snapshotKind: "candidate",
      },
      nestedPlaintext,
    );
    const mismatchedCandidate = sealLocalProviderCandidateV2({
      crypto,
      vault,
      providerId: prepared.localCandidate.providerId,
      domainId: prepared.localCandidate.domainId,
      expectedHead: prepared.publicResult.expectedHead,
      nextHead: prepared.publicResult.nextHead,
      publicTransition: prepared.publicResult,
      payload: mismatchedNested.ciphertext,
    });
    expect(() =>
      provider.validatePreparedCandidate({
        active,
        prepared: {
          publicResult: prepared.publicResult,
          localCandidate: mismatchedCandidate,
        },
      })
    ).toThrow(
      "Dummy public transition does not match its sealed candidate",
    );
    expect(() =>
      provider.applyCandidate({
        active,
        candidate: mismatchedCandidate,
      })
    ).toThrow("Candidate state does not match its exact next public head");

    const recomputationTransition = {
      ...prepared.publicResult,
      commitBytes: changedCommit,
    };
    const recomputationCandidate = sealLocalProviderCandidateV2({
      crypto,
      vault,
      providerId: prepared.localCandidate.providerId,
      domainId: prepared.localCandidate.domainId,
      expectedHead: recomputationTransition.expectedHead,
      nextHead: recomputationTransition.nextHead,
      publicTransition: recomputationTransition,
      payload: nested.ciphertext,
    });
    expect(() =>
      provider.validatePreparedCandidate({
        active,
        prepared: {
          publicResult: recomputationTransition,
          localCandidate: recomputationCandidate,
        },
      })
    ).toThrow(
      "Dummy public transition does not match its sealed candidate",
    );

    nested.ciphertext.fill(0);
    nestedPlaintext.fill(0);
    mismatchedNested.ciphertext.fill(0);
  });

  test("rejects every malformed dummy public transition coordinate before candidate work", async () => {
    const { active, provider } = setup(708);
    const prepared = await provider.prepareCommit({ active });
    const transition = prepared.publicResult;
    const invalidTransitions: ProviderPublicTransitionV2[] = [
      { ...transition, formatVersion: 1 as never },
      { ...transition, providerId: "other-v2" },
      {
        ...transition,
        domainId: cryptoDomainId("domain_other"),
        nextHead: {
          ...transition.nextHead,
          domainId: cryptoDomainId("domain_other"),
        },
      },
      {
        ...transition,
        domainId: cryptoDomainId("domain_other"),
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          domainId: cryptoDomainId("domain_other"),
        },
      },
      {
        ...transition,
        expectedHead: {
          ...transition.expectedHead,
          providerId: "other-v2",
        },
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          providerId: "other-v2",
        },
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          epoch: transition.expectedHead.epoch,
        },
      },
      { ...transition, commitBytes: null as never },
      { ...transition, commitBytes: new Uint8Array(31) },
      { ...transition, commitBytes: new Uint8Array(33) },
      { ...transition, welcomeBytes: null as never },
      { ...transition, welcomeBytes: new Uint8Array([1]) },
      { ...transition, welcomeHash: null as never },
      { ...transition, welcomeHash: new Uint8Array(31) },
      { ...transition, welcomeHash: new Uint8Array(33) },
      {
        ...transition,
        welcomeHash: (() => {
          const hash = transition.welcomeHash.slice();
          hash[0] = hash[0]! ^ 0xff;
          return hash;
        })(),
      },
      { ...transition, rosterBytes: null as never },
      { ...transition, rosterBytes: new Uint8Array([1]) },
      {
        ...transition,
        expectedHead: {
          ...transition.expectedHead,
          stateHash: null as never,
        },
      },
      {
        ...transition,
        expectedHead: {
          ...transition.expectedHead,
          stateHash: new Uint8Array(31),
        },
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          stateHash: null as never,
        },
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          stateHash: new Uint8Array(31),
        },
      },
    ];

    for (const publicResult of invalidTransitions) {
      expect(
        provider.prepareIncoming({ active, publicResult }),
      ).rejects.toThrow(
        "Dummy provider public transition is invalid",
      );
    }
  });
});
