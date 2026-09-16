import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  type SealedProviderStateV2,
  DeviceProviderStateVaultV2,
  V2_PROVIDER_STATE_MAX_BYTES,
} from "../../src/device/v2-state-vault.ts";
import {
  AI_DOMAIN_ROOT_EXPORTER_LABEL,
  HUMAN_DOMAIN_ROOT_EXPORTER_LABEL,
  domainRootExporterContext,
} from "../../src/domain/roots.ts";
import {
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../../src/format/v2-primitives.ts";
import { OpenMlsV2GroupProvider } from "../../src/group/v2-openmls.ts";
import {
  destroyOpenedProviderCandidateStateV2,
  markLocalProviderCandidateV2,
  openLocalProviderCandidateV2,
  redactProviderWelcomeV2,
  type ProviderPublicHeadV2,
  type ProviderPublicTransitionV2,
} from "../../src/transition/provider-candidate.ts";
import {
  type CryptoDeviceId,
  type HumanId,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

const STATE_DOMAIN =
  "nautilo/lattice-crypto/openmls-device-state/v2";
const WELCOME_DOMAIN =
  "nautilo/lattice-crypto/openmls-welcome/v2";
const CREDENTIAL_DOMAIN =
  "nautilo/lattice-crypto/openmls-credential/v2";
const ROSTER_DOMAIN =
  "nautilo/lattice-crypto/openmls-roster/v2";
const INITIAL_HEAD_DOMAIN =
  "nautilo/lattice-crypto/openmls-initial-head/v2";
const NEXT_HEAD_DOMAIN =
  "nautilo/lattice-crypto/openmls-next-head/v2";
const JOIN_ID_DOMAIN =
  "nautilo/lattice-crypto/openmls-join-id/v2";
const VENDOR_GLUE: string =
  "../../vendor/openmls-wasm/openmls_wasm.js";

async function expectRejection(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  let rejection: unknown;
  try {
    await operation;
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(message);
}

interface OpenMlsRosterTestEntry {
  readonly leafIndex: number;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
}

interface OpenMlsJoinMaterialTest {
  readonly joinId: string;
  readonly lifecycle: "prepared" | "applied" | "aborted";
  readonly domainId: ReturnType<typeof cryptoDomainId>;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly keyPackageBytes: Uint8Array;
  readonly providerState: Uint8Array;
}

interface OpenMlsCodecTestSurface {
  encodeWelcome(
    welcomeBytes: Uint8Array,
    ratchetTreeBytes: Uint8Array,
  ): Uint8Array;
  decodeWelcome(bytes: Uint8Array): Readonly<{
    welcomeBytes: Uint8Array;
    ratchetTreeBytes: Uint8Array;
  }>;
  roster(group: Readonly<{
    member_roster(): Uint8Array;
  }>): readonly OpenMlsRosterTestEntry[];
  encodeRoster(roster: readonly OpenMlsRosterTestEntry[]): Uint8Array;
  initialHead(
    domainId: ReturnType<typeof cryptoDomainId>,
    rosterBytes: Uint8Array,
    treeBytes: Uint8Array,
  ): ProviderPublicHeadV2;
  nextHead(
    expected: ProviderPublicHeadV2,
    commitBytes: Uint8Array,
    welcomeHash: Uint8Array,
    rosterBytes: Uint8Array,
    treeBytes: Uint8Array,
  ): ProviderPublicHeadV2;
  assertAddRoster(
    current: readonly OpenMlsRosterTestEntry[],
    next: readonly OpenMlsRosterTestEntry[],
    request: Readonly<{
      humanId: HumanId;
      deviceId: CryptoDeviceId;
    }>,
  ): void;
  assertRemoveRoster(
    current: readonly OpenMlsRosterTestEntry[],
    next: readonly OpenMlsRosterTestEntry[],
    removedDeviceId: CryptoDeviceId,
  ): void;
  assertWelcomeCandidate(
    join: Readonly<{ joinId: string }>,
    sourceId: string,
  ): void;
  destroyJoinSecrets(join: Readonly<{
    providerState: Uint8Array;
    keyPackageBytes: Uint8Array;
  }>): void;
  openJoinMaterial(snapshot: SealedProviderStateV2): OpenMlsJoinMaterialTest;
  sealJoinMaterial(join: OpenMlsJoinMaterialTest): SealedProviderStateV2;
  markJoinState(
    snapshot: SealedProviderStateV2,
    join: OpenMlsJoinMaterialTest,
    lifecycle: "applied" | "aborted",
  ): void;
  ratchetTreeBytes(group: Readonly<{
    export_ratchet_tree(): Readonly<{
      to_bytes(): Uint8Array;
      free(): void;
    }>;
  }>): Uint8Array;
}

interface DirectWasmProvider {
  serialize_device_state(): Uint8Array;
  free(): void;
}

interface DirectWasmGroup {
  member_roster(): Uint8Array;
  export_key(
    provider: DirectWasmProvider,
    label: string,
    context: Uint8Array,
    keyLength: number,
  ): Uint8Array;
  free(): void;
}

interface DirectOpenMlsModule {
  default?: (input?: unknown) => Promise<unknown>;
  Provider: {
    readonly prototype: DirectWasmProvider;
    deserialize_device_state(bytes: Uint8Array): DirectWasmProvider;
  };
  Group: {
    readonly prototype: DirectWasmGroup;
    load_device_state(
      provider: DirectWasmProvider,
      groupId: string,
    ): DirectWasmGroup;
  };
}

let directModulePromise: Promise<DirectOpenMlsModule> | null = null;

function loadDirectOpenMls(): Promise<DirectOpenMlsModule> {
  directModulePromise ??= (async () => {
    const module = (await import(VENDOR_GLUE)) as DirectOpenMlsModule;
    if (typeof module.default === "function") await module.default();
    return module;
  })();
  return directModulePromise;
}

function key(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function rejectionMessage(
  operation: () => Promise<unknown>,
): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject");
}

function thrownMessage(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to throw");
}

function encodeU32Le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function lowerHex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function openMlsCredential(
  ownerHumanId: HumanId,
  deviceId: CryptoDeviceId,
): Uint8Array {
  return new TextEncoder().encode(
    `v2_${lowerHex(concatV2(
      frameText(CREDENTIAL_DOMAIN),
      frameText(ownerHumanId),
      frameText(deviceId),
    ))}`,
  );
}

function rawOpenMlsRoster(
  entries: readonly Readonly<{
    leafIndex: number;
    credential: Uint8Array;
  }>[],
  trailing: Uint8Array = new Uint8Array(),
): Uint8Array {
  return concatV2(
    encodeU32Le(entries.length),
    ...entries.map((entry) =>
      concatV2(
        encodeU32Le(entry.leafIndex),
        encodeU32Le(entry.credential.length),
        entry.credential,
      )
    ),
    trailing,
  );
}

function afterFrame(bytes: Uint8Array, offset: number): number {
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset);
  return offset + 4 + length;
}

function replaceFrame(
  bytes: Uint8Array,
  offset: number,
  replacement: Uint8Array,
): Uint8Array {
  return concatV2(
    bytes.subarray(0, offset),
    frame(replacement),
    bytes.subarray(afterFrame(bytes, offset)),
  );
}

function deviceProvider(
  device: string,
  keyFill: number,
  seed: number,
): Readonly<{
  provider: OpenMlsV2GroupProvider;
  vault: DeviceProviderStateVaultV2;
}> {
  const crypto = new LatticeCrypto(seededRng(seed));
  const deviceId = cryptoDeviceId(device);
  const vault = DeviceProviderStateVaultV2.fromKey(
    crypto,
    deviceId,
    key(keyFill),
  );
  return Object.freeze({
    provider: new OpenMlsV2GroupProvider(crypto, vault),
    vault,
  });
}

async function directRoots(
  active: SealedProviderStateV2,
  vault: DeviceProviderStateVaultV2,
): Promise<Readonly<{ human: Uint8Array; ai: Uint8Array }>> {
  const plaintext = vault.open(active, {
    providerId: active.providerId,
    domainId: active.domainId,
    revision: active.revision,
    snapshotKind: "active",
  });
  if (!plaintext) throw new Error("expected device-local OpenMLS state");
  let providerState: Uint8Array | null = null;
  try {
    providerState = decodeExact(plaintext, (reader) => {
      expect(reader.readText(STATE_DOMAIN.length)).toBe(STATE_DOMAIN);
      reader.readVersion(2);
      reader.readText(V2_LIMITS.idBytes);
      reader.readText(V2_LIMITS.idBytes);
      reader.readText(V2_LIMITS.idBytes);
      reader.readU64();
      reader.readText(V2_LIMITS.idBytes);
      reader.readU32();
      reader.readFrame(32);
      return reader.readFrame(V2_PROVIDER_STATE_MAX_BYTES);
    });
    const openmls = await loadDirectOpenMls();
    const provider = openmls.Provider.deserialize_device_state(providerState);
    let group: DirectWasmGroup | null = null;
    try {
      group = openmls.Group.load_device_state(provider, active.domainId);
      const context = domainRootExporterContext(
        active.domainId,
        active.revision,
      );
      return Object.freeze({
        human: group.export_key(
          provider,
          HUMAN_DOMAIN_ROOT_EXPORTER_LABEL,
          context,
          32,
        ).slice(),
        ai: group.export_key(
          provider,
          AI_DOMAIN_ROOT_EXPORTER_LABEL,
          context,
          32,
        ).slice(),
      });
    } finally {
      group?.free();
      provider.free();
    }
  } finally {
    providerState?.fill(0);
    plaintext.fill(0);
  }
}

describe("OpenMLS v2 per-device provider", () => {
  test("wipes raw WASM provider-state and exported-root outputs", async () => {
    const openmls = await loadDirectOpenMls();
    const originalSerialize =
      openmls.Provider.prototype.serialize_device_state;
    const originalExport = openmls.Group.prototype.export_key;
    const rawProviderStates: Uint8Array[] = [];
    const rawRoots: Uint8Array[] = [];
    openmls.Provider.prototype.serialize_device_state = function () {
      const raw = originalSerialize.call(this);
      rawProviderStates.push(raw);
      return raw;
    };
    openmls.Group.prototype.export_key = function (
      provider,
      label,
      context,
      keyLength,
    ) {
      const raw = originalExport.call(
        this,
        provider,
        label,
        context,
        keyLength,
      );
      rawRoots.push(raw);
      return raw;
    };
    try {
      const { provider: alice } = deviceProvider(
        "alice-wasm-wipe",
        0xa1,
        99,
      );
      const active = await alice.createInitialState({
        domainId: cryptoDomainId("domain-wasm-wipe"),
        humanId: humanId("alice"),
      });
      const roots = await alice.exportDomainRoots(active);

      expect(roots.human.some((byte) => byte !== 0)).toBe(true);
      expect(roots.ai.some((byte) => byte !== 0)).toBe(true);
      expect(rawProviderStates.length).toBeGreaterThan(0);
      expect(rawProviderStates.every((value) =>
        value.every((byte) => byte === 0)
      )).toBe(true);
      expect(rawRoots).toHaveLength(2);
      expect(rawRoots.every((value) =>
        value.every((byte) => byte === 0)
      )).toBe(true);
    } finally {
      openmls.Provider.prototype.serialize_device_state =
        originalSerialize;
      openmls.Group.prototype.export_key = originalExport;
    }
  }, 60_000);

  test("preserves exporter failures and wipes a successfully exported Human root", async () => {
    const openmls = await loadDirectOpenMls();
    const originalExport = openmls.Group.prototype.export_key;
    const { provider: alice } = deviceProvider(
      "alice-export-failure",
      0xa3,
      100,
    );
    const active = await alice.createInitialState({
      domainId: cryptoDomainId("domain-export-failure"),
      humanId: humanId("alice"),
    });

    const observedHumanRoots: Uint8Array[] = [];
    try {
      openmls.Group.prototype.export_key = function (
        provider,
        label,
        context,
        keyLength,
      ) {
        if (label === HUMAN_DOMAIN_ROOT_EXPORTER_LABEL) {
          throw new Error("injected Human export failure");
        }
        return originalExport.call(this, provider, label, context, keyLength);
      };
      await expectRejection(
        alice.exportDomainRoots(active),
        "injected Human export failure",
      );

      openmls.Group.prototype.export_key = function (
        provider,
        label,
        context,
        keyLength,
      ) {
        if (label === AI_DOMAIN_ROOT_EXPORTER_LABEL) {
          throw new Error("injected AI export failure");
        }
        const raw = originalExport.call(
          this,
          provider,
          label,
          context,
          keyLength,
        );
        observedHumanRoots.push(raw);
        return raw;
      };
      await expectRejection(
        alice.exportDomainRoots(active),
        "injected AI export failure",
      );
    } finally {
      openmls.Group.prototype.export_key = originalExport;
    }
    expect(observedHumanRoots).toHaveLength(1);
    expect(observedHumanRoots[0]?.every((byte) => byte === 0)).toBe(true);
  }, 60_000);

  test("snapshots mutable caller bytes before crossing lazy WASM readiness", async () => {
    const { provider: alice } = deviceProvider("alice-phone", 0xa1, 101);
    const { provider: bob } = deviceProvider("bob-phone", 0xb2, 102);
    const domainId = cryptoDomainId("domain-ab");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });

    const bufferedActive = {
      ...active,
      ciphertext: Buffer.from(active.ciphertext),
    } as SealedProviderStateV2;
    const pendingCommit = alice.prepareCommit({ active: bufferedActive });
    bufferedActive.ciphertext.fill(0);
    const preparedCommit = await pendingCommit;
    expect(Number(preparedCommit.publicResult.nextHead.epoch)).toBe(1);

    const expectedHead = alice.publicHead(active);
    const expectedHeadHash = expectedHead.stateHash.slice();
    const pendingJoin = bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead,
    });
    expectedHead.stateHash.fill(0);
    const join = await pendingJoin;
    expect(join.publicResult.expectedHead.stateHash).toEqual(
      expectedHeadHash,
    );

    const bufferedKeyPackage = Buffer.from(
      join.publicResult.keyPackageBytes,
    );
    const pendingAdd = alice.prepareAdd({
      active,
      joinRequest: {
        ...join.publicResult,
        keyPackageBytes: bufferedKeyPackage,
      },
    });
    bufferedKeyPackage.fill(0);
    const preparedAdd = await pendingAdd;
    expect(preparedAdd.publicResult.operation).toBe("add");
  }, 60_000);

  test("initializes explicitly and rejects untrusted join heads, duplicate devices, and absent removal", async () => {
    const aliceFixture = deviceProvider("alice-join-guards", 0xa1, 103);
    const bobFixture = deviceProvider("bob-join-guards", 0xb2, 104);
    const ready = aliceFixture.provider.initialize();
    expect(ready).toBeInstanceOf(Promise);
    await ready;
    const domainId = cryptoDomainId("domain-join-guards");
    const active = await aliceFixture.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const head = aliceFixture.provider.publicHead(active);
    for (const expectedHead of [
      { ...head, providerId: "other-provider" },
      { ...head, domainId: cryptoDomainId("other-domain") },
    ]) {
      await expectRejection(
        bobFixture.provider.createJoinRequest({
          domainId,
          humanId: humanId("bob"),
          expectedHead,
        }),
        "exact trusted OpenMLS public head",
      );
    }
    await expectRejection(
      aliceFixture.provider.prepareRemove({
        active,
        removedDeviceId: cryptoDeviceId("absent-device"),
      }),
      "Removed device is not in the authenticated OpenMLS roster",
    );
    const duplicate = await aliceFixture.provider.createJoinRequest({
      domainId,
      humanId: humanId("alice"),
      expectedHead: head,
    });
    await expectRejection(
      aliceFixture.provider.prepareAdd({
        active,
        joinRequest: duplicate.publicResult,
      }),
      "device already exists in the authenticated OpenMLS roster",
    );
  }, 60_000);

  test("pins OpenMLS roster, head, and join-id cryptographic domains", async () => {
    const { provider, vault } = deviceProvider(
      "domain-contract-device",
      0xa4,
      105,
    );
    const codec = provider as unknown as OpenMlsCodecTestSurface;
    const crypto = new LatticeCrypto();
    const domainId = cryptoDomainId("domain-contract");
    const rosterBytes = codec.encodeRoster([{
      leafIndex: 0,
      humanId: humanId("alice"),
      deviceId: vault.deviceId,
    }]);
    expect(rosterBytes).toEqual(concatV2(
      frameText(ROSTER_DOMAIN),
      encodeU32(1),
      encodeU32(0),
      frameText(humanId("alice")),
      frameText(vault.deviceId),
    ));

    const treeBytes = new Uint8Array([1, 2, 3]);
    const initial = codec.initialHead(domainId, rosterBytes, treeBytes);
    expect(initial.stateHash).toEqual(crypto.hash(concatV2(
      frameText(INITIAL_HEAD_DOMAIN),
      frameText(provider.id),
      frameText(domainId),
      encodeU64(domainEpoch(0)),
      frame(rosterBytes),
      frame(treeBytes),
    )));
    const commitBytes = new Uint8Array([4, 5]);
    const welcomeHash = key(0x66);
    const next = codec.nextHead(
      initial,
      commitBytes,
      welcomeHash,
      rosterBytes,
      treeBytes,
    );
    expect(next.stateHash).toEqual(crypto.hash(concatV2(
      frameText(NEXT_HEAD_DOMAIN),
      frame(initial.stateHash),
      frame(commitBytes),
      frame(welcomeHash),
      frame(rosterBytes),
      frame(treeBytes),
      encodeU64(domainEpoch(1)),
    )));

    const join = await provider.createJoinRequest({
      domainId,
      humanId: humanId("alice"),
      expectedHead: initial,
    });
    const openedJoin = codec.openJoinMaterial(join.localState);
    try {
      expect(openedJoin.joinId).toBe(
        `join_${lowerHex(crypto.hash(concatV2(
          frameText(JOIN_ID_DOMAIN),
          frameText(vault.deviceId),
          concatV2(
            frameText(initial.providerId),
            frameText(initial.domainId),
            encodeU64(initial.epoch),
            frame(initial.stateHash),
          ),
          frame(join.publicResult.keyPackageBytes),
        )).subarray(0, 16))}`,
      );
    } finally {
      codec.destroyJoinSecrets(openedJoin);
    }
  }, 60_000);

  test("enforces exact OpenMLS device and Human admission ceilings", async () => {
    const openmls = await loadDirectOpenMls();
    const originalRoster = openmls.Group.prototype.member_roster;
    const { provider: alice } = deviceProvider(
      "alice-admission-ceilings",
      0xa5,
      106,
    );
    const { provider: bob } = deviceProvider(
      "bob-admission-ceilings",
      0xb5,
      107,
    );
    const domainId = cryptoDomainId("domain-admission-ceilings");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("joining-human"),
      expectedHead: alice.publicHead(active),
    });
    const rosterBytes = (count: number, humanCount: number): Uint8Array =>
      rawOpenMlsRoster(Array.from({ length: count }, (_, index) =>
        index === 0
          ? {
            leafIndex: 0,
            credential: openMlsCredential(
              humanId("alice"),
              cryptoDeviceId("alice-admission-ceilings"),
            ),
          }
          : {
            leafIndex: index,
            credential: openMlsCredential(
              humanId(`existing-human-${(index - 1) % (humanCount - 1)}`),
              cryptoDeviceId(`existing-device-${index}`),
            ),
          }
      ));
    try {
      openmls.Group.prototype.member_roster = () =>
        rosterBytes(
          V2_LIMITS.deviceLeavesPerDomain,
          V2_LIMITS.humanParticipantsPerDomain,
        );
      await expectRejection(
        alice.prepareAdd({ active, joinRequest: join.publicResult }),
        "Join request would exceed the 256-device Domain limit",
      );

      openmls.Group.prototype.member_roster = () =>
        rosterBytes(
          V2_LIMITS.humanParticipantsPerDomain,
          V2_LIMITS.humanParticipantsPerDomain,
        );
      await expectRejection(
        alice.prepareAdd({ active, joinRequest: join.publicResult }),
        "Join request would exceed the 64-Human Domain limit",
      );
    } finally {
      openmls.Group.prototype.member_roster = originalRoster;
    }
  }, 60_000);

  test("uses the exact RFC exporter inputs and prepares without mutating active state", async () => {
    const { provider: alice, vault } = deviceProvider(
      "alice-phone",
      0xa1,
      111,
    );
    const domainId = cryptoDomainId("domain-ab");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const oldRoots = await alice.exportDomainRoots(active);
    expect(oldRoots).toEqual(await directRoots(active, vault));
    expect(oldRoots.human).not.toEqual(oldRoots.ai);
    await expectRejection(
      alice.prepareRemove({
        active,
        removedDeviceId: cryptoDeviceId("alice-phone"),
      }),
      "rebootstrap",
    );

    const prepared = await alice.prepareCommit({ active });

    expect(Number(alice.publicHead(active).epoch)).toBe(0);
    expect(await alice.exportDomainRoots(active)).toEqual(oldRoots);
    expect(Object.keys(prepared.publicResult).sort()).toEqual([
      "commitBytes",
      "domainId",
      "expectedHead",
      "formatVersion",
      "nextHead",
      "operation",
      "providerId",
      "rosterBytes",
      "targetDeviceId",
      "targetHumanId",
      "welcomeBytes",
      "welcomeHash",
    ]);
    expect(prepared.publicResult).not.toHaveProperty("localCandidate");
    expect(prepared.publicResult).not.toHaveProperty("providerState");
    expect(prepared.publicResult).not.toHaveProperty("exporterSecret");
    expect(prepared.localCandidate.snapshot.classification).toBe(
      "device-local-provider-ciphertext",
    );

    prepared.publicResult.commitBytes[0] =
      prepared.publicResult.commitBytes[0]! ^ 0xff;
    expect(() =>
      alice.applyCandidate({
        active,
        candidate: {
          ...prepared.localCandidate,
          expectedHead: {
            ...prepared.localCandidate.expectedHead,
            stateHash: key(0xed),
          },
        },
      })
    ).toThrow("sealed candidate");
    const applied = alice.applyCandidate({
      active,
      candidate: prepared.localCandidate,
    });
    expect(applied.status).toBe("applied");
    expect(Number(alice.publicHead(applied.active).epoch)).toBe(1);
    expect(await alice.exportDomainRoots(applied.active)).not.toEqual(oldRoots);
  }, 60_000);

  test("adds through a real key package and Welcome while keeping join state local", async () => {
    const { provider: alice } = deviceProvider("alice-phone", 0xa1, 121);
    const { provider: bob } = deviceProvider("bob-phone", 0xb2, 122);
    const { provider: charlie } = deviceProvider(
      "charlie-phone",
      0xc3,
      123,
    );
    const domainId = cryptoDomainId("domain-ab");
    const aliceActive = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(aliceActive),
    });
    const joinStateBeforePrepare = join.localState.ciphertext.slice();
    expect(Object.keys(join.publicResult).sort()).toEqual([
      "deviceId",
      "domainId",
      "expectedHead",
      "formatVersion",
      "humanId",
      "keyPackageBytes",
      "providerId",
    ]);
    expect(join.publicResult).not.toHaveProperty("providerState");
    expect(join.publicResult).not.toHaveProperty("ciphertext");

    await expectRejection(
      alice.prepareAdd({
        active: aliceActive,
        joinRequest: {
          ...join.publicResult,
          humanId: humanId("mallory"),
        },
      }),
      "authenticated OpenMLS roster",
    );
    await expectRejection(
      alice.prepareAdd({
        active: aliceActive,
        joinRequest: {
          ...join.publicResult,
          expectedHead: {
            ...join.publicResult.expectedHead,
            stateHash: key(0xee),
          },
        },
      }),
      "active Domain head",
    );

    const add = await alice.prepareAdd({
      active: aliceActive,
      joinRequest: join.publicResult,
    });
    const crypto = new LatticeCrypto();
    await expectRejection(
      bob.prepareWelcome({
        joinState: join.localState,
        publicResult: {
          ...add.publicResult,
          welcomeBytes: new Uint8Array(),
          welcomeHash: crypto.hash(new Uint8Array()),
        },
      }),
      "OpenMLS Welcome does not match its public commitment",
    );
    const oneByteWelcome = new Uint8Array([1]);
    await expectRejection(
      bob.prepareWelcome({
        joinState: join.localState,
        publicResult: {
          ...add.publicResult,
          welcomeBytes: oneByteWelcome,
          welcomeHash: crypto.hash(oneByteWelcome),
        },
      }),
      "truncated u32",
    );
    const changedWelcomeRoster = add.publicResult.rosterBytes.slice();
    changedWelcomeRoster[changedWelcomeRoster.length - 1] =
      changedWelcomeRoster[changedWelcomeRoster.length - 1]! ^ 1;
    await expectRejection(
      bob.prepareWelcome({
        joinState: join.localState,
        publicResult: {
          ...add.publicResult,
          rosterBytes: changedWelcomeRoster,
        },
      }),
      "OpenMLS Welcome roster does not match public transition bytes",
    );
    await expectRejection(
      bob.prepareWelcome({
        joinState: join.localState,
        publicResult: {
          ...add.publicResult,
          nextHead: {
            ...add.publicResult.nextHead,
            stateHash: key(0x99),
          },
        },
      }),
      "OpenMLS Welcome does not match the exact next public head",
    );
    const bobCandidate = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    const retryCandidate = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    expect(join.localState.ciphertext).toEqual(joinStateBeforePrepare);
    expect(retryCandidate.candidateId).toBe(bobCandidate.candidateId);
    expect(add.publicResult.welcomeBytes.length).toBeGreaterThan(0);
    expect(add.publicResult.rosterBytes.length).toBeGreaterThan(0);
    expect(Number(alice.publicHead(aliceActive).epoch)).toBe(0);

    const aliceApplied = alice.applyCandidate({
      active: aliceActive,
      candidate: add.localCandidate,
    });
    const bobApplied = bob.activateWelcome({
      candidate: bobCandidate,
      joinState: join.localState,
    });
    expect(aliceApplied.status).toBe("applied");
    expect(bobApplied.status).toBe("applied");
    expect(alice.publicHead(aliceApplied.active)).toEqual(
      bob.publicHead(bobApplied.active),
    );
    expect(await alice.exportDomainRoots(aliceApplied.active)).toEqual(
      await bob.exportDomainRoots(bobApplied.active),
    );
    const duplicateBobJoin = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: bob.publicHead(bobApplied.active),
    });
    await expectRejection(
      alice.prepareAdd({
        active: aliceApplied.active,
        joinRequest: duplicateBobJoin.publicResult,
      }),
      "device already exists in the authenticated OpenMLS roster",
    );
    const { provider: restartedBob } = deviceProvider(
      "bob-phone",
      0xb2,
      220,
    );
    expect(
      restartedBob.abortWelcome({
        candidate: retryCandidate,
        joinState: join.localState,
      }).status,
    ).toBe("already-applied");
    expect(
      restartedBob.abortWelcome({
        candidate: retryCandidate,
        joinState: join.localState,
      }).status,
    ).toBe("already-applied");

    const charlieJoin = await charlie.createJoinRequest({
      domainId,
      humanId: humanId("charlie"),
      expectedHead: alice.publicHead(aliceApplied.active),
    });
    const charlieAdd = await alice.prepareAdd({
      active: aliceApplied.active,
      joinRequest: charlieJoin.publicResult,
    });
    const mutatedWelcome = charlieAdd.publicResult.welcomeBytes.slice();
    mutatedWelcome[mutatedWelcome.length - 1] =
      mutatedWelcome[mutatedWelcome.length - 1]! ^ 0x01;
    await expectRejection(
      bob.prepareIncoming({
        active: bobApplied.active,
        publicResult: {
          ...charlieAdd.publicResult,
          welcomeBytes: mutatedWelcome,
          welcomeHash: new LatticeCrypto().hash(mutatedWelcome),
        },
      }),
      "next public head",
    );
    const bobAddCandidate = await bob.prepareIncoming({
      active: bobApplied.active,
      publicResult: redactProviderWelcomeV2(charlieAdd.publicResult),
    });
    const charlieCandidate = await charlie.prepareWelcome({
      joinState: charlieJoin.localState,
      publicResult: charlieAdd.publicResult,
    });
    const aliceAfterCharlie = alice.applyCandidate({
      active: aliceApplied.active,
      candidate: charlieAdd.localCandidate,
    }).active;
    const bobAfterCharlie = bob.applyCandidate({
      active: bobApplied.active,
      candidate: bobAddCandidate,
    }).active;
    const charlieActive = charlie.activateWelcome({
      candidate: charlieCandidate,
      joinState: charlieJoin.localState,
    }).active;
    expect(alice.publicHead(aliceAfterCharlie)).toEqual(
      bob.publicHead(bobAfterCharlie),
    );
    expect(alice.publicHead(aliceAfterCharlie)).toEqual(
      charlie.publicHead(charlieActive),
    );
    expect(await alice.exportDomainRoots(aliceAfterCharlie)).toEqual(
      await charlie.exportDomainRoots(charlieActive),
    );
  }, 60_000);

  test("aborts Welcome state explicitly and preserves the terminal lifecycle across restart", async () => {
    const { provider: alice } = deviceProvider("alice-phone", 0xa1, 124);
    const { provider: bob } = deviceProvider("bob-phone", 0xb2, 125);
    const domainId = cryptoDomainId("domain-abort-welcome");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(active),
    });
    const add = await alice.prepareAdd({
      active,
      joinRequest: join.publicResult,
    });
    const candidate = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });

    expect(bob.abortWelcome({ candidate, joinState: join.localState }).status)
      .toBe("aborted");
    expect(join.localState.ciphertext.some((byte) => byte !== 0)).toBe(true);
    expect(candidate.snapshot.ciphertext.some((byte) => byte !== 0)).toBe(true);

    const { provider: restartedBob } = deviceProvider(
      "bob-phone",
      0xb2,
      126,
    );
    expect(
      restartedBob.abortWelcome({
        candidate,
        joinState: join.localState,
      }).status,
    ).toBe("already-aborted");
    await expectRejection(
      restartedBob.prepareWelcome({
        joinState: join.localState,
        publicResult: add.publicResult,
      }),
      "local join request",
    );
  }, 60_000);

  test("locks OpenMLS Welcome activation and abort lifecycle cross-products", async () => {
    const { provider: alice } = deviceProvider(
      "alice-welcome-life",
      0xa1,
      127,
    );
    const { provider: bob } = deviceProvider(
      "bob-welcome-life",
      0xb2,
      128,
    );
    const domainId = cryptoDomainId("domain-welcome-life");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(active),
    });
    const add = await alice.prepareAdd({
      active,
      joinRequest: join.publicResult,
    });
    const candidate = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    const applied = bob.activateWelcome({
      candidate,
      joinState: join.localState,
    });
    expect(applied.status).toBe("applied");
    expect(() =>
      bob.applyCandidate({ active: applied.active, candidate })
    ).toThrow("Welcome candidates require the Welcome lifecycle");
    expect(() => bob.abortCandidate(candidate)).toThrow(
      "Welcome candidates require the Welcome lifecycle",
    );
    expect(() =>
      bob.activateWelcome({
        candidate,
        joinState: join.localState,
      })
    ).toThrow("already activated");
    expect(
      bob.abortWelcome({
        candidate,
        joinState: join.localState,
      }).status,
    ).toBe("already-applied");

    const { provider: charlie } = deviceProvider(
      "charlie-welcome-life",
      0xc3,
      129,
    );
    const aliceApplied = alice.applyCandidate({
      active,
      candidate: add.localCandidate,
    });
    const charlieJoin = await charlie.createJoinRequest({
      domainId,
      humanId: humanId("charlie"),
      expectedHead: alice.publicHead(aliceApplied.active),
    });
    const charlieAdd = await alice.prepareAdd({
      active: aliceApplied.active,
      joinRequest: charlieJoin.publicResult,
    });
    const aborted = await charlie.prepareWelcome({
      joinState: charlieJoin.localState,
      publicResult: charlieAdd.publicResult,
    });
    expect(
      charlie.abortWelcome({
        candidate: aborted,
        joinState: charlieJoin.localState,
      }).status,
    ).toBe("aborted");
    expect(() =>
      charlie.activateWelcome({
        candidate: aborted,
        joinState: charlieJoin.localState,
      })
    ).toThrow("aborted");
  }, 60_000);

  test("synchronizes every mismatched OpenMLS Welcome tombstone pair", async () => {
    const setup = async (
      suffix: string,
      joinLifecycle: "prepared" | "applied" | "aborted",
      candidateLifecycle: "prepared" | "applied" | "aborted" | "stale",
    ) => {
      const { provider: alice } = deviceProvider(
        `alice-welcome-pair-${suffix}`,
        0xa1,
        13_000 + suffix.length,
      );
      const bobFixture = deviceProvider(
        `bob-welcome-pair-${suffix}`,
        0xb2,
        14_000 + suffix.length,
      );
      const domainId = cryptoDomainId(`domain-welcome-pair-${suffix}`);
      const active = await alice.createInitialState({
        domainId,
        humanId: humanId("alice"),
      });
      const join = await bobFixture.provider.createJoinRequest({
        domainId,
        humanId: humanId("bob"),
        expectedHead: alice.publicHead(active),
      });
      const add = await alice.prepareAdd({
        active,
        joinRequest: join.publicResult,
      });
      const candidate = await bobFixture.provider.prepareWelcome({
        joinState: join.localState,
        publicResult: add.publicResult,
      });
      const codec = bobFixture.provider as unknown as OpenMlsCodecTestSurface;
      if (joinLifecycle !== "prepared") {
        const material = codec.openJoinMaterial(join.localState);
        try {
          const replacement = codec.sealJoinMaterial({
            ...material,
            lifecycle: joinLifecycle,
          });
          join.localState.ciphertext.set(replacement.ciphertext);
        } finally {
          codec.destroyJoinSecrets(material);
        }
      }
      if (candidateLifecycle !== "prepared") {
        markLocalProviderCandidateV2({
          vault: bobFixture.vault,
          candidate,
          lifecycle: candidateLifecycle,
        });
      }
      return {
        bob: bobFixture.provider,
        candidate,
        codec,
        join,
        vault: bobFixture.vault,
      };
    };
    const expectLifecycles = (
      pair: Awaited<ReturnType<typeof setup>>,
      joinLifecycle: "prepared" | "applied" | "aborted",
      candidateLifecycle: "prepared" | "applied" | "aborted" | "stale",
    ) => {
      const joinMaterial = pair.codec.openJoinMaterial(pair.join.localState);
      try {
        expect(joinMaterial.lifecycle).toBe(joinLifecycle);
      } finally {
        pair.codec.destroyJoinSecrets(joinMaterial);
      }
      const openedCandidate = openLocalProviderCandidateV2({
        vault: pair.vault,
        candidate: pair.candidate,
      });
      try {
        expect(openedCandidate.lifecycle).toBe(candidateLifecycle);
      } finally {
        destroyOpenedProviderCandidateStateV2(openedCandidate);
      }
    };

    const candidateApplied = await setup(
      "candidate-applied",
      "prepared",
      "applied",
    );
    expect(candidateApplied.bob.abortWelcome({
      candidate: candidateApplied.candidate,
      joinState: candidateApplied.join.localState,
    }).status).toBe("already-applied");
    expectLifecycles(candidateApplied, "applied", "applied");

    const joinApplied = await setup(
      "join-applied",
      "applied",
      "prepared",
    );
    expect(joinApplied.bob.abortWelcome({
      candidate: joinApplied.candidate,
      joinState: joinApplied.join.localState,
    }).status).toBe("already-applied");
    expectLifecycles(joinApplied, "applied", "applied");
    expect(joinApplied.bob.abortWelcome({
      candidate: joinApplied.candidate,
      joinState: joinApplied.join.localState,
    }).status).toBe("already-applied");

    for (const candidateLifecycle of [
      "prepared",
      "aborted",
      "stale",
    ] as const) {
      const joinLifecycle = candidateLifecycle === "prepared"
        ? "aborted"
        : "prepared";
      const pair = await setup(
        `${joinLifecycle}-${candidateLifecycle}`,
        joinLifecycle,
        candidateLifecycle,
      );
      if (candidateLifecycle === "prepared") {
        expect(() =>
          pair.bob.activateWelcome({
            candidate: pair.candidate,
            joinState: pair.join.localState,
          })
        ).toThrow("Welcome join state was aborted");
      } else if (candidateLifecycle === "aborted") {
        expect(() =>
          pair.bob.activateWelcome({
            candidate: pair.candidate,
            joinState: pair.join.localState,
          })
        ).toThrow("Welcome candidate was aborted");
      }
      expect(pair.bob.abortWelcome({
        candidate: pair.candidate,
        joinState: pair.join.localState,
      }).status).toBe("already-aborted");
      expectLifecycles(
        pair,
        "aborted",
        candidateLifecycle === "stale" ? "stale" : "aborted",
      );
      expect(pair.bob.abortWelcome({
        candidate: pair.candidate,
        joinState: pair.join.localState,
      }).status).toBe("already-aborted");
    }
  }, 60_000);

  test("validates OpenMLS prepared, applied, competing, and substituted candidates", async () => {
    const { provider: alice } = deviceProvider(
      "alice-prepared",
      0xa1,
      130,
    );
    const domainId = cryptoDomainId("domain-prepared");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const winner = await alice.prepareCommit({ active });
    const loser = await alice.prepareCommit({ active });
    const abandoned = await alice.prepareCommit({ active });
    expect(
      await alice.validatePreparedCandidate({ active, prepared: winner }),
    ).toBeUndefined();

    const applied = alice.applyCandidate({
      active,
      candidate: winner.localCandidate,
    });
    expect(alice.abortCandidate(winner.localCandidate).status).toBe(
      "already-applied",
    );
    expect(
      alice.applyCandidate({
        active: applied.active,
        candidate: loser.localCandidate,
      }).status,
    ).toBe("stale");
    expect(
      alice.applyCandidate({
        active: applied.active,
        candidate: loser.localCandidate,
      }).status,
    ).toBe("aborted");
    expect(alice.abortCandidate(loser.localCandidate).status).toBe(
      "already-aborted",
    );
    expect(alice.abortCandidate(abandoned.localCandidate).status).toBe(
      "aborted",
    );
    expect(alice.abortCandidate(abandoned.localCandidate).status).toBe(
      "already-aborted",
    );
    expect(() =>
      alice.applyCandidate({ active, candidate: winner.localCandidate })
    ).toThrow("cannot be replayed against its old head");
    expect(
      await alice.validatePreparedCandidate({
        active: applied.active,
        prepared: winner,
      }),
    ).toBeUndefined();
    await expectRejection(
      alice.validatePreparedCandidate({ active, prepared: winner }),
      "Applied OpenMLS candidate does not match the active public head",
    );
    await expectRejection(
      alice.validatePreparedCandidate({
        active: applied.active,
        prepared: loser,
      }),
      "OpenMLS prepared candidate does not match the active public head",
    );

    const changedCommit = winner.publicResult.commitBytes.slice();
    changedCommit[0] = changedCommit[0]! ^ 1;
    await expectRejection(
      alice.validatePreparedCandidate({
        active,
        prepared: {
          ...winner,
          publicResult: {
            ...winner.publicResult,
            commitBytes: changedCommit,
          },
        },
      }),
      "OpenMLS prepared candidate does not match its public transition",
    );

    const wrongRoster = winner.publicResult.rosterBytes.slice();
    wrongRoster[wrongRoster.length - 1] =
      wrongRoster[wrongRoster.length - 1]! ^ 1;
    await expectRejection(
      alice.validatePreparedCandidate({
        active,
        prepared: {
          ...winner,
          publicResult: {
            ...winner.publicResult,
            rosterBytes: wrongRoster,
          },
        },
      }),
      "OpenMLS prepared candidate does not match its public transition",
    );
  }, 60_000);

  test("processes incoming update/removal, rejects tampering, and excludes the removed device", async () => {
    const { provider: alice } = deviceProvider("alice-phone", 0xa1, 131);
    const { provider: bob } = deviceProvider("bob-phone", 0xb2, 132);
    const domainId = cryptoDomainId("domain-ab");
    let aliceActive = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(aliceActive),
    });
    const add = await alice.prepareAdd({
      active: aliceActive,
      joinRequest: join.publicResult,
    });
    const bobWelcome = await bob.prepareWelcome({
      joinState: join.localState,
      publicResult: add.publicResult,
    });
    aliceActive = alice.applyCandidate({
      active: aliceActive,
      candidate: add.localCandidate,
    }).active;
    let bobActive = bob.activateWelcome({
      candidate: bobWelcome,
      joinState: join.localState,
    }).active;

    const update = await alice.prepareCommit({ active: aliceActive });
    await expectRejection(
      bob.prepareIncoming({
        active: bobActive,
        publicResult: {
          ...update.publicResult,
          expectedHead: {
            ...update.publicResult.expectedHead,
            stateHash: key(0x91),
          },
        },
      }),
      "exact expected public head",
    );
    await expectRejection(
      bob.prepareIncoming({
        active: bobActive,
        publicResult: {
          ...update.publicResult,
          nextHead: {
            ...update.publicResult.nextHead,
            stateHash: key(0xee),
          },
        },
      }),
      "next public head",
    );
    await expectRejection(
      bob.prepareIncoming({
        active: bobActive,
        publicResult: {
          ...update.publicResult,
          rosterBytes: new Uint8Array(
            V2_LIMITS.namespaceKeyringBytes + 1,
          ),
        },
      }),
      "public transition",
    );
    const bobUpdate = await bob.prepareIncoming({
      active: bobActive,
      publicResult: update.publicResult,
    });
    aliceActive = alice.applyCandidate({
      active: aliceActive,
      candidate: update.localCandidate,
    }).active;
    bobActive = bob.applyCandidate({
      active: bobActive,
      candidate: bobUpdate,
    }).active;
    expect(await alice.exportDomainRoots(aliceActive)).toEqual(
      await bob.exportDomainRoots(bobActive),
    );

    const bobOldRoots = await bob.exportDomainRoots(bobActive);
    const removal = await alice.prepareRemove({
      active: aliceActive,
      removedDeviceId: cryptoDeviceId("bob-phone"),
    });
    const bobRemoval = await bob.prepareIncoming({
      active: bobActive,
      publicResult: removal.publicResult,
    });
    expect(await bob.exportDomainRoots(bobActive)).toEqual(bobOldRoots);
    aliceActive = alice.applyCandidate({
      active: aliceActive,
      candidate: removal.localCandidate,
    }).active;
    bobActive = bob.applyCandidate({
      active: bobActive,
      candidate: bobRemoval,
    }).active;
    expect(Number(alice.publicHead(aliceActive).epoch)).toBe(3);
    await expectRejection(bob.exportDomainRoots(bobActive), "Removed");
    await expectRejection(
      bob.prepareCommit({ active: bobActive }),
      "Removed",
    );
  }, 60_000);

  test("abort, stale, duplicate, crash, and retry never double-advance", async () => {
    const { provider: alice, vault } = deviceProvider(
      "alice-phone",
      0xa1,
      141,
    );
    const domainId = cryptoDomainId("domain-ab");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const aborted = await alice.prepareCommit({ active });
    expect(alice.abortCandidate(aborted.localCandidate).status).toBe("aborted");
    expect(
      alice.applyCandidate({
        active,
        candidate: aborted.localCandidate,
      }).status,
    ).toBe("aborted");

    const winner = await alice.prepareCommit({ active });
    const loser = await alice.prepareCommit({ active });
    const applied = alice.applyCandidate({
      active,
      candidate: winner.localCandidate,
    });
    expect(applied.status).toBe("applied");
    expect(
      alice.applyCandidate({
        active: applied.active,
        candidate: winner.localCandidate,
      }).status,
    ).toBe("duplicate");
    expect(
      alice.applyCandidate({
        active: applied.active,
        candidate: loser.localCandidate,
      }).status,
    ).toBe("stale");

    const crashCandidate = await alice.prepareCommit({
      active: applied.active,
    });
    const candidateAppliedBeforeCrash = {
      ...crashCandidate.localCandidate,
      expectedHead: {
        ...crashCandidate.localCandidate.expectedHead,
        stateHash: crashCandidate.localCandidate.expectedHead.stateHash.slice(),
      },
      nextHead: {
        ...crashCandidate.localCandidate.nextHead,
        stateHash: crashCandidate.localCandidate.nextHead.stateHash.slice(),
      },
      publicTransitionDigest:
        crashCandidate.localCandidate.publicTransitionDigest.slice(),
      snapshot: {
        ...crashCandidate.localCandidate.snapshot,
        ciphertext:
          crashCandidate.localCandidate.snapshot.ciphertext.slice(),
      },
    };
    const storageAppliedBeforeCrash = alice.applyCandidate({
      active: applied.active,
      candidate: candidateAppliedBeforeCrash,
    });
    const preparedBeforeRestart = openLocalProviderCandidateV2({
      vault,
      candidate: crashCandidate.localCandidate,
    });
    expect(preparedBeforeRestart.lifecycle).toBe("prepared");
    destroyOpenedProviderCandidateStateV2(preparedBeforeRestart);
    const { provider: restarted, vault: restartedVault } = deviceProvider(
      "alice-phone",
      0xa1,
      142,
    );
    await restarted.initialize();
    const afterCrash = restarted.applyCandidate({
      active: storageAppliedBeforeCrash.active,
      candidate: crashCandidate.localCandidate,
    });
    expect(afterCrash.status).toBe("duplicate");
    expect(Number(restarted.publicHead(afterCrash.active).epoch)).toBe(2);
    const appliedAfterRestart = openLocalProviderCandidateV2({
      vault: restartedVault,
      candidate: crashCandidate.localCandidate,
    });
    expect(appliedAfterRestart.lifecycle).toBe("applied");
    destroyOpenedProviderCandidateStateV2(appliedAfterRestart);
    expect(
      restarted.abortCandidate(crashCandidate.localCandidate).status,
    ).toBe("already-applied");
  }, 60_000);

  test("a crash before apply leaves old state usable and retry advances once", async () => {
    const { provider: alice } = deviceProvider("alice-phone", 0xa1, 151);
    const domainId = cryptoDomainId("domain-ab");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const rootsBefore = await alice.exportDomainRoots(active);
    const abandoned = await alice.prepareCommit({ active });

    const { provider: restarted } = deviceProvider(
      "alice-phone",
      0xa1,
      152,
    );
    await restarted.initialize();
    expect(await restarted.exportDomainRoots(active)).toEqual(rootsBefore);
    expect(Number(restarted.publicHead(active).epoch)).toBe(0);
    const retry = await restarted.prepareCommit({ active });
    const applied = restarted.applyCandidate({
      active,
      candidate: retry.localCandidate,
    });
    expect(applied.status).toBe("applied");
    expect(Number(restarted.publicHead(applied.active).epoch)).toBe(1);
    expect(
      restarted.applyCandidate({
        active: applied.active,
        candidate: abandoned.localCandidate,
      }).status,
    ).toBe("stale");
  }, 60_000);

  test("rejects every malformed public transition coordinate and byte boundary", async () => {
    const { provider: alice } = deviceProvider(
      "alice-transition-validator",
      0xa1,
      161,
    );
    const active = await alice.createInitialState({
      domainId: cryptoDomainId("domain-transition-validator"),
      humanId: humanId("alice"),
    });
    const transition = (await alice.prepareCommit({ active })).publicResult;
    const invalid: ProviderPublicTransitionV2[] = [
      { ...transition, formatVersion: 1 as never },
      { ...transition, providerId: "other-provider" },
      { ...transition, domainId: cryptoDomainId("other-domain") },
      {
        ...transition,
        expectedHead: {
          ...transition.expectedHead,
          domainId: cryptoDomainId("other-domain"),
        },
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          domainId: cryptoDomainId("other-domain"),
        },
      },
      {
        ...transition,
        expectedHead: {
          ...transition.expectedHead,
          providerId: "other-provider",
        },
      },
      {
        ...transition,
        nextHead: {
          ...transition.nextHead,
          providerId: "other-provider",
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
      { ...transition, commitBytes: new Uint8Array() },
      {
        ...transition,
        commitBytes: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
      },
      { ...transition, welcomeBytes: null as never },
      {
        ...transition,
        welcomeBytes: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
      },
      { ...transition, welcomeHash: null as never },
      { ...transition, welcomeHash: new Uint8Array(31) },
      {
        ...transition,
        welcomeBytes: new Uint8Array([1]),
        welcomeHash: key(0xee),
      },
      { ...transition, rosterBytes: null as never },
      { ...transition, rosterBytes: new Uint8Array() },
      {
        ...transition,
        rosterBytes: new Uint8Array(V2_LIMITS.namespaceKeyringBytes + 1),
      },
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
    for (const publicResult of invalid) {
      await expectRejection(
        alice.prepareIncoming({ active, publicResult }),
        "OpenMLS public transition is invalid",
      );
    }
  }, 60_000);

  test("rejects every malformed public join-request coordinate and byte boundary", async () => {
    const { provider: alice } = deviceProvider(
      "alice-join-validator",
      0xa1,
      162,
    );
    const { provider: bob } = deviceProvider(
      "bob-join-validator",
      0xb2,
      163,
    );
    const domainId = cryptoDomainId("domain-join-validator");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const request = (await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(active),
    })).publicResult;
    const invalid = [
      { ...request, formatVersion: 1 as never },
      { ...request, providerId: "other-provider" },
      {
        ...request,
        providerId: "other-provider",
        expectedHead: {
          ...request.expectedHead,
          providerId: "other-provider",
        },
      },
      { ...request, domainId: cryptoDomainId("other-domain") },
      {
        ...request,
        expectedHead: {
          ...request.expectedHead,
          providerId: "other-provider",
        },
      },
      {
        ...request,
        expectedHead: {
          ...request.expectedHead,
          domainId: cryptoDomainId("other-domain"),
        },
      },
      {
        ...request,
        expectedHead: {
          ...request.expectedHead,
          stateHash: null as never,
        },
      },
      {
        ...request,
        expectedHead: {
          ...request.expectedHead,
          stateHash: new Uint8Array(31),
        },
      },
      { ...request, keyPackageBytes: null as never },
      { ...request, keyPackageBytes: new Uint8Array() },
      {
        ...request,
        keyPackageBytes: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
      },
    ];
    for (const joinRequest of invalid) {
      await expectRejection(
        alice.prepareAdd({ active, joinRequest }),
        "OpenMLS join request is invalid",
      );
    }
  }, 60_000);

  test("accepts exact public byte ceilings before semantic OpenMLS decoding", async () => {
    const { provider: alice } = deviceProvider(
      "alice-exact-boundaries",
      0xa1,
      164,
    );
    const { provider: bob } = deviceProvider(
      "bob-exact-boundaries",
      0xb2,
      165,
    );
    const domainId = cryptoDomainId("domain-exact-boundaries");
    const active = await alice.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const prepared = await alice.prepareCommit({ active });
    const transitionBoundaries: ProviderPublicTransitionV2[] = [
      { ...prepared.publicResult, commitBytes: new Uint8Array(1) },
      {
        ...prepared.publicResult,
        commitBytes: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES),
      },
      {
        ...prepared.publicResult,
        welcomeBytes: new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES),
        welcomeHash: new LatticeCrypto().hash(
          new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES),
        ),
      },
      { ...prepared.publicResult, rosterBytes: new Uint8Array(1) },
      {
        ...prepared.publicResult,
        rosterBytes: new Uint8Array(V2_LIMITS.namespaceKeyringBytes),
      },
    ];
    for (const publicResult of transitionBoundaries) {
      const message = await rejectionMessage(() =>
        alice.validatePreparedCandidate({
          active,
          prepared: { ...prepared, publicResult },
        })
      );
      expect(message).not.toContain("OpenMLS public transition is invalid");
    }

    const request = (await bob.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.publicHead(active),
    })).publicResult;
    for (const length of [1, V2_PROVIDER_STATE_MAX_BYTES]) {
      const message = await rejectionMessage(() =>
        alice.prepareAdd({
          active,
          joinRequest: {
            ...request,
            keyPackageBytes: new Uint8Array(length),
          },
        })
      );
      expect(message).not.toContain("OpenMLS join request is invalid");
    }
  }, 60_000);

  test("rejects every active OpenMLS snapshot and sealed-state substitution", async () => {
    const fixture = deviceProvider("alice-active-codec", 0xa1, 168);
    const domainId = cryptoDomainId("domain-active-codec");
    const active = await fixture.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const coordinates = {
      providerId: active.providerId,
      domainId,
      revision: active.revision,
      snapshotKind: "active" as const,
    };
    const plaintext = fixture.vault.open(active, coordinates);
    if (!plaintext) throw new Error("Expected active OpenMLS plaintext");

    for (const snapshot of [
      { ...active, providerId: "other-provider" },
      { ...active, deviceId: cryptoDeviceId("other-device") },
      { ...active, snapshotKind: "candidate" as const },
    ]) {
      expect(() => fixture.provider.publicHead(snapshot)).toThrow(
        "Invalid active OpenMLS snapshot coordinates",
      );
    }
    const damagedCiphertext = active.ciphertext.slice();
    damagedCiphertext[damagedCiphertext.length - 1] =
      damagedCiphertext[damagedCiphertext.length - 1]! ^ 1;
    for (const snapshot of [
      { ...active, ciphertext: damagedCiphertext },
      { ...active, domainId: cryptoDomainId("other-domain") },
      { ...active, revision: domainEpoch(1) },
    ]) {
      expect(() => fixture.provider.publicHead(snapshot)).toThrow(
        "Unable to open active OpenMLS snapshot",
      );
    }

    let offset = 0;
    const stateDomainValue = 4;
    offset = afterFrame(plaintext, offset);
    const versionOffset = offset;
    offset += 4;
    const providerFrame = offset;
    offset = afterFrame(plaintext, offset);
    const domainFrame = offset;
    offset = afterFrame(plaintext, offset);
    const deviceFrame = offset;
    offset = afterFrame(plaintext, offset);
    const epochOffset = offset;
    offset += 8;
    const humanFrame = offset;
    offset = afterFrame(plaintext, offset);
    const removedOffset = offset;
    offset += 4;
    const stateHashFrame = offset;
    offset = afterFrame(plaintext, offset);
    const providerStateFrame = offset;

    const wrongStateDomain = plaintext.slice();
    wrongStateDomain[stateDomainValue] =
      wrongStateDomain[stateDomainValue]! ^ 1;
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(coordinates, wrongStateDomain),
      )
    ).toThrow("OpenMLS state domain is unsupported");

    const wrongVersion = plaintext.slice();
    new DataView(wrongVersion.buffer).setUint32(versionOffset, 99);
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(coordinates, wrongVersion),
      )
    ).toThrow("unsupported version 99");
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(
          coordinates,
          replaceFrame(
            plaintext,
            providerFrame,
            new TextEncoder().encode("other-provider"),
          ),
        ),
      )
    ).toThrow("OpenMLS state provider id is invalid");

    for (const changed of [
      replaceFrame(
        plaintext,
        domainFrame,
        new TextEncoder().encode("other-active-domain"),
      ),
      replaceFrame(
        plaintext,
        deviceFrame,
        new TextEncoder().encode("other-active-device"),
      ),
      (() => {
        const bytes = plaintext.slice();
        new DataView(bytes.buffer).setBigUint64(epochOffset, 1n);
        return bytes;
      })(),
    ]) {
      expect(() =>
        fixture.provider.publicHead(fixture.vault.seal(coordinates, changed))
      ).toThrow("OpenMLS state metadata does not match its sealed snapshot");
    }

    const invalidRemoved = plaintext.slice();
    new DataView(invalidRemoved.buffer).setUint32(removedOffset, 2);
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(coordinates, invalidRemoved),
      )
    ).toThrow("OpenMLS removed-state flag is invalid");
    const falselyRemoved = plaintext.slice();
    new DataView(falselyRemoved.buffer).setUint32(removedOffset, 1);
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(coordinates, falselyRemoved),
      )
    ).toThrow(
      "OpenMLS state identity does not match its authenticated roster",
    );
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(
          coordinates,
          replaceFrame(
            plaintext,
            humanFrame,
            new TextEncoder().encode("blice"),
          ),
        ),
      )
    ).toThrow(
      "OpenMLS state identity does not match its authenticated roster",
    );

    for (const length of [31, 33]) {
      expect(() =>
        fixture.provider.publicHead(
          fixture.vault.seal(
            coordinates,
            replaceFrame(
              plaintext,
              stateHashFrame,
              new Uint8Array(length),
            ),
          ),
        )
      ).toThrow(
        length === 31
          ? "OpenMLS public state hash must contain exactly 32 bytes"
          : "frame length exceeds the 32-byte limit",
      );
    }
    const providerState = plaintext.subarray(
      providerStateFrame + 4,
      afterFrame(plaintext, providerStateFrame),
    );
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(
          coordinates,
          replaceFrame(
            plaintext,
            providerStateFrame,
            concatV2(providerState, new Uint8Array([0])),
          ),
        ),
      )
    ).toThrow();
    expect(() =>
      fixture.provider.publicHead(
        fixture.vault.seal(
          coordinates,
          concatV2(plaintext, new Uint8Array([0])),
        ),
      )
    ).toThrow("trailing bytes");

    const cold = deviceProvider("alice-active-codec", 0xa1, 169).provider;
    (cold as unknown as { module?: unknown }).module = undefined;
    expect(() => cold.publicHead(active)).toThrow(
      "OpenMLS provider must be initialized before synchronous state access",
    );
  }, 60_000);

  test("wipes opened active state and closes its WASM resources", async () => {
    const fixture = deviceProvider("alice-active-cleanup", 0xa1, 170);
    const active = await fixture.provider.createInitialState({
      domainId: cryptoDomainId("domain-active-cleanup"),
      humanId: humanId("alice"),
    });
    const openmls = await loadDirectOpenMls();
    const originalProviderFree = openmls.Provider.prototype.free;
    const originalGroupFree = openmls.Group.prototype.free;
    const originalFill = Uint8Array.prototype.fill;
    let providerFrees = 0;
    let groupFrees = 0;
    const wipedStateFrames: Uint8Array[] = [];
    openmls.Provider.prototype.free = function () {
      providerFrees += 1;
      originalProviderFree.call(this);
    };
    openmls.Group.prototype.free = function () {
      groupFrees += 1;
      originalGroupFree.call(this);
    };
    Uint8Array.prototype.fill = function (
      value,
      start,
      end,
    ): Uint8Array {
      const before = this.slice();
      const result = originalFill.call(this, value, start, end);
      const stateDomain = new TextEncoder().encode(STATE_DOMAIN);
      if (
        value === 0
        && before.length >= stateDomain.length + 4
        && stateDomain.every((byte, index) => before[index + 4] === byte)
      ) {
        wipedStateFrames.push(this);
      }
      return result;
    };
    try {
      expect(fixture.provider.publicHead(active).domainId).toBe(
        active.domainId,
      );
    } finally {
      Uint8Array.prototype.fill = originalFill;
      openmls.Provider.prototype.free = originalProviderFree;
      openmls.Group.prototype.free = originalGroupFree;
    }
    expect(providerFrees).toBe(1);
    expect(groupFrees).toBe(1);
    expect(wipedStateFrames).toHaveLength(3);
    expect(
      wipedStateFrames.every((frameBytes) =>
        frameBytes.every((byte) => byte === 0)
      ),
    ).toBe(true);
  }, 60_000);

  test("rejects every sealed OpenMLS join-state substitution", async () => {
    const alice = deviceProvider("alice-join-codec", 0xa1, 171);
    const bob = deviceProvider("bob-join-codec", 0xb2, 172);
    const domainId = cryptoDomainId("domain-join-codec");
    const active = await alice.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const join = await bob.provider.createJoinRequest({
      domainId,
      humanId: humanId("bob"),
      expectedHead: alice.provider.publicHead(active),
    });
    const add = await alice.provider.prepareAdd({
      active,
      joinRequest: join.publicResult,
    });
    const coordinates = {
      providerId: join.localState.providerId,
      domainId,
      revision: join.localState.revision,
      snapshotKind: "candidate" as const,
    };
    const plaintext = bob.vault.open(join.localState, coordinates);
    if (!plaintext) throw new Error("Expected local OpenMLS join plaintext");

    for (const joinState of [
      { ...join.localState, providerId: "other-provider" },
      { ...join.localState, deviceId: cryptoDeviceId("other-join-device") },
      { ...join.localState, snapshotKind: "active" as const },
    ]) {
      await expectRejection(
        bob.provider.prepareWelcome({
          joinState,
          publicResult: add.publicResult,
        }),
        "Invalid local OpenMLS join state",
      );
    }
    const damagedCiphertext = join.localState.ciphertext.slice();
    damagedCiphertext[damagedCiphertext.length - 1] =
      damagedCiphertext[damagedCiphertext.length - 1]! ^ 1;
    await expectRejection(
      bob.provider.prepareWelcome({
        joinState: {
          ...join.localState,
          ciphertext: damagedCiphertext,
        },
        publicResult: add.publicResult,
      }),
      "Unable to open local OpenMLS join state",
    );

    for (const joinState of [
      bob.vault.seal(
        {
          ...coordinates,
          domainId: cryptoDomainId("other-join-domain"),
        },
        plaintext,
      ),
      bob.vault.seal(
        {
          ...coordinates,
          revision: domainEpoch(Number(coordinates.revision) + 1),
        },
        plaintext,
      ),
    ]) {
      await expectRejection(
        bob.provider.prepareWelcome({
          joinState,
          publicResult: add.publicResult,
        }),
        "OpenMLS join-state metadata mismatch",
      );
    }
    await expectRejection(
      bob.provider.prepareWelcome({
        joinState: bob.vault.seal(
          coordinates,
          concatV2(plaintext, new Uint8Array([0])),
        ),
        publicResult: add.publicResult,
      }),
      "trailing bytes",
    );

    let offset = 0;
    const joinDomainValue = 4;
    offset = afterFrame(plaintext, offset);
    const versionOffset = offset;
    offset += 4;
    const providerFrame = offset;
    offset = afterFrame(plaintext, offset);
    const domainFrame = offset;
    offset = afterFrame(plaintext, offset);
    const deviceFrame = offset;
    offset = afterFrame(plaintext, offset);
    const joinIdFrame = offset;
    offset = afterFrame(plaintext, offset);
    const lifecycleOffset = offset;
    offset += 4;
    const headProviderFrame = offset;
    offset = afterFrame(plaintext, offset);
    const headDomainFrame = offset;
    offset = afterFrame(plaintext, offset);
    const headEpochOffset = offset;
    offset += 8;
    const headHashFrame = offset;

    const wrongJoinDomain = plaintext.slice();
    wrongJoinDomain[joinDomainValue] =
      wrongJoinDomain[joinDomainValue]! ^ 1;
    await expectRejection(
      bob.provider.prepareWelcome({
        joinState: bob.vault.seal(coordinates, wrongJoinDomain),
        publicResult: add.publicResult,
      }),
      "OpenMLS join-state domain is unsupported",
    );
    const wrongVersion = plaintext.slice();
    new DataView(wrongVersion.buffer).setUint32(versionOffset, 99);
    await expectRejection(
      bob.provider.prepareWelcome({
        joinState: bob.vault.seal(coordinates, wrongVersion),
        publicResult: add.publicResult,
      }),
      "unsupported version 99",
    );
    await expectRejection(
      bob.provider.prepareWelcome({
        joinState: bob.vault.seal(
          coordinates,
          replaceFrame(
            plaintext,
            providerFrame,
            new TextEncoder().encode("other-provider"),
          ),
        ),
        publicResult: add.publicResult,
      }),
      "OpenMLS join-state provider id is invalid",
    );

    const invalidLifecycle = plaintext.slice();
    new DataView(invalidLifecycle.buffer).setUint32(lifecycleOffset, 99);
    await expectRejection(
      bob.provider.prepareWelcome({
        joinState: bob.vault.seal(coordinates, invalidLifecycle),
        publicResult: add.publicResult,
      }),
      "Local OpenMLS join lifecycle is invalid",
    );

    const metadataVariants = [
      replaceFrame(
        plaintext,
        domainFrame,
        new TextEncoder().encode("other-join-domain"),
      ),
      replaceFrame(
        plaintext,
        deviceFrame,
        new TextEncoder().encode("other-join-device"),
      ),
      replaceFrame(
        plaintext,
        headProviderFrame,
        new TextEncoder().encode("other-provider"),
      ),
      replaceFrame(
        plaintext,
        headDomainFrame,
        new TextEncoder().encode("other-join-domain"),
      ),
      (() => {
        const bytes = plaintext.slice();
        new DataView(bytes.buffer).setBigUint64(
          headEpochOffset,
          BigInt(Number(join.publicResult.expectedHead.epoch) + 2),
        );
        return bytes;
      })(),
    ];
    for (const changed of metadataVariants) {
      await expectRejection(
        bob.provider.prepareWelcome({
          joinState: bob.vault.seal(coordinates, changed),
          publicResult: add.publicResult,
        }),
        "OpenMLS join-state metadata mismatch",
      );
    }
    for (const length of [31, 33]) {
      await expectRejection(
        bob.provider.prepareWelcome({
          joinState: bob.vault.seal(
            coordinates,
            replaceFrame(
              plaintext,
              headHashFrame,
              new Uint8Array(length),
            ),
          ),
          publicResult: add.publicResult,
        }),
        length === 31
          ? "OpenMLS public state hash must contain exactly 32 bytes"
          : "frame length exceeds the 32-byte limit",
      );
    }

    const changedJoinId = replaceFrame(
      plaintext,
      joinIdFrame,
      new TextEncoder().encode("different-join-id"),
    );
    const changedJoinCandidate = await bob.provider.prepareWelcome({
      joinState: bob.vault.seal(coordinates, changedJoinId),
      publicResult: add.publicResult,
    });
    expect(() =>
      bob.provider.activateWelcome({
        candidate: changedJoinCandidate,
        joinState: join.localState,
      })
    ).toThrow(
      "OpenMLS Welcome candidate does not match its sealed join request",
    );

    const codec = bob.provider as unknown as OpenMlsCodecTestSurface;
    const joinSecrets = {
      providerState: new Uint8Array([1, 2, 3]),
      keyPackageBytes: new Uint8Array([4, 5, 6]),
    };
    codec.destroyJoinSecrets(joinSecrets);
    expect(joinSecrets.providerState).toEqual(new Uint8Array(3));
    expect(joinSecrets.keyPackageBytes).toEqual(new Uint8Array(3));
    expect(() =>
      codec.assertWelcomeCandidate(
        { joinId: "expected-join" },
        "other-join",
      )
    ).toThrow(
      "OpenMLS Welcome candidate does not match its sealed join request",
    );
  }, 60_000);

  test("wipes sealed/opened join plaintext and rejects a changed tombstone length", async () => {
    const alice = deviceProvider("alice-join-cleanup", 0xa1, 173);
    const bob = deviceProvider("bob-join-cleanup", 0xb2, 174);
    const domainId = cryptoDomainId("domain-join-cleanup");
    const active = await alice.provider.createInitialState({
      domainId,
      humanId: humanId("alice"),
    });
    const originalFill = Uint8Array.prototype.fill;
    const wipedJoinFrames: Uint8Array[] = [];
    Uint8Array.prototype.fill = function (
      value,
      start,
      end,
    ): Uint8Array {
      const before = this.slice();
      const result = originalFill.call(this, value, start, end);
      const joinDomain = new TextEncoder().encode(
        "nautilo/lattice-crypto/openmls-join-state/v2",
      );
      if (
        value === 0
        && before.length >= joinDomain.length + 4
        && joinDomain.every((byte, index) => before[index + 4] === byte)
      ) {
        wipedJoinFrames.push(this);
      }
      return result;
    };
    let join: Awaited<ReturnType<
      OpenMlsV2GroupProvider["createJoinRequest"]
    >>;
    try {
      join = await bob.provider.createJoinRequest({
        domainId,
        humanId: humanId("bob"),
        expectedHead: alice.provider.publicHead(active),
      });
      expect(wipedJoinFrames).toHaveLength(1);
      wipedJoinFrames.length = 0;
      const add = await alice.provider.prepareAdd({
        active,
        joinRequest: join.publicResult,
      });
      await bob.provider.prepareWelcome({
        joinState: join.localState,
        publicResult: add.publicResult,
      });
      expect(wipedJoinFrames).toHaveLength(3);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(
      wipedJoinFrames.every((frameBytes) =>
        frameBytes.every((byte) => byte === 0)
      ),
    ).toBe(true);

    const internals = bob.provider as unknown as OpenMlsCodecTestSurface;
    const material = internals.openJoinMaterial(join.localState);
    const originalSealJoinMaterial =
      internals.sealJoinMaterial.bind(internals);
    internals.sealJoinMaterial = () => ({
      ...join.localState,
      ciphertext: new Uint8Array(join.localState.ciphertext.length + 1),
    });
    try {
      expect(() =>
        internals.markJoinState(join.localState, material, "aborted")
      ).toThrow(
        "Local OpenMLS join tombstone length changed unexpectedly",
      );
    } finally {
      internals.sealJoinMaterial = originalSealJoinMaterial;
      internals.destroyJoinSecrets(material);
    }
  }, 60_000);

  test("strictly encodes and decodes OpenMLS Welcome material at exact limits", () => {
    const { provider } = deviceProvider(
      "welcome-codec-device",
      0xa1,
      166,
    );
    const codec = provider as unknown as OpenMlsCodecTestSurface;
    const oneByteWelcome = new Uint8Array([0x11]);
    const oneByteTree = new Uint8Array([0x22]);
    const encoded = codec.encodeWelcome(oneByteWelcome, oneByteTree);

    expect(codec.decodeWelcome(encoded)).toEqual({
      welcomeBytes: oneByteWelcome,
      ratchetTreeBytes: oneByteTree,
    });
    expect(() =>
      codec.encodeWelcome(new Uint8Array(), oneByteTree)
    ).toThrow("OpenMLS Welcome material exceeds v2 limits");
    expect(() =>
      codec.encodeWelcome(oneByteWelcome, new Uint8Array())
    ).toThrow("OpenMLS Welcome material exceeds v2 limits");
    expect(() =>
      codec.encodeWelcome(
        new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES),
        oneByteTree,
      )
    ).toThrow("OpenMLS Welcome bundle exceeds the v2 provider-state limit");
    expect(() =>
      codec.encodeWelcome(
        oneByteWelcome,
        new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES),
      )
    ).toThrow("OpenMLS Welcome bundle exceeds the v2 provider-state limit");
    expect(() =>
      codec.encodeWelcome(
        new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
        oneByteTree,
      )
    ).toThrow("OpenMLS Welcome material exceeds v2 limits");
    expect(() =>
      codec.encodeWelcome(
        oneByteWelcome,
        new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
      )
    ).toThrow("OpenMLS Welcome material exceeds v2 limits");

    const framingOverhead = encoded.length
      - oneByteWelcome.length
      - oneByteTree.length;
    const exactTree = new Uint8Array(
      V2_PROVIDER_STATE_MAX_BYTES
        - framingOverhead
        - oneByteWelcome.length,
    );
    const exactBundle = codec.encodeWelcome(oneByteWelcome, exactTree);
    expect(exactBundle).toHaveLength(V2_PROVIDER_STATE_MAX_BYTES);
    expect(codec.decodeWelcome(exactBundle)).toEqual({
      welcomeBytes: oneByteWelcome,
      ratchetTreeBytes: exactTree,
    });
    expect(() =>
      codec.encodeWelcome(
        oneByteWelcome,
        new Uint8Array(exactTree.length + 1),
      )
    ).toThrow("OpenMLS Welcome bundle exceeds the v2 provider-state limit");

    for (const value of [
      null as never,
      new Uint8Array(),
      new Uint8Array(V2_PROVIDER_STATE_MAX_BYTES + 1),
    ]) {
      expect(() => codec.decodeWelcome(value)).toThrow(
        "OpenMLS Welcome bundle is invalid",
      );
    }
    expect(
      thrownMessage(() => codec.decodeWelcome(new Uint8Array(1))),
    ).not.toContain("OpenMLS Welcome bundle is invalid");

    const wrongDomain = encoded.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    expect(() => codec.decodeWelcome(wrongDomain)).toThrow(
      "OpenMLS Welcome domain is unsupported",
    );
    const versionOffset = 4 + WELCOME_DOMAIN.length;
    const wrongVersion = encoded.slice();
    new DataView(wrongVersion.buffer).setUint32(versionOffset, 99);
    expect(() => codec.decodeWelcome(wrongVersion)).toThrow(
      "unsupported version 99",
    );
    expect(() =>
      codec.decodeWelcome(concatV2(encoded, new Uint8Array([0])))
    ).toThrow("trailing bytes");

    for (const [welcomeBytes, ratchetTreeBytes] of [
      [new Uint8Array(), oneByteTree],
      [oneByteWelcome, new Uint8Array()],
    ] as const) {
      const emptyMaterial = concatV2(
        frameText(WELCOME_DOMAIN),
        encodeU32(2),
        frame(welcomeBytes),
        frame(ratchetTreeBytes),
      );
      expect(() => codec.decodeWelcome(emptyMaterial)).toThrow(
        "OpenMLS Welcome material is empty",
      );
    }
  });

  test("owns bounded OpenMLS ratchet-tree bytes and always frees the WASM tree", () => {
    const { provider } = deviceProvider(
      "ratchet-tree-boundaries",
      0xa1,
      175,
    );
    const codec = provider as unknown as OpenMlsCodecTestSurface;
    const readTree = (bytes: Uint8Array): Readonly<{
      result?: Uint8Array;
      error?: string;
      frees: number;
    }> => {
      let frees = 0;
      let result: Uint8Array | undefined;
      let errorMessage: string | undefined;
      try {
        result = codec.ratchetTreeBytes({
          export_ratchet_tree: () => ({
            to_bytes: () => bytes,
            free: () => {
              frees += 1;
            },
          }),
        });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      return {
        ...(result === undefined ? {} : { result }),
        ...(errorMessage === undefined ? {} : { error: errorMessage }),
        frees,
      };
    };

    for (const length of [1, V2_PROVIDER_STATE_MAX_BYTES]) {
      const input = new Uint8Array(length).fill(0x5a);
      const outcome = readTree(input);
      expect(outcome.error).toBeUndefined();
      expect(outcome.result).toEqual(input);
      expect(outcome.result).not.toBe(input);
      expect(outcome.frees).toBe(1);
    }
    for (const length of [0, V2_PROVIDER_STATE_MAX_BYTES + 1]) {
      const outcome = readTree(new Uint8Array(length));
      expect(outcome.error).toBe(
        "OpenMLS ratchet tree exceeds the v2 provider-state limit",
      );
      expect(outcome.frees).toBe(1);
    }
  });

  test("strictly decodes authenticated OpenMLS rosters and validates membership deltas", () => {
    const { provider } = deviceProvider(
      "roster-codec-device",
      0xa1,
      167,
    );
    const codec = provider as unknown as OpenMlsCodecTestSurface;
    const alice: OpenMlsRosterTestEntry = {
      leafIndex: 2,
      humanId: humanId("alice"),
      deviceId: cryptoDeviceId("alice-device"),
    };
    const bob: OpenMlsRosterTestEntry = {
      leafIndex: 0,
      humanId: humanId("bob"),
      deviceId: cryptoDeviceId("bob-device"),
    };
    const charlie: OpenMlsRosterTestEntry = {
      leafIndex: 4,
      humanId: humanId("charlie"),
      deviceId: cryptoDeviceId("charlie-device"),
    };
    const decodeRoster = (
      bytes: Uint8Array,
    ): readonly OpenMlsRosterTestEntry[] =>
      codec.roster({ member_roster: () => bytes });

    const valid = rawOpenMlsRoster([
      {
        leafIndex: alice.leafIndex,
        credential: openMlsCredential(alice.humanId, alice.deviceId),
      },
      {
        leafIndex: bob.leafIndex,
        credential: openMlsCredential(bob.humanId, bob.deviceId),
      },
    ]);
    expect(decodeRoster(valid)).toEqual([bob, alice]);

    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([1]),
      new Uint8Array([1, 0]),
      new Uint8Array([1, 0, 0]),
      concatV2(encodeU32Le(1), new Uint8Array([0])),
    ]) {
      expect(() => decodeRoster(bytes)).toThrow(
        "Authenticated OpenMLS roster is truncated",
      );
    }
    expect(() =>
      decodeRoster(
        new Uint8Array(V2_LIMITS.namespaceKeyringBytes + 1),
      )
    ).toThrow("OpenMLS roster exceeds the v2 byte limit");
    expect(
      thrownMessage(() =>
        decodeRoster(new Uint8Array(V2_LIMITS.namespaceKeyringBytes))
      ),
    ).not.toContain("OpenMLS roster exceeds the v2 byte limit");
    expect(() => decodeRoster(encodeU32Le(257))).toThrow(
      "OpenMLS roster exceeds the 256-device Domain limit",
    );
    const maximumDeviceRoster = Array.from(
      { length: V2_LIMITS.deviceLeavesPerDomain },
      (_, index) => ({
        leafIndex: index,
        credential: openMlsCredential(
          humanId(`human-${index % V2_LIMITS.humanParticipantsPerDomain}`),
          cryptoDeviceId(`maximum-device-${index}`),
        ),
      }),
    );
    expect(decodeRoster(rawOpenMlsRoster(maximumDeviceRoster))).toHaveLength(
      V2_LIMITS.deviceLeavesPerDomain,
    );
    expect(() =>
      decodeRoster(concatV2(
        encodeU32Le(1),
        encodeU32Le(0),
        encodeU32Le(100_000),
      ))
    ).toThrow("Authenticated OpenMLS roster identity is invalid");
    const ordinaryCredential = openMlsCredential(
      humanId("ordinary-human"),
      cryptoDeviceId("ordinary-device"),
    );
    expect(() =>
      decodeRoster(concatV2(
        encodeU32Le(1),
        encodeU32Le(0),
        encodeU32Le(ordinaryCredential.length),
        ordinaryCredential.slice(0, -1),
      ))
    ).toThrow("Authenticated OpenMLS roster identity is invalid");
    const maximumId = "x".repeat(V2_LIMITS.idBytes);
    const maximumCredential = openMlsCredential(
      humanId(maximumId),
      cryptoDeviceId(maximumId),
    );
    expect(decodeRoster(rawOpenMlsRoster([
      { leafIndex: 0, credential: maximumCredential },
    ]))).toHaveLength(1);
    expect(() =>
      decodeRoster(rawOpenMlsRoster([
        {
          leafIndex: 0,
          credential: concatV2(maximumCredential, new Uint8Array([0])),
        },
      ]))
    ).toThrow("Authenticated OpenMLS roster identity is invalid");
    expect(() =>
      decodeRoster(rawOpenMlsRoster([
        { leafIndex: 0, credential: new Uint8Array([0xff]) },
      ]))
    ).toThrow("Authenticated OpenMLS roster identity is not UTF-8");
    expect(() =>
      decodeRoster(rawOpenMlsRoster([
        {
          leafIndex: 0,
          credential: new TextEncoder().encode("unsupported"),
        },
      ]))
    ).toThrow("Authenticated OpenMLS credential is unsupported");

    const uppercaseCredential = openMlsCredential(
      humanId("alice"),
      cryptoDeviceId("uppercase-device"),
    );
    const uppercaseText = new TextDecoder()
      .decode(uppercaseCredential)
      .replace(/[a-f]/g, (value) => value.toUpperCase());
    expect(() =>
      decodeRoster(rawOpenMlsRoster([
        {
          leafIndex: 0,
          credential: new TextEncoder().encode(uppercaseText),
        },
      ]))
    ).toThrow("OpenMLS credential is not canonical lowercase hex");
    expect(() =>
      decodeRoster(rawOpenMlsRoster([
        {
          leafIndex: 0,
          credential: new TextEncoder().encode("v2_0"),
        },
      ]))
    ).toThrow("OpenMLS credential is not canonical lowercase hex");

    const wrongDomainCredential = new TextEncoder().encode(
      `v2_${lowerHex(concatV2(
        frameText("nautilo/lattice-crypto/other-credential/v2"),
        frameText(humanId("alice")),
        frameText(cryptoDeviceId("wrong-domain-device")),
      ))}`,
    );
    expect(() =>
      decodeRoster(rawOpenMlsRoster([
        { leafIndex: 0, credential: wrongDomainCredential },
      ]))
    ).toThrow("OpenMLS credential domain is unsupported");
    const trailingCredential = new TextEncoder().encode(
      `v2_${lowerHex(concatV2(
        frameText(CREDENTIAL_DOMAIN),
        frameText(humanId("alice")),
        frameText(cryptoDeviceId("trailing-device")),
        new Uint8Array([0]),
      ))}`,
    );
    expect(() =>
      decodeRoster(rawOpenMlsRoster([
        { leafIndex: 0, credential: trailingCredential },
      ]))
    ).toThrow("trailing bytes");

    expect(() =>
      decodeRoster(rawOpenMlsRoster([
        {
          leafIndex: 0,
          credential: openMlsCredential(
            humanId("alice"),
            cryptoDeviceId("duplicate-device"),
          ),
        },
        {
          leafIndex: 1,
          credential: openMlsCredential(
            humanId("bob"),
            cryptoDeviceId("duplicate-device"),
          ),
        },
      ]))
    ).toThrow("Authenticated OpenMLS roster contains duplicate identity");
    expect(() =>
      decodeRoster(rawOpenMlsRoster([
        {
          leafIndex: 0,
          credential: openMlsCredential(
            humanId("alice"),
            cryptoDeviceId("first-device"),
          ),
        },
        {
          leafIndex: 0,
          credential: openMlsCredential(
            humanId("bob"),
            cryptoDeviceId("second-device"),
          ),
        },
      ]))
    ).toThrow("Authenticated OpenMLS roster contains duplicate identity");
    expect(() =>
      decodeRoster(rawOpenMlsRoster([
        {
          leafIndex: 0,
          credential: openMlsCredential(
            humanId("alice"),
            cryptoDeviceId("trailing-roster-device"),
          ),
        },
      ], new Uint8Array([0])))
    ).toThrow("Authenticated OpenMLS roster has trailing bytes");

    const emptyEncodedRoster = codec.encodeRoster([]);
    const exactEncodedRoster = codec.encodeRoster([{
      leafIndex: 0,
      humanId: "x".repeat(
        V2_LIMITS.namespaceKeyringBytes - emptyEncodedRoster.length - 12,
      ) as HumanId,
      deviceId: "" as CryptoDeviceId,
    }]);
    expect(exactEncodedRoster).toHaveLength(
      V2_LIMITS.namespaceKeyringBytes,
    );
    expect(() =>
      codec.encodeRoster([{
        leafIndex: 0,
        humanId: `${"x".repeat(
          V2_LIMITS.namespaceKeyringBytes - emptyEncodedRoster.length - 12,
        )}x` as HumanId,
        deviceId: "" as CryptoDeviceId,
      }])
    ).toThrow("Canonical OpenMLS roster exceeds the v2 byte limit");

    const sixtyFourHumans = Array.from({ length: 64 }, (_, index) => ({
      leafIndex: index,
      credential: openMlsCredential(
        humanId(`human-${index}`),
        cryptoDeviceId(`device-${index}`),
      ),
    }));
    expect(decodeRoster(rawOpenMlsRoster(sixtyFourHumans))).toHaveLength(64);
    expect(() =>
      decodeRoster(rawOpenMlsRoster([
        ...sixtyFourHumans,
        {
          leafIndex: 64,
          credential: openMlsCredential(
            humanId("human-64"),
            cryptoDeviceId("device-64"),
          ),
        },
      ]))
    ).toThrow("OpenMLS roster exceeds the 64-Human Domain limit");

    codec.assertAddRoster(
      [alice],
      [alice, bob],
      { humanId: bob.humanId, deviceId: bob.deviceId },
    );
    for (const next of [
      [alice],
      [alice, bob, charlie],
      [alice, charlie],
      [alice, { ...bob, humanId: humanId("mallory") }],
      [bob, charlie],
      [{ ...alice, humanId: humanId("mallory") }, bob],
      [{ ...alice, leafIndex: 3 }, bob],
    ]) {
      expect(() =>
        codec.assertAddRoster(
          [alice],
          next,
          { humanId: bob.humanId, deviceId: bob.deviceId },
        )
      ).toThrow(
        "Join request identity does not match the authenticated OpenMLS roster",
      );
    }
    expect(() =>
      codec.assertAddRoster(
        [alice, charlie],
        [alice, bob, { ...charlie, leafIndex: 5 }],
        { humanId: bob.humanId, deviceId: bob.deviceId },
      )
    ).toThrow(
      "Join request identity does not match the authenticated OpenMLS roster",
    );

    codec.assertRemoveRoster(
      [alice, bob, charlie],
      [alice, charlie],
      bob.deviceId,
    );
    for (const next of [
      [alice, bob, charlie],
      [alice, bob],
      [alice],
      [{ ...alice, humanId: humanId("mallory") }, charlie],
      [{ ...alice, leafIndex: 3 }, charlie],
    ]) {
      expect(() =>
        codec.assertRemoveRoster(
          [alice, bob, charlie],
          next,
          bob.deviceId,
        )
      ).toThrow(
        "Removal does not match the authenticated OpenMLS roster",
      );
    }
    const dave: OpenMlsRosterTestEntry = {
      leafIndex: 6,
      humanId: humanId("dave"),
      deviceId: cryptoDeviceId("dave-device"),
    };
    expect(() =>
      codec.assertRemoveRoster(
        [alice, bob, charlie],
        [alice, charlie, dave],
        bob.deviceId,
      )
    ).toThrow(
      "Removal does not match the authenticated OpenMLS roster",
    );
  });
});
