import { LatticeCrypto, seededRng } from "../crypto/index.ts";
import {
  type SealedProviderStateV2,
  DeviceProviderStateVaultV2,
} from "../device/v2-state-vault.ts";
import { DummyV2GroupProvider } from "../group/v2-dummy.ts";
import { TsMlsV2GroupProvider } from "../group/v2-mls.ts";
import { OpenMlsV2GroupProvider } from "../group/v2-openmls.ts";
import type {
  DomainRootsV2,
  V2GroupKeyProvider,
} from "../group/v2-provider.ts";
import type {
  LocalProviderCandidateV2,
  PreparedProviderCommitV2,
  ProviderApplyResultV2,
  ProviderPublicHeadV2,
  ProviderPublicTransitionV2,
} from "../transition/provider-candidate.ts";
import {
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  type CryptoDeviceId,
  type CryptoDomainId,
  type HumanId,
} from "../v2-types/ids.ts";

export type V2ProviderSemantic =
  | "human-add"
  | "human-remove"
  | "device-add"
  | "device-revoke";

export interface V2ProviderFixture {
  readonly crypto: LatticeCrypto;
  readonly provider: V2GroupKeyProvider;
  readonly active: SealedProviderStateV2;
}

export interface V2ProviderSemanticTransition {
  readonly requestedSemantic: V2ProviderSemantic;
  readonly actualSemantic: V2ProviderSemantic | "update-only";
  readonly beforeActive: SealedProviderStateV2;
  readonly afterActive: SealedProviderStateV2;
  readonly beforeHead: ProviderPublicHeadV2;
  readonly afterHead: ProviderPublicHeadV2;
  readonly beforeRoster: Uint8Array;
  readonly afterRoster: Uint8Array;
  readonly beforeRoots: DomainRootsV2;
  readonly afterRoots: DomainRootsV2;
  readonly retainedPeerRoots: DomainRootsV2 | null;
  readonly joiningPeerRoots: DomainRootsV2 | null;
  readonly removedDeviceId: CryptoDeviceId | null;
  readonly removedPeerCannotExport: boolean;
}

export interface V2PreparedSemanticTransition {
  readonly requestedSemantic: V2ProviderSemantic;
  readonly actualSemantic: V2ProviderSemantic | "update-only";
  readonly prepared: PreparedProviderCommitV2;
}

export interface V2ProviderMatrixRow {
  readonly id: "dummy" | "ts-mls" | "openmls";
  create(input: {
    readonly seed: number;
    readonly domainId: CryptoDomainId;
  }): Promise<V2ProviderFixture>;
  exerciseSemanticTransition(input: {
    readonly fixture: V2ProviderFixture;
    readonly semantic: V2ProviderSemantic;
    readonly seed: number;
  }): Promise<V2ProviderSemanticTransition>;
  prepareSemanticTransition(input: {
    readonly fixture: V2ProviderFixture;
    readonly semantic: V2ProviderSemantic;
    readonly seed: number;
  }): Promise<V2PreparedSemanticTransition>;
}

interface PublicJoinRequest {
  readonly formatVersion: 2;
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly keyPackageBytes: Uint8Array;
}

interface MembershipProvider extends V2GroupKeyProvider {
  createInitialState(input: {
    readonly domainId: CryptoDomainId;
    readonly humanId: HumanId;
  }): Promise<SealedProviderStateV2>;
  createJoinRequest(input: {
    readonly domainId: CryptoDomainId;
    readonly humanId: HumanId;
    readonly expectedHead: ProviderPublicHeadV2;
  }): Promise<{
    readonly publicResult: PublicJoinRequest;
    readonly localState: SealedProviderStateV2;
  }>;
  prepareAdd(input: {
    readonly active: SealedProviderStateV2;
    readonly joinRequest: PublicJoinRequest;
  }): Promise<PreparedProviderCommitV2>;
  prepareRemove(input: {
    readonly active: SealedProviderStateV2;
    readonly removedDeviceId: CryptoDeviceId;
  }): Promise<PreparedProviderCommitV2>;
  prepareWelcome(input: {
    readonly joinState: SealedProviderStateV2;
    readonly publicResult: ProviderPublicTransitionV2;
  }): Promise<LocalProviderCandidateV2>;
  activateWelcome(input: {
    readonly candidate: LocalProviderCandidateV2;
    readonly joinState: SealedProviderStateV2;
  }): ProviderApplyResultV2;
}

type MembershipProviderFactory = (
  crypto: LatticeCrypto,
  vault: DeviceProviderStateVaultV2,
) => MembershipProvider;

interface ActiveMember {
  readonly provider: MembershipProvider;
  readonly active: SealedProviderStateV2;
}

interface ActiveDummyMember {
  readonly provider: DummyV2GroupProvider;
  readonly active: SealedProviderStateV2;
}

function localKey(seed: number): Uint8Array {
  const key = new Uint8Array(32);
  for (let index = 0; index < key.length; index += 1) {
    key[index] = (seed + index * 17) & 0xff;
  }
  return key;
}

function fixtureCrypto(
  seed: number,
  deviceId = cryptoDeviceId(`scenario-device-${seed}`),
): {
  readonly crypto: LatticeCrypto;
  readonly vault: DeviceProviderStateVaultV2;
} {
  const crypto = new LatticeCrypto(seededRng(seed));
  return {
    crypto,
    vault: DeviceProviderStateVaultV2.fromKey(
      crypto,
      deviceId,
      localKey(seed),
    ),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function assertApplied(
  result: ProviderApplyResultV2,
  label: string,
): SealedProviderStateV2 {
  if (result.status !== "applied") {
    throw new Error(`${label} did not apply`);
  }
  return result.active;
}

function member(
  factory: MembershipProviderFactory,
  seed: number,
  label: string,
): MembershipProvider {
  const { crypto, vault } = fixtureCrypto(
    seed,
    cryptoDeviceId(`scenario-${label}-${seed}`),
  );
  return factory(crypto, vault);
}

async function addMember(input: {
  readonly source: MembershipProvider;
  readonly sourceActive: SealedProviderStateV2;
  readonly joining: MembershipProvider;
  readonly joiningHumanId: HumanId;
  readonly existingPeers?: readonly ActiveMember[];
}): Promise<{
  readonly sourceActive: SealedProviderStateV2;
  readonly joiningActive: SealedProviderStateV2;
  readonly existingPeers: readonly ActiveMember[];
}> {
  const head = input.source.publicHead(input.sourceActive);
  const join = await input.joining.createJoinRequest({
    domainId: head.domainId,
    humanId: input.joiningHumanId,
    expectedHead: head,
  });
  const prepared = await input.source.prepareAdd({
    active: input.sourceActive,
    joinRequest: join.publicResult,
  });
  const incomingPeers = await Promise.all(
    (input.existingPeers ?? []).map(async ({ provider, active }) => ({
      provider,
      active,
      candidate: await provider.prepareIncoming({
        active,
        publicResult: prepared.publicResult,
      }),
    })),
  );
  const joiningCandidate = await input.joining.prepareWelcome({
    joinState: join.localState,
    publicResult: prepared.publicResult,
  });
  return {
    sourceActive: assertApplied(
      input.source.applyCandidate({
        active: input.sourceActive,
        candidate: prepared.localCandidate,
      }),
      "Source membership add",
    ),
    joiningActive: assertApplied(
      input.joining.activateWelcome({
        candidate: joiningCandidate,
        joinState: join.localState,
      }),
      "Joining membership add",
    ),
    existingPeers: incomingPeers.map(({ provider, active, candidate }) => ({
      provider,
      active: assertApplied(
        provider.applyCandidate({ active, candidate }),
        "Existing peer membership add",
      ),
    })),
  };
}

async function removedCannotExport(
  provider: V2GroupKeyProvider,
  active: SealedProviderStateV2,
): Promise<boolean> {
  try {
    await provider.exportDomainRoots(active);
    return false;
  } catch {
    return true;
  }
}

function dummyMember(seed: number, label: string): DummyV2GroupProvider {
  const { crypto, vault } = fixtureCrypto(
    seed,
    cryptoDeviceId(`scenario-${label}-${seed}`),
  );
  return new DummyV2GroupProvider(crypto, vault);
}

async function addDummyMember(input: {
  readonly source: DummyV2GroupProvider;
  readonly sourceActive: SealedProviderStateV2;
  readonly joining: DummyV2GroupProvider;
  readonly joiningHumanId: HumanId;
  readonly joiningDeviceId: CryptoDeviceId;
  readonly existingPeers?: readonly ActiveDummyMember[];
}): Promise<{
  readonly sourceActive: SealedProviderStateV2;
  readonly joiningActive: SealedProviderStateV2;
  readonly existingPeers: readonly ActiveDummyMember[];
}> {
  const bootstrap = input.source.exportSemanticBootstrapForTesting(
    input.sourceActive,
  );
  const joiningBefore = input.joining.bootstrapSemanticForTesting(bootstrap);
  const prepared = await input.source.prepareAdd({
    active: input.sourceActive,
    humanId: input.joiningHumanId,
    deviceId: input.joiningDeviceId,
  });
  const incoming = await Promise.all([
    input.joining.prepareIncoming({
      active: joiningBefore,
      publicResult: prepared.publicResult,
    }),
    ...(input.existingPeers ?? []).map(({ provider, active }) =>
      provider.prepareIncoming({
        active,
        publicResult: prepared.publicResult,
      })
    ),
  ]);
  return {
    sourceActive: assertApplied(
      input.source.applyCandidate({
        active: input.sourceActive,
        candidate: prepared.localCandidate,
      }),
      "Dummy source membership add",
    ),
    joiningActive: assertApplied(
      input.joining.applyCandidate({
        active: joiningBefore,
        candidate: incoming[0],
      }),
      "Dummy joining membership add",
    ),
    existingPeers: (input.existingPeers ?? []).map(
      ({ provider, active }, index) => ({
        provider,
        active: assertApplied(
          provider.applyCandidate({
            active,
            candidate: incoming[index + 1]!,
          }),
          "Dummy existing peer membership add",
        ),
      }),
    ),
  };
}

async function exerciseDummyTransition(input: {
  readonly fixture: V2ProviderFixture;
  readonly semantic: V2ProviderSemantic;
  readonly seed: number;
}): Promise<V2ProviderSemanticTransition> {
  const source = input.fixture.provider as DummyV2GroupProvider;
  let beforeActive = input.fixture.active;
  let afterActive: SealedProviderStateV2;
  let joiningPeerRoots: DomainRootsV2 | null = null;
  let retainedPeerRoots: DomainRootsV2 | null = null;
  let removedDeviceId: CryptoDeviceId | null = null;
  let removedPeerCannotExport = false;

  if (input.semantic === "human-add" || input.semantic === "device-add") {
    const label = input.semantic === "human-add"
      ? "charlie"
      : "alice-device-two";
    const joining = dummyMember(input.seed, label);
    const deviceId = cryptoDeviceId(`scenario-${label}-${input.seed}`);
    const added = await addDummyMember({
      source,
      sourceActive: beforeActive,
      joining,
      joiningHumanId: input.semantic === "human-add"
        ? humanId("charlie")
        : humanId("alice"),
      joiningDeviceId: deviceId,
    });
    afterActive = added.sourceActive;
    joiningPeerRoots = await joining.exportDomainRoots(added.joiningActive);
  } else if (input.semantic === "device-revoke") {
    const revoked = dummyMember(input.seed, "alice-revoked-device");
    removedDeviceId = cryptoDeviceId(
      `scenario-alice-revoked-device-${input.seed}`,
    );
    const added = await addDummyMember({
      source,
      sourceActive: beforeActive,
      joining: revoked,
      joiningHumanId: humanId("alice"),
      joiningDeviceId: removedDeviceId,
    });
    beforeActive = added.sourceActive;
    const prepared = await source.prepareRemove({
      active: beforeActive,
      removedDeviceId,
    });
    const removedCandidate = await revoked.prepareIncoming({
      active: added.joiningActive,
      publicResult: prepared.publicResult,
    });
    afterActive = assertApplied(
      source.applyCandidate({
        active: beforeActive,
        candidate: prepared.localCandidate,
      }),
      "Dummy source device revoke",
    );
    const removedActive = assertApplied(
      revoked.applyCandidate({
        active: added.joiningActive,
        candidate: removedCandidate,
      }),
      "Dummy revoked device",
    );
    removedPeerCannotExport = await removedCannotExport(
      revoked,
      removedActive,
    );
  } else {
    const bob = dummyMember(input.seed, "bob");
    const bobDeviceId = cryptoDeviceId(`scenario-bob-${input.seed}`);
    removedDeviceId = bobDeviceId;
    const bobAdded = await addDummyMember({
      source,
      sourceActive: beforeActive,
      joining: bob,
      joiningHumanId: humanId("bob"),
      joiningDeviceId: bobDeviceId,
    });
    const charlie = dummyMember(input.seed + 1, "charlie");
    const charlieAdded = await addDummyMember({
      source,
      sourceActive: bobAdded.sourceActive,
      joining: charlie,
      joiningHumanId: humanId("charlie"),
      joiningDeviceId: cryptoDeviceId(
        `scenario-charlie-${input.seed + 1}`,
      ),
      existingPeers: [{
        provider: bob,
        active: bobAdded.joiningActive,
      }],
    });
    const bobCurrent = charlieAdded.existingPeers[0];
    if (!bobCurrent) throw new Error("Dummy Bob missed Charlie add");
    beforeActive = charlieAdded.sourceActive;
    const prepared = await source.prepareRemove({
      active: beforeActive,
      removedDeviceId: bobDeviceId,
    });
    const [bobCandidate, charlieCandidate] = await Promise.all([
      bob.prepareIncoming({
        active: bobCurrent.active,
        publicResult: prepared.publicResult,
      }),
      charlie.prepareIncoming({
        active: charlieAdded.joiningActive,
        publicResult: prepared.publicResult,
      }),
    ]);
    afterActive = assertApplied(
      source.applyCandidate({
        active: beforeActive,
        candidate: prepared.localCandidate,
      }),
      "Dummy source Human remove",
    );
    const bobRemoved = assertApplied(
      bob.applyCandidate({
        active: bobCurrent.active,
        candidate: bobCandidate,
      }),
      "Dummy removed Human",
    );
    const charlieRetained = assertApplied(
      charlie.applyCandidate({
        active: charlieAdded.joiningActive,
        candidate: charlieCandidate,
      }),
      "Dummy retained Human",
    );
    removedPeerCannotExport = await removedCannotExport(bob, bobRemoved);
    retainedPeerRoots = await charlie.exportDomainRoots(charlieRetained);
  }

  return Object.freeze({
    requestedSemantic: input.semantic,
    actualSemantic: input.semantic,
    beforeActive,
    afterActive,
    beforeHead: source.publicHead(beforeActive),
    afterHead: source.publicHead(afterActive),
    beforeRoster: source.publicRoster(beforeActive),
    afterRoster: source.publicRoster(afterActive),
    beforeRoots: await source.exportDomainRoots(beforeActive),
    afterRoots: await source.exportDomainRoots(afterActive),
    retainedPeerRoots,
    joiningPeerRoots,
    removedDeviceId,
    removedPeerCannotExport,
  });
}

async function exerciseRealTransition(input: {
  readonly fixture: V2ProviderFixture;
  readonly semantic: V2ProviderSemantic;
  readonly seed: number;
  readonly factory: MembershipProviderFactory;
}): Promise<V2ProviderSemanticTransition> {
  const source = input.fixture.provider as MembershipProvider;
  let beforeActive = input.fixture.active;
  let afterActive: SealedProviderStateV2;
  let joiningPeerRoots: DomainRootsV2 | null = null;
  let retainedPeerRoots: DomainRootsV2 | null = null;
  let removedDeviceId: CryptoDeviceId | null = null;
  let removedPeerCannotExport = false;

  if (input.semantic === "human-add" || input.semantic === "device-add") {
    const joining = member(
      input.factory,
      input.seed,
      input.semantic === "human-add" ? "charlie" : "alice-device-two",
    );
    const added = await addMember({
      source,
      sourceActive: beforeActive,
      joining,
      joiningHumanId: input.semantic === "human-add"
        ? humanId("charlie")
        : humanId("alice"),
    });
    afterActive = added.sourceActive;
    joiningPeerRoots = await joining.exportDomainRoots(
      added.joiningActive,
    );
  } else if (input.semantic === "device-revoke") {
    const revoked = member(
      input.factory,
      input.seed,
      "alice-revoked-device",
    );
    const added = await addMember({
      source,
      sourceActive: beforeActive,
      joining: revoked,
      joiningHumanId: humanId("alice"),
    });
    beforeActive = added.sourceActive;
    removedDeviceId = cryptoDeviceId(
      `scenario-alice-revoked-device-${input.seed}`,
    );
    const prepared = await source.prepareRemove({
      active: beforeActive,
      removedDeviceId,
    });
    const removedCandidate = await revoked.prepareIncoming({
      active: added.joiningActive,
      publicResult: prepared.publicResult,
    });
    afterActive = assertApplied(
      source.applyCandidate({
        active: beforeActive,
        candidate: prepared.localCandidate,
      }),
      "Source device revoke",
    );
    const removedActive = assertApplied(
      revoked.applyCandidate({
        active: added.joiningActive,
        candidate: removedCandidate,
      }),
      "Revoked device",
    );
    removedPeerCannotExport = await removedCannotExport(
      revoked,
      removedActive,
    );
  } else {
    const bob = member(input.factory, input.seed, "bob");
    const bobAdded = await addMember({
      source,
      sourceActive: beforeActive,
      joining: bob,
      joiningHumanId: humanId("bob"),
    });
    const charlie = member(input.factory, input.seed + 1, "charlie");
    const charlieAdded = await addMember({
      source,
      sourceActive: bobAdded.sourceActive,
      joining: charlie,
      joiningHumanId: humanId("charlie"),
      existingPeers: [{
        provider: bob,
        active: bobAdded.joiningActive,
      }],
    });
    const bobCurrent = charlieAdded.existingPeers[0];
    if (!bobCurrent) throw new Error("Bob did not receive Charlie add");
    beforeActive = charlieAdded.sourceActive;
    removedDeviceId = cryptoDeviceId(`scenario-bob-${input.seed}`);
    const prepared = await source.prepareRemove({
      active: beforeActive,
      removedDeviceId,
    });
    const [bobCandidate, charlieCandidate] = await Promise.all([
      bob.prepareIncoming({
        active: bobCurrent.active,
        publicResult: prepared.publicResult,
      }),
      charlie.prepareIncoming({
        active: charlieAdded.joiningActive,
        publicResult: prepared.publicResult,
      }),
    ]);
    afterActive = assertApplied(
      source.applyCandidate({
        active: beforeActive,
        candidate: prepared.localCandidate,
      }),
      "Source Human removal",
    );
    const bobRemoved = assertApplied(
      bob.applyCandidate({
        active: bobCurrent.active,
        candidate: bobCandidate,
      }),
      "Removed Human",
    );
    const charlieRetained = assertApplied(
      charlie.applyCandidate({
        active: charlieAdded.joiningActive,
        candidate: charlieCandidate,
      }),
      "Retained Human",
    );
    removedPeerCannotExport = await removedCannotExport(bob, bobRemoved);
    retainedPeerRoots = await charlie.exportDomainRoots(charlieRetained);
  }

  const beforeHead = source.publicHead(beforeActive);
  const afterHead = source.publicHead(afterActive);
  const beforeRoots = await source.exportDomainRoots(beforeActive);
  const afterRoots = await source.exportDomainRoots(afterActive);
  if (
    Number(afterHead.epoch) !== Number(beforeHead.epoch) + 1
    || sameBytes(beforeRoots.human, afterRoots.human)
    || sameBytes(beforeRoots.ai, afterRoots.ai)
  ) {
    throw new Error("Real membership transition did not rotate one epoch");
  }
  return Object.freeze({
    requestedSemantic: input.semantic,
    actualSemantic: input.semantic,
    beforeActive,
    afterActive,
    beforeHead,
    afterHead,
    beforeRoster: source.publicRoster(beforeActive),
    afterRoster: source.publicRoster(afterActive),
    beforeRoots,
    afterRoots,
    retainedPeerRoots,
    joiningPeerRoots,
    removedDeviceId,
    removedPeerCannotExport,
  });
}

function realProviderRow(
  id: "ts-mls" | "openmls",
  factory: MembershipProviderFactory,
): V2ProviderMatrixRow {
  return {
    id,
    async create({ seed, domainId }) {
      const { crypto, vault } = fixtureCrypto(seed);
      const provider = factory(crypto, vault);
      return {
        crypto,
        provider,
        active: await provider.createInitialState({
          domainId: cryptoDomainId(domainId),
          humanId: humanId("alice"),
        }),
      };
    },
    exerciseSemanticTransition({ fixture, semantic, seed }) {
      return exerciseRealTransition({ fixture, semantic, seed, factory });
    },
    async prepareSemanticTransition({ fixture, semantic, seed }) {
      if (semantic !== "human-add" && semantic !== "device-add") {
        throw new Error(
          "Prepared real scenario transition supports add semantics only",
        );
      }
      const provider = fixture.provider as MembershipProvider;
      const joining = member(factory, seed, "prepared-member");
      const head = provider.publicHead(fixture.active);
      const join = await joining.createJoinRequest({
        domainId: head.domainId,
        humanId: semantic === "human-add"
          ? humanId("charlie")
          : humanId("alice"),
        expectedHead: head,
      });
      return Object.freeze({
        requestedSemantic: semantic,
        actualSemantic: semantic,
        prepared: await provider.prepareAdd({
          active: fixture.active,
          joinRequest: join.publicResult,
        }),
      });
    },
  };
}

export const v2ProviderMatrix: readonly V2ProviderMatrixRow[] = Object.freeze([
  {
    id: "dummy",
    create({ seed, domainId }) {
      const { crypto, vault } = fixtureCrypto(seed);
      const provider = new DummyV2GroupProvider(crypto, vault);
      const exporterSecret = crypto.randomBytes(32);
      return Promise.resolve({
        crypto,
        provider,
        active: provider.bootstrapSemanticForTesting({
          domainId: cryptoDomainId(domainId),
          epoch: domainEpoch(0),
          exporterSecret,
          roster: [{
            humanId: humanId("alice"),
            deviceId: vault.deviceId,
          }],
        }),
      });
    },
    exerciseSemanticTransition({ fixture, semantic, seed }) {
      return exerciseDummyTransition({ fixture, semantic, seed });
    },
    async prepareSemanticTransition({ fixture, semantic, seed }) {
      if (semantic !== "human-add" && semantic !== "device-add") {
        throw new Error(
          "Prepared dummy scenario transition supports add semantics only",
        );
      }
      const provider = fixture.provider as DummyV2GroupProvider;
      return Object.freeze({
        requestedSemantic: semantic,
        actualSemantic: semantic,
        prepared: await provider.prepareAdd({
          active: fixture.active,
          humanId: semantic === "human-add"
            ? humanId("charlie")
            : humanId("alice"),
          deviceId: cryptoDeviceId(`scenario-prepared-member-${seed}`),
        }),
      });
    },
  },
  realProviderRow(
    "ts-mls",
    (crypto, vault) => new TsMlsV2GroupProvider(crypto, vault),
  ),
  realProviderRow(
    "openmls",
    (crypto, vault) => new OpenMlsV2GroupProvider(crypto, vault),
  ),
]);
