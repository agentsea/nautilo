import type { LatticeCrypto } from "../crypto/index.ts";
import {
  type SealedProviderStateV2,
  DeviceProviderStateVaultV2,
  V2_PROVIDER_STATE_MAX_BYTES,
} from "../device/v2-state-vault.ts";
import { exportDomainRoot } from "../domain/roots.ts";
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "../format/v2-primitives.ts";
import {
  type LocalProviderCandidateV2,
  type PreparedProviderCommitV2,
  type ProviderAbortResultV2,
  type ProviderApplyResultV2,
  type ProviderPublicHeadV2,
  type ProviderPublicTransitionV2,
  type ProviderTransitionOperationV2,
  V2_PROVIDER_CANDIDATE_SOURCE_ID,
  V2_PROVIDER_TRANSITION_FORMAT_VERSION,
  candidatePayloadSnapshotV2,
  cloneProviderHeadV2,
  cloneProviderPublicTransitionV2,
  destroyOpenedProviderCandidateStateV2,
  markLocalProviderCandidateV2,
  openLocalProviderCandidateV2,
  providerHeadsEqualV2,
  providerPublicTransitionDigestMatchesV2,
  sealLocalProviderCandidateV2,
} from "../transition/provider-candidate.ts";
import {
  type CryptoDeviceId,
  type CryptoDomainId,
  type HumanId,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import type {
  DomainRootsV2,
  V2GroupKeyProvider,
} from "./v2-provider.ts";
import { V2ProviderStateError } from "./v2-provider.ts";

const PROVIDER_ID = "openmls-v2";
const STATE_FORMAT_VERSION = 2;
const STATE_DOMAIN =
  "nautilo/lattice-crypto/openmls-device-state/v2";
const JOIN_DOMAIN =
  "nautilo/lattice-crypto/openmls-join-state/v2";
const CREDENTIAL_DOMAIN =
  "nautilo/lattice-crypto/openmls-credential/v2";
const CREDENTIAL_PREFIX = "v2_";
const ROSTER_DOMAIN =
  "nautilo/lattice-crypto/openmls-roster/v2";
const WELCOME_DOMAIN =
  "nautilo/lattice-crypto/openmls-welcome/v2";
const INITIAL_HEAD_DOMAIN =
  "nautilo/lattice-crypto/openmls-initial-head/v2";
const NEXT_HEAD_DOMAIN =
  "nautilo/lattice-crypto/openmls-next-head/v2";
const JOIN_ID_DOMAIN =
  "nautilo/lattice-crypto/openmls-join-id/v2";
const HASH_BYTES = 32;
const MAX_CREDENTIAL_STRING_BYTES =
  CREDENTIAL_PREFIX.length
  + 2 * (
    CREDENTIAL_DOMAIN.length
    + 3 * 4
    + 2 * V2_LIMITS.idBytes
  );

/**
 * Electron copies the vendored module beside its main-process bundle, so its
 * build replaces this identifier with that bundle-relative path. Other
 * runtimes keep resolving from the lattice-crypto source tree.
 */
declare const __NAUTILO_OPENMLS_WASM_GLUE__: string | undefined;
declare const __NAUTILO_OPENMLS_WASM_BYTES__: Uint8Array | undefined;
const VENDOR_GLUE: string =
  typeof __NAUTILO_OPENMLS_WASM_GLUE__ === "string"
    ? __NAUTILO_OPENMLS_WASM_GLUE__
    : "../../vendor/openmls-wasm/openmls_wasm.js";
const VENDOR_WASM_BYTES: Uint8Array | undefined =
  typeof __NAUTILO_OPENMLS_WASM_BYTES__ === "undefined"
    ? undefined
    : __NAUTILO_OPENMLS_WASM_BYTES__;

interface WasmProvider {
  serialize_device_state(): Uint8Array;
  free(): void;
}

interface WasmIdentity {
  key_package(provider: WasmProvider): WasmKeyPackage;
  free(): void;
}

interface WasmKeyPackage {
  to_bytes(): Uint8Array;
  free(): void;
}

interface WasmRatchetTree {
  to_bytes(): Uint8Array;
  free(): void;
}

interface WasmCommitMessages {
  readonly commit: Uint8Array;
  free(): void;
}

interface WasmAddMessages extends WasmCommitMessages {
  readonly welcome: Uint8Array;
}

interface WasmGroup {
  export_ratchet_tree(): WasmRatchetTree;
  member_roster(): Uint8Array;
  propose_and_commit_update(
    provider: WasmProvider,
    sender: WasmIdentity,
  ): WasmCommitMessages;
  propose_and_commit_add(
    provider: WasmProvider,
    sender: WasmIdentity,
    newMember: WasmKeyPackage,
  ): WasmAddMessages;
  propose_and_commit_remove(
    provider: WasmProvider,
    sender: WasmIdentity,
    removedIndex: number,
  ): WasmCommitMessages;
  merge_pending_commit(provider: WasmProvider): void;
  process_message(
    provider: WasmProvider,
    message: Uint8Array,
  ): Uint8Array;
  export_key(
    provider: WasmProvider,
    label: string,
    context: Uint8Array,
    keyLength: number,
  ): Uint8Array;
  free(): void;
}

interface OpenMlsModule {
  default?: (input?: unknown) => Promise<unknown>;
  Provider: (new () => WasmProvider) & {
    deserialize_device_state(bytes: Uint8Array): WasmProvider;
  };
  Identity: (new (
    provider: WasmProvider,
    name: string,
  ) => WasmIdentity) & {
    load(provider: WasmProvider, group: WasmGroup): WasmIdentity;
  };
  KeyPackage: {
    from_bytes(bytes: Uint8Array): WasmKeyPackage;
  };
  RatchetTree: {
    from_bytes(bytes: Uint8Array): WasmRatchetTree;
  };
  Group: {
    create_new(
      provider: WasmProvider,
      founder: WasmIdentity,
      groupId: string,
    ): WasmGroup;
    join(
      provider: WasmProvider,
      welcome: Uint8Array,
      ratchetTree: WasmRatchetTree,
    ): WasmGroup;
    load_device_state(
      provider: WasmProvider,
      groupId: string,
    ): WasmGroup;
  };
}

export interface OpenMlsV2AuthenticatedRosterEntry {
  readonly leafIndex: number;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly credentialName: string;
}

type RosterEntry = OpenMlsV2AuthenticatedRosterEntry;

export interface OpenMlsV2IdentityCodec {
  readonly maxCredentialStringBytes: number;
  readonly maxRosterBytes: number;
  credentialName(input: Readonly<{
    readonly humanId: HumanId;
    readonly deviceId: CryptoDeviceId;
  }>): string;
  parseCredentialName(value: string): Readonly<{
    readonly humanId: HumanId;
    readonly deviceId: CryptoDeviceId;
  }>;
  encodeRoster(roster: readonly OpenMlsV2AuthenticatedRosterEntry[]): Uint8Array;
}

interface OpenedState {
  readonly provider: WasmProvider;
  readonly group: WasmGroup;
  readonly humanId: HumanId;
  readonly removed: boolean;
  readonly head: ProviderPublicHeadV2;
}

interface JoinMaterial {
  readonly joinId: string;
  readonly lifecycle: "prepared" | "applied" | "aborted";
  readonly domainId: CryptoDomainId;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly keyPackageBytes: Uint8Array;
  readonly providerState: Uint8Array;
}

interface WelcomeMaterial {
  readonly welcomeBytes: Uint8Array;
  readonly ratchetTreeBytes: Uint8Array;
}

export interface OpenMlsV2JoinRequestPublic {
  readonly formatVersion: 2;
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly credentialName?: string;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly keyPackageBytes: Uint8Array;
}

export interface OpenMlsV2JoinRequest {
  readonly publicResult: OpenMlsV2JoinRequestPublic;
  readonly localState: SealedProviderStateV2;
}

let modulePromise: Promise<OpenMlsModule> | null = null;
let loadedModule: OpenMlsModule | null = null;

function loadOpenMls(): Promise<OpenMlsModule> {
  modulePromise ??= (async () => {
    const module = (await import(VENDOR_GLUE)) as OpenMlsModule;
    if (typeof module.default === "function") {
      await module.default(VENDOR_WASM_BYTES);
    }
    loadedModule = module;
    return module;
  })();
  return modulePromise;
}

function exactBytes(
  label: string,
  value: Uint8Array,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new V2ProviderStateError(
      `${label} must contain exactly ${length} bytes`,
    );
  }
  return copyOwnedBytesV2(value);
}

function snapshotSealedProviderState(
  snapshot: SealedProviderStateV2,
): SealedProviderStateV2 {
  return Object.freeze({
    classification: snapshot.classification,
    formatVersion: snapshot.formatVersion,
    providerId: snapshot.providerId,
    domainId: snapshot.domainId,
    deviceId: snapshot.deviceId,
    revision: snapshot.revision,
    snapshotKind: snapshot.snapshotKind,
    ciphertext: copyOwnedBytesV2(snapshot.ciphertext),
  }) as SealedProviderStateV2;
}

function snapshotJoinRequest(
  request: OpenMlsV2JoinRequestPublic,
): OpenMlsV2JoinRequestPublic {
  return Object.freeze({
    formatVersion: request.formatVersion,
    providerId: request.providerId,
    domainId: request.domainId,
    humanId: request.humanId,
    deviceId: request.deviceId,
    ...(request.credentialName === undefined
      ? {}
      : { credentialName: request.credentialName }),
    expectedHead: cloneProviderHeadV2(request.expectedHead),
    keyPackageBytes: copyOwnedBytesV2(request.keyPackageBytes),
  });
}

function snapshotLocalCandidate(
  candidate: LocalProviderCandidateV2,
): LocalProviderCandidateV2 {
  return Object.freeze({
    candidateId: candidate.candidateId,
    providerId: candidate.providerId,
    domainId: candidate.domainId,
    deviceId: candidate.deviceId,
    expectedHead: cloneProviderHeadV2(candidate.expectedHead),
    nextHead: cloneProviderHeadV2(candidate.nextHead),
    publicTransitionDigest: copyOwnedBytesV2(
      candidate.publicTransitionDigest,
    ),
    snapshot: snapshotSealedProviderState(candidate.snapshot),
  });
}

function takeOwnedWasmBytes(value: Uint8Array): Uint8Array {
  try {
    return copyOwnedBytesV2(value);
  } finally {
    value.fill(0);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
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
  if (
    value.length % 2 !== 0
    || !/^[0-9a-f]*$/.test(value)
  ) {
    throw new CanonicalDecodingError(
      "OpenMLS credential is not canonical lowercase hex",
    );
  }
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index++) {
    output[index] = Number.parseInt(
      value.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return output;
}

function credentialName(
  ownerHumanId: HumanId,
  deviceId: CryptoDeviceId,
): string {
  return `${CREDENTIAL_PREFIX}${hex(concatV2(
    frameText(CREDENTIAL_DOMAIN),
    frameText(ownerHumanId),
    frameText(deviceId),
  ))}`;
}

function parseCredentialName(
  value: string,
): Readonly<{ humanId: HumanId; deviceId: CryptoDeviceId }> {
  if (
    value.length > MAX_CREDENTIAL_STRING_BYTES
    || !value.startsWith(CREDENTIAL_PREFIX)
  ) {
    throw new V2ProviderStateError(
      "Authenticated OpenMLS credential is unsupported",
    );
  }
  const parsed = decodeExact(
    fromLowerHex(value.slice(CREDENTIAL_PREFIX.length)),
    (reader) => {
      if (reader.readText(CREDENTIAL_DOMAIN.length) !== CREDENTIAL_DOMAIN) {
        throw new CanonicalDecodingError(
          "OpenMLS credential domain is unsupported",
        );
      }
      return Object.freeze({
        humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
        deviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      });
    },
  );
  if (credentialName(parsed.humanId, parsed.deviceId) !== value) {
    throw new V2ProviderStateError(
      "Authenticated OpenMLS credential is noncanonical",
    );
  }
  return parsed;
}

function readStateDomain(
  reader: StrictDecoder,
  expected: string,
  label: string,
): void {
  if (reader.readText(expected.length) !== expected) {
    throw new CanonicalDecodingError(`${label} is unsupported`);
  }
}

function encodeProviderHead(head: ProviderPublicHeadV2): Uint8Array {
  return concatV2(
    frameText(head.providerId),
    frameText(head.domainId),
    encodeU64(head.epoch),
    frame(exactBytes("OpenMLS public state hash", head.stateHash, HASH_BYTES)),
  );
}

function decodeProviderHead(reader: StrictDecoder): ProviderPublicHeadV2 {
  return cloneProviderHeadV2({
    providerId: reader.readText(V2_LIMITS.idBytes),
    domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
    epoch: domainEpoch(reader.readU64()),
    stateHash: exactBytes(
      "OpenMLS public state hash",
      reader.readFrame(HASH_BYTES),
      HASH_BYTES,
    ),
  });
}

function joinLifecycleCode(lifecycle: JoinMaterial["lifecycle"]): number {
  switch (lifecycle) {
    case "prepared":
      return 0;
    case "applied":
      return 1;
    case "aborted":
      return 2;
  }
}

function joinLifecycleFromCode(code: number): JoinMaterial["lifecycle"] {
  switch (code) {
    case 0:
      return "prepared";
    case 1:
      return "applied";
    case 2:
      return "aborted";
    default:
      throw new V2ProviderStateError("Local OpenMLS join lifecycle is invalid");
  }
}

/**
 * Real OpenMLS v2 provider. Every instance represents exactly one device and
 * owns no fleet-wide mutable state; all exporter-capable state is opened from
 * or sealed into that device's local vault.
 */
export class OpenMlsV2GroupProvider implements V2GroupKeyProvider {
  readonly id = PROVIDER_ID;
  private readonly ready: Promise<void>;
  private module!: OpenMlsModule;

  constructor(
    private readonly crypto: LatticeCrypto,
    private readonly vault: DeviceProviderStateVaultV2,
    private readonly identityCodec?: OpenMlsV2IdentityCodec,
  ) {
    if (loadedModule) {
      this.module = loadedModule;
      this.ready = Promise.resolve();
    } else {
      this.ready = loadOpenMls().then((module) => {
        this.module = module;
      });
    }
  }

  /**
   * Complete lazy WASM initialization before calling one of the provider
   * interface's synchronous restore/apply methods in a fresh process.
   */
  initialize(): Promise<void> {
    return this.ready;
  }

  async createInitialState(input: {
    readonly domainId: CryptoDomainId;
    readonly humanId: HumanId;
  }): Promise<SealedProviderStateV2> {
    const domainId = cryptoDomainId(input.domainId);
    const ownerHumanId = humanId(input.humanId);
    await this.ready;
    const provider = new this.module.Provider();
    let identity: WasmIdentity | null = null;
    let group: WasmGroup | null = null;
    try {
      identity = new this.module.Identity(
        provider,
        this.ownCredentialName(ownerHumanId),
      );
      group = this.module.Group.create_new(
        provider,
        identity,
        domainId,
      );
      const roster = this.roster(group);
      if (
        roster.length !== 1
        || roster[0]?.deviceId !== this.vault.deviceId
        || roster[0]?.humanId !== ownerHumanId
      ) {
        throw new V2ProviderStateError(
          "Initial OpenMLS roster does not match the founding device",
        );
      }
      const rosterBytes = this.encodeRoster(roster);
      const treeBytes = this.ratchetTreeBytes(group);
      const head = this.initialHead(domainId, rosterBytes, treeBytes);
      return this.sealState(
        "active",
        provider,
        ownerHumanId,
        false,
        head,
      );
    } finally {
      group?.free();
      identity?.free();
      provider.free();
    }
  }

  async createJoinRequest(input: {
    readonly domainId: CryptoDomainId;
    readonly humanId: HumanId;
    readonly expectedHead: ProviderPublicHeadV2;
  }): Promise<OpenMlsV2JoinRequest> {
    const domainId = cryptoDomainId(input.domainId);
    const joiningHumanId = humanId(input.humanId);
    const expectedHead = cloneProviderHeadV2(input.expectedHead);
    await this.ready;
    if (
      expectedHead.providerId !== this.id
      || expectedHead.domainId !== domainId
    ) {
      throw new V2ProviderStateError(
        "Join request requires the exact trusted OpenMLS public head",
      );
    }
    const provider = new this.module.Provider();
    let identity: WasmIdentity | null = null;
    let keyPackage: WasmKeyPackage | null = null;
    let providerState: Uint8Array | null = null;
    try {
      identity = new this.module.Identity(
        provider,
        this.ownCredentialName(joiningHumanId),
      );
      keyPackage = identity.key_package(provider);
      const keyPackageBytes = takeOwnedWasmBytes(keyPackage.to_bytes());
      if (
        keyPackageBytes.length < 1
        || keyPackageBytes.length > V2_PROVIDER_STATE_MAX_BYTES
      ) {
        throw new V2ProviderStateError(
          "OpenMLS key package exceeds the v2 provider-state limit",
        );
      }
      providerState = takeOwnedWasmBytes(
        provider.serialize_device_state(),
      );
      const joinId = `join_${hex(this.crypto.hash(concatV2(
        frameText(JOIN_ID_DOMAIN),
        frameText(this.vault.deviceId),
        encodeProviderHead(expectedHead),
        frame(keyPackageBytes),
      )).subarray(0, 16))}`;
      const localState = this.sealJoinMaterial({
        joinId,
        lifecycle: "prepared",
        domainId,
        humanId: joiningHumanId,
        deviceId: this.vault.deviceId,
        expectedHead,
        keyPackageBytes,
        providerState,
      });
      return Object.freeze({
        publicResult: Object.freeze({
          formatVersion: V2_PROVIDER_TRANSITION_FORMAT_VERSION,
          providerId: this.id,
          domainId,
          humanId: joiningHumanId,
          deviceId: this.vault.deviceId,
          ...(this.identityCodec === undefined
            ? {}
            : { credentialName: this.ownCredentialName(joiningHumanId) }),
          expectedHead: cloneProviderHeadV2(expectedHead),
          keyPackageBytes: copyOwnedBytesV2(keyPackageBytes),
        }),
        localState,
      });
    } finally {
      providerState?.fill(0);
      keyPackage?.free();
      identity?.free();
      provider.free();
    }
  }

  async prepareAdd(input: {
    readonly active: SealedProviderStateV2;
    readonly joinRequest: OpenMlsV2JoinRequestPublic;
  }): Promise<PreparedProviderCommitV2> {
    this.assertJoinRequest(input.joinRequest);
    const active = snapshotSealedProviderState(input.active);
    const joinRequest = snapshotJoinRequest(input.joinRequest);
    await this.ready;
    const opened = this.openState(active, "active");
    let identity: WasmIdentity | null = null;
    let keyPackage: WasmKeyPackage | null = null;
    let add: WasmAddMessages | null = null;
    try {
      this.assertActive(opened);
      if (
        opened.head.domainId !== joinRequest.domainId
        || !providerHeadsEqualV2(
          opened.head,
          joinRequest.expectedHead,
        )
      ) {
        throw new V2ProviderStateError(
          "Join request does not match the active Domain head",
        );
      }
      const currentRoster = this.roster(opened.group);
      if (
        currentRoster.some(
          (entry) => entry.deviceId === joinRequest.deviceId,
        )
      ) {
        throw new V2ProviderStateError(
          "Join request device already exists in the authenticated OpenMLS roster",
        );
      }
      if (
        this.identityCodec === undefined
        && currentRoster.length >= V2_LIMITS.deviceLeavesPerDomain
      ) {
        throw new V2ProviderStateError(
          "Join request would exceed the 256-device Domain limit",
        );
      }
      const currentHumans = new Set(
        currentRoster.map((entry) => entry.humanId),
      );
      if (
        this.identityCodec === undefined
        &&
        !currentHumans.has(joinRequest.humanId)
        && currentHumans.size >= V2_LIMITS.humanParticipantsPerDomain
      ) {
        throw new V2ProviderStateError(
          "Join request would exceed the 64-Human Domain limit",
        );
      }

      identity = this.module.Identity.load(opened.provider, opened.group);
      keyPackage = this.module.KeyPackage.from_bytes(
        joinRequest.keyPackageBytes,
      );
      add = opened.group.propose_and_commit_add(
        opened.provider,
        identity,
        keyPackage,
      );
      const commitBytes = copyOwnedBytesV2(add.commit);
      const rawWelcome = copyOwnedBytesV2(add.welcome);
      opened.group.merge_pending_commit(opened.provider);
      const nextRoster = this.roster(opened.group);
      this.assertAddRoster(
        currentRoster,
        nextRoster,
        joinRequest,
      );
      const rosterBytes = this.encodeRoster(nextRoster);
      const treeBytes = this.ratchetTreeBytes(opened.group);
      const welcomeBytes = this.encodeWelcome(rawWelcome, treeBytes);
      const welcomeHash = this.crypto.hash(welcomeBytes);
      const nextHead = this.nextHead(
        opened.head,
        commitBytes,
        welcomeHash,
        rosterBytes,
        treeBytes,
      );
      return this.preparedResult(
        opened,
        nextHead,
        commitBytes,
        welcomeBytes,
        rosterBytes,
        false,
        {
          operation: "add",
          targetHumanId: joinRequest.humanId,
          targetDeviceId: joinRequest.deviceId,
        },
      );
    } finally {
      add?.free();
      keyPackage?.free();
      identity?.free();
      this.closeState(opened);
    }
  }

  async prepareRemove(input: {
    readonly active: SealedProviderStateV2;
    readonly removedDeviceId: CryptoDeviceId;
  }): Promise<PreparedProviderCommitV2> {
    const active = snapshotSealedProviderState(input.active);
    const removedDeviceId = cryptoDeviceId(input.removedDeviceId);
    await this.ready;
    const opened = this.openState(active, "active");
    let identity: WasmIdentity | null = null;
    let removal: WasmCommitMessages | null = null;
    try {
      this.assertActive(opened);
      const currentRoster = this.roster(opened.group);
      const target = currentRoster.find(
        (entry) => entry.deviceId === removedDeviceId,
      );
      if (!target) {
        throw new V2ProviderStateError(
          "Removed device is not in the authenticated OpenMLS roster",
        );
      }
      if (currentRoster.length === 1) {
        throw new V2ProviderStateError(
          "Final OpenMLS device removal requires explicit Domain rebootstrap",
        );
      }
      identity = this.module.Identity.load(opened.provider, opened.group);
      removal = opened.group.propose_and_commit_remove(
        opened.provider,
        identity,
        target.leafIndex,
      );
      const commitBytes = copyOwnedBytesV2(removal.commit);
      opened.group.merge_pending_commit(opened.provider);
      const nextRoster = this.roster(opened.group);
      this.assertRemoveRoster(
        currentRoster,
        nextRoster,
        removedDeviceId,
      );
      const rosterBytes = this.encodeRoster(nextRoster);
      const treeBytes = this.ratchetTreeBytes(opened.group);
      const nextHead = this.nextHead(
        opened.head,
        commitBytes,
        this.crypto.hash(new Uint8Array()),
        rosterBytes,
        treeBytes,
      );
      return this.preparedResult(
        opened,
        nextHead,
        commitBytes,
        new Uint8Array(),
        rosterBytes,
        removedDeviceId === this.vault.deviceId,
        {
          operation: "remove",
          targetHumanId: target.humanId,
          targetDeviceId: target.deviceId,
        },
      );
    } finally {
      removal?.free();
      identity?.free();
      this.closeState(opened);
    }
  }

  async prepareCommit(input: {
    readonly active: SealedProviderStateV2;
  }): Promise<PreparedProviderCommitV2> {
    const active = snapshotSealedProviderState(input.active);
    await this.ready;
    const opened = this.openState(active, "active");
    let identity: WasmIdentity | null = null;
    let update: WasmCommitMessages | null = null;
    try {
      this.assertActive(opened);
      identity = this.module.Identity.load(opened.provider, opened.group);
      update = opened.group.propose_and_commit_update(
        opened.provider,
        identity,
      );
      const commitBytes = copyOwnedBytesV2(update.commit);
      opened.group.merge_pending_commit(opened.provider);
      const rosterBytes = this.encodeRoster(this.roster(opened.group));
      const treeBytes = this.ratchetTreeBytes(opened.group);
      const nextHead = this.nextHead(
        opened.head,
        commitBytes,
        this.crypto.hash(new Uint8Array()),
        rosterBytes,
        treeBytes,
      );
      return this.preparedResult(
        opened,
        nextHead,
        commitBytes,
        new Uint8Array(),
        rosterBytes,
        false,
        {
          operation: "update",
          targetHumanId: opened.humanId,
          targetDeviceId: this.vault.deviceId,
        },
      );
    } finally {
      update?.free();
      identity?.free();
      this.closeState(opened);
    }
  }

  async prepareIncoming(input: {
    readonly active: SealedProviderStateV2;
    readonly publicResult: ProviderPublicTransitionV2;
  }): Promise<LocalProviderCandidateV2> {
    const transition = this.validateTransition(input.publicResult);
    const active = snapshotSealedProviderState(input.active);
    await this.ready;
    const opened = this.openState(active, "active");
    try {
      this.assertActive(opened);
      if (!providerHeadsEqualV2(opened.head, transition.expectedHead)) {
        throw new V2ProviderStateError(
          "Incoming OpenMLS commit does not match the exact expected public head",
        );
      }
      const oldTreeBytes = this.ratchetTreeBytes(opened.group);
      const plaintext = opened.group.process_message(
        opened.provider,
        transition.commitBytes,
      );
      try {
        if (plaintext.length !== 0) {
          throw new V2ProviderStateError(
            "Incoming OpenMLS transition is not a commit",
          );
        }
      } finally {
        plaintext.fill(0);
      }
      const nextRoster = this.roster(opened.group);
      const rosterBytes = this.encodeRoster(nextRoster);
      if (!equalBytes(rosterBytes, transition.rosterBytes)) {
        throw new V2ProviderStateError(
          "Incoming OpenMLS commit roster does not match public transition bytes",
        );
      }
      const treeBytes = this.ratchetTreeBytes(opened.group);
      if (equalBytes(oldTreeBytes, treeBytes)) {
        throw new V2ProviderStateError(
          "Incoming OpenMLS transition did not advance the authenticated tree",
        );
      }
      const nextHead = this.nextHead(
        transition.expectedHead,
        transition.commitBytes,
        transition.welcomeHash,
        rosterBytes,
        treeBytes,
      );
      if (!providerHeadsEqualV2(nextHead, transition.nextHead)) {
        throw new V2ProviderStateError(
          "Incoming OpenMLS commit does not match the exact next public head",
        );
      }
      const removed = !nextRoster.some(
        (entry) => entry.deviceId === this.vault.deviceId,
      );
      return this.localCandidate(
        opened.provider,
        opened.humanId,
        removed,
        nextHead,
        transition.expectedHead,
        transition,
      );
    } finally {
      this.closeState(opened);
    }
  }

  async validatePreparedCandidate(input: {
    readonly active: SealedProviderStateV2;
    readonly prepared: PreparedProviderCommitV2;
  }): Promise<void> {
    const transition = this.validateTransition(input.prepared.publicResult);
    const active = snapshotSealedProviderState(input.active);
    const localCandidate = snapshotLocalCandidate(
      input.prepared.localCandidate,
    );
    await this.ready;
    const activeState = this.openState(active, "active");
    try {
      const openedCandidate = openLocalProviderCandidateV2({
        vault: this.vault,
        candidate: localCandidate,
      });
      let candidateState: OpenedState | null = null;
      try {
        if (
          !providerPublicTransitionDigestMatchesV2(
            this.crypto,
            transition,
            openedCandidate.publicTransitionDigest,
          )
        ) {
          throw new V2ProviderStateError(
            "OpenMLS prepared candidate does not match its public transition",
          );
        }
        if (openedCandidate.lifecycle === "applied") {
          if (
            !providerHeadsEqualV2(
              activeState.head,
              transition.nextHead,
            )
          ) {
            throw new V2ProviderStateError(
              "Applied OpenMLS candidate does not match the active public head",
            );
          }
          return;
        }
        if (
          openedCandidate.lifecycle !== "prepared"
          || !providerHeadsEqualV2(
            activeState.head,
            transition.expectedHead,
          )
        ) {
          throw new V2ProviderStateError(
            "OpenMLS prepared candidate does not match the active public head",
          );
        }
        const nested = candidatePayloadSnapshotV2(
          localCandidate,
          openedCandidate.payload,
        );
        try {
          candidateState = this.openState(nested, "candidate");
        } finally {
          nested.ciphertext.fill(0);
        }
        const rosterBytes = this.encodeRoster(
          this.roster(candidateState.group),
        );
        const treeBytes = this.ratchetTreeBytes(candidateState.group);
        const expectedNextHead = this.nextHead(
          transition.expectedHead,
          transition.commitBytes,
          transition.welcomeHash,
          rosterBytes,
          treeBytes,
        );
        if (
          !equalBytes(rosterBytes, transition.rosterBytes)
          || !providerHeadsEqualV2(
            candidateState.head,
            transition.nextHead,
          )
          || !providerHeadsEqualV2(
            expectedNextHead,
            transition.nextHead,
          )
        ) {
          throw new V2ProviderStateError(
            "OpenMLS public transition does not match its sealed candidate",
          );
        }
      } finally {
        if (candidateState) this.closeState(candidateState);
        destroyOpenedProviderCandidateStateV2(openedCandidate);
      }
    } finally {
      this.closeState(activeState);
    }
  }

  async prepareWelcome(input: {
    readonly joinState: SealedProviderStateV2;
    readonly publicResult: ProviderPublicTransitionV2;
  }): Promise<LocalProviderCandidateV2> {
    const joinState = snapshotSealedProviderState(input.joinState);
    const transition = this.validateTransition(input.publicResult);
    await this.ready;
    const join = this.openJoinMaterial(joinState);
    let provider: WasmProvider | null = null;
    let tree: WasmRatchetTree | null = null;
    let group: WasmGroup | null = null;
    try {
      if (
        join.lifecycle !== "prepared"
        || transition.domainId !== join.domainId
        || !providerHeadsEqualV2(
          transition.expectedHead,
          join.expectedHead,
        )
        || Number(transition.nextHead.epoch)
          !== Number(join.expectedHead.epoch) + 1
      ) {
        throw new V2ProviderStateError(
          "OpenMLS Welcome does not match the local join request",
        );
      }
      if (
        transition.welcomeBytes.length < 1
        || !equalBytes(
          this.crypto.hash(transition.welcomeBytes),
          transition.welcomeHash,
        )
      ) {
        throw new V2ProviderStateError(
          "OpenMLS Welcome does not match its public commitment",
        );
      }
      const welcome = this.decodeWelcome(transition.welcomeBytes);
      provider = this.module.Provider.deserialize_device_state(
        join.providerState,
      );
      tree = this.module.RatchetTree.from_bytes(
        welcome.ratchetTreeBytes,
      );
      group = this.module.Group.join(
        provider,
        welcome.welcomeBytes,
        tree,
      );
      const roster = this.roster(group);
      const ownEntry = roster.find(
        (entry) => entry.deviceId === this.vault.deviceId,
      );
      if (!ownEntry || ownEntry.humanId !== join.humanId) {
        throw new V2ProviderStateError(
          "OpenMLS Welcome does not contain the requested authenticated identity",
        );
      }
      const rosterBytes = this.encodeRoster(roster);
      if (!equalBytes(rosterBytes, transition.rosterBytes)) {
        throw new V2ProviderStateError(
          "OpenMLS Welcome roster does not match public transition bytes",
        );
      }
      const actualTreeBytes = this.ratchetTreeBytes(group);
      if (!equalBytes(actualTreeBytes, welcome.ratchetTreeBytes)) {
        throw new V2ProviderStateError(
          "OpenMLS Welcome ratchet tree is noncanonical",
        );
      }
      const nextHead = this.nextHead(
        transition.expectedHead,
        transition.commitBytes,
        transition.welcomeHash,
        rosterBytes,
        actualTreeBytes,
      );
      if (!providerHeadsEqualV2(nextHead, transition.nextHead)) {
        throw new V2ProviderStateError(
          "OpenMLS Welcome does not match the exact next public head",
        );
      }
      const candidate = this.localCandidate(
        provider,
        join.humanId,
        false,
        nextHead,
        transition.expectedHead,
        transition,
        join.joinId,
      );
      return candidate;
    } finally {
      group?.free();
      tree?.free();
      provider?.free();
      join.providerState.fill(0);
      join.keyPackageBytes.fill(0);
    }
  }

  activateWelcome(input: {
    readonly candidate: LocalProviderCandidateV2;
    readonly joinState: SealedProviderStateV2;
  }): ProviderApplyResultV2 {
    const join = this.openJoinMaterial(input.joinState);
    const protectedCandidate = openLocalProviderCandidateV2({
      vault: this.vault,
      candidate: input.candidate,
    });
    let candidateState: OpenedState | null = null;
    try {
      this.assertWelcomeCandidate(join, protectedCandidate.sourceId);
      if (join.lifecycle === "aborted") {
        throw new V2ProviderStateError("OpenMLS Welcome join state was aborted");
      }
      if (protectedCandidate.lifecycle === "aborted") {
        throw new V2ProviderStateError("OpenMLS Welcome candidate was aborted");
      }
      if (protectedCandidate.lifecycle === "applied") {
        throw new V2ProviderStateError("OpenMLS Welcome was already activated");
      }
      const nested = candidatePayloadSnapshotV2(
        input.candidate,
        protectedCandidate.payload,
      );
      candidateState = this.openState(nested, "candidate");
      nested.ciphertext.fill(0);
      if (
        candidateState.removed
        || !providerHeadsEqualV2(
          candidateState.head,
          input.candidate.nextHead,
        )
      ) {
        throw new V2ProviderStateError(
          "OpenMLS Welcome candidate does not match its next public head",
        );
      }
      const active = this.sealState(
        "active",
        candidateState.provider,
        candidateState.humanId,
        false,
        candidateState.head,
      );
      if (join.lifecycle === "prepared") {
        this.markJoinState(input.joinState, join, "applied");
      }
      markLocalProviderCandidateV2({
        vault: this.vault,
        candidate: input.candidate,
        lifecycle: "applied",
      });
      return Object.freeze({ status: "applied" as const, active });
    } finally {
      if (candidateState) this.closeState(candidateState);
      destroyOpenedProviderCandidateStateV2(protectedCandidate);
      this.destroyJoinSecrets(join);
    }
  }

  abortWelcome(input: {
    readonly candidate: LocalProviderCandidateV2;
    readonly joinState: SealedProviderStateV2;
  }): ProviderAbortResultV2 {
    const join = this.openJoinMaterial(input.joinState);
    const protectedCandidate = openLocalProviderCandidateV2({
      vault: this.vault,
      candidate: input.candidate,
    });
    try {
      this.assertWelcomeCandidate(join, protectedCandidate.sourceId);
      if (protectedCandidate.lifecycle === "applied") {
        if (join.lifecycle === "prepared") {
          this.markJoinState(input.joinState, join, "applied");
        }
        return Object.freeze({ status: "already-applied" as const });
      }
      if (join.lifecycle === "applied") {
        markLocalProviderCandidateV2({
          vault: this.vault,
          candidate: input.candidate,
          lifecycle: "applied",
        });
        return Object.freeze({ status: "already-applied" as const });
      }
      if (
        join.lifecycle === "aborted"
        || protectedCandidate.lifecycle === "aborted"
        || protectedCandidate.lifecycle === "stale"
      ) {
        if (join.lifecycle === "prepared") {
          this.markJoinState(input.joinState, join, "aborted");
        }
        if (protectedCandidate.lifecycle === "prepared") {
          markLocalProviderCandidateV2({
            vault: this.vault,
            candidate: input.candidate,
            lifecycle: "aborted",
          });
        }
        return Object.freeze({ status: "already-aborted" as const });
      }
      this.markJoinState(input.joinState, join, "aborted");
      markLocalProviderCandidateV2({
        vault: this.vault,
        candidate: input.candidate,
        lifecycle: "aborted",
      });
      return Object.freeze({ status: "aborted" as const });
    } finally {
      destroyOpenedProviderCandidateStateV2(protectedCandidate);
      this.destroyJoinSecrets(join);
    }
  }

  publicHead(active: SealedProviderStateV2): ProviderPublicHeadV2 {
    const opened = this.openState(active, "active");
    try {
      return cloneProviderHeadV2(opened.head);
    } finally {
      this.closeState(opened);
    }
  }

  publicRoster(active: SealedProviderStateV2): Uint8Array {
    const opened = this.openState(active, "active");
    try {
      return this.encodeRoster(this.roster(opened.group));
    } finally {
      this.closeState(opened);
    }
  }

  publicAuthenticatedRoster(
    active: SealedProviderStateV2,
  ): readonly OpenMlsV2AuthenticatedRosterEntry[] {
    const opened = this.openState(active, "active");
    try {
      return Object.freeze(this.roster(opened.group).map((entry) =>
        Object.freeze({
          leafIndex: entry.leafIndex,
          humanId: entry.humanId,
          deviceId: entry.deviceId,
          credentialName: entry.credentialName,
        })
      ));
    } finally {
      this.closeState(opened);
    }
  }

  async exportDomainRoots(
    active: SealedProviderStateV2,
  ): Promise<DomainRootsV2> {
    const activeSnapshot = snapshotSealedProviderState(active);
    await this.ready;
    const opened = this.openState(activeSnapshot, "active");
    try {
      if (opened.removed) {
        throw new V2ProviderStateError(
          "Removed OpenMLS device cannot export current Domain roots",
        );
      }
      const exporter = (
        label: string,
        context: Uint8Array,
        length: number,
      ): Promise<Uint8Array> => Promise.resolve(
        opened.group.export_key(
          opened.provider,
          label,
          context,
          length,
        ),
      );
      let human: Uint8Array | null = null;
      try {
        human = await exportDomainRoot(
          "human",
          opened.head.domainId,
          opened.head.epoch,
          exporter,
        );
        const ai = await exportDomainRoot(
          "ai",
          opened.head.domainId,
          opened.head.epoch,
          exporter,
        );
        return Object.freeze({ human, ai });
      } catch (error) {
        human?.fill(0);
        throw error;
      }
    } finally {
      this.closeState(opened);
    }
  }

  applyCandidate(input: {
    readonly active: SealedProviderStateV2;
    readonly candidate: LocalProviderCandidateV2;
  }): ProviderApplyResultV2 {
    const { candidate } = input;
    const protectedCandidate = openLocalProviderCandidateV2({
      vault: this.vault,
      candidate,
    });
    if (
      protectedCandidate.sourceId !== V2_PROVIDER_CANDIDATE_SOURCE_ID
    ) {
      destroyOpenedProviderCandidateStateV2(protectedCandidate);
      throw new V2ProviderStateError(
        "OpenMLS Welcome candidates require the Welcome lifecycle",
      );
    }
    if (
      protectedCandidate.lifecycle === "aborted"
      || protectedCandidate.lifecycle === "stale"
    ) {
      destroyOpenedProviderCandidateStateV2(protectedCandidate);
      return Object.freeze({
        status: "aborted" as const,
        active: input.active,
      });
    }
    const activeState = this.openState(input.active, "active");
    try {
      if (providerHeadsEqualV2(activeState.head, candidate.nextHead)) {
        if (protectedCandidate.lifecycle === "prepared") {
          markLocalProviderCandidateV2({
            vault: this.vault,
            candidate,
            lifecycle: "applied",
          });
        }
        return Object.freeze({
          status: "duplicate" as const,
          active: input.active,
        });
      }
      if (
        !providerHeadsEqualV2(activeState.head, candidate.expectedHead)
      ) {
        if (protectedCandidate.lifecycle === "prepared") {
          markLocalProviderCandidateV2({
            vault: this.vault,
            candidate,
            lifecycle: "stale",
          });
        }
        return Object.freeze({
          status: "stale" as const,
          active: input.active,
        });
      }
      if (protectedCandidate.lifecycle !== "prepared") {
        throw new V2ProviderStateError(
          "Applied OpenMLS candidate cannot be replayed against its old head",
        );
      }
      const nested = candidatePayloadSnapshotV2(
        candidate,
        protectedCandidate.payload,
      );
      const candidateState = this.openState(nested, "candidate");
      nested.ciphertext.fill(0);
      try {
        if (
          !providerHeadsEqualV2(
            candidateState.head,
            candidate.nextHead,
          )
        ) {
          throw new V2ProviderStateError(
            "OpenMLS candidate does not match its exact next public head",
          );
        }
        const active = this.sealState(
          "active",
          candidateState.provider,
          candidateState.humanId,
          candidateState.removed,
          candidateState.head,
        );
        markLocalProviderCandidateV2({
          vault: this.vault,
          candidate,
          lifecycle: "applied",
        });
        return Object.freeze({
          status: "applied" as const,
          active,
        });
      } finally {
        this.closeState(candidateState);
      }
    } finally {
      this.closeState(activeState);
      destroyOpenedProviderCandidateStateV2(protectedCandidate);
    }
  }

  abortCandidate(
    candidate: LocalProviderCandidateV2,
  ): ProviderAbortResultV2 {
    const protectedCandidate = openLocalProviderCandidateV2({
      vault: this.vault,
      candidate,
    });
    try {
      if (
        protectedCandidate.sourceId !== V2_PROVIDER_CANDIDATE_SOURCE_ID
      ) {
        throw new V2ProviderStateError(
          "OpenMLS Welcome candidates require the Welcome lifecycle",
        );
      }
      if (protectedCandidate.lifecycle === "applied") {
        return Object.freeze({ status: "already-applied" as const });
      }
      if (
        protectedCandidate.lifecycle === "aborted"
        || protectedCandidate.lifecycle === "stale"
      ) {
        return Object.freeze({ status: "already-aborted" as const });
      }
      markLocalProviderCandidateV2({
        vault: this.vault,
        candidate,
        lifecycle: "aborted",
      });
      return Object.freeze({ status: "aborted" as const });
    } finally {
      destroyOpenedProviderCandidateStateV2(protectedCandidate);
    }
  }

  private assertActive(opened: OpenedState): void {
    if (opened.removed) {
      throw new V2ProviderStateError(
        "Removed OpenMLS device cannot prepare a transition",
      );
    }
  }

  private preparedResult(
    opened: OpenedState,
    nextHead: ProviderPublicHeadV2,
    commitBytes: Uint8Array,
    welcomeBytes: Uint8Array,
    rosterBytes: Uint8Array,
    removed: boolean,
    authorizationTarget: Readonly<{
      readonly operation: ProviderTransitionOperationV2;
      readonly targetHumanId: HumanId;
      readonly targetDeviceId: CryptoDeviceId;
    }>,
  ): PreparedProviderCommitV2 {
    const publicResult = cloneProviderPublicTransitionV2({
      formatVersion: V2_PROVIDER_TRANSITION_FORMAT_VERSION,
      providerId: this.id,
      domainId: opened.head.domainId,
      ...authorizationTarget,
      expectedHead: opened.head,
      nextHead,
      commitBytes,
      welcomeHash: this.crypto.hash(welcomeBytes),
      welcomeBytes,
      rosterBytes,
    });
    const localCandidate = this.localCandidate(
      opened.provider,
      opened.humanId,
      removed,
      nextHead,
      opened.head,
      publicResult,
    );
    return Object.freeze({ publicResult, localCandidate });
  }

  private localCandidate(
    provider: WasmProvider,
    ownerHumanId: HumanId,
    removed: boolean,
    nextHead: ProviderPublicHeadV2,
    expectedHead: ProviderPublicHeadV2,
    publicTransition: ProviderPublicTransitionV2,
    sourceId?: string,
  ): LocalProviderCandidateV2 {
    const nested = this.sealState(
      "candidate",
      provider,
      ownerHumanId,
      removed,
      nextHead,
    );
    try {
      return sealLocalProviderCandidateV2({
        crypto: this.crypto,
        vault: this.vault,
        providerId: this.id,
        domainId: nextHead.domainId,
        expectedHead,
        nextHead,
        publicTransition,
        payload: nested.ciphertext,
        ...(sourceId === undefined ? {} : { sourceId }),
      });
    } finally {
      nested.ciphertext.fill(0);
    }
  }

  private initialHead(
    domainId: CryptoDomainId,
    rosterBytes: Uint8Array,
    treeBytes: Uint8Array,
  ): ProviderPublicHeadV2 {
    const epoch = domainEpoch(0);
    return cloneProviderHeadV2({
      providerId: this.id,
      domainId,
      epoch,
      stateHash: this.crypto.hash(concatV2(
        frameText(INITIAL_HEAD_DOMAIN),
        frameText(this.id),
        frameText(domainId),
        encodeU64(epoch),
        frame(rosterBytes),
        frame(treeBytes),
      )),
    });
  }

  private nextHead(
    expected: ProviderPublicHeadV2,
    commitBytes: Uint8Array,
    welcomeHash: Uint8Array,
    rosterBytes: Uint8Array,
    treeBytes: Uint8Array,
  ): ProviderPublicHeadV2 {
    const epoch = domainEpoch(Number(expected.epoch) + 1);
    return cloneProviderHeadV2({
      providerId: this.id,
      domainId: expected.domainId,
      epoch,
      stateHash: this.crypto.hash(concatV2(
        frameText(NEXT_HEAD_DOMAIN),
        frame(expected.stateHash),
        frame(commitBytes),
        frame(welcomeHash),
        frame(rosterBytes),
        frame(treeBytes),
        encodeU64(epoch),
      )),
    });
  }

  private sealState(
    snapshotKind: "active" | "candidate",
    provider: WasmProvider,
    ownerHumanId: HumanId,
    removed: boolean,
    head: ProviderPublicHeadV2,
  ): SealedProviderStateV2 {
    const providerState = takeOwnedWasmBytes(
      provider.serialize_device_state(),
    );
    const plaintext = concatV2(
      frameText(STATE_DOMAIN),
      encodeU32(STATE_FORMAT_VERSION),
      frameText(this.id),
      frameText(head.domainId),
      frameText(this.vault.deviceId),
      encodeU64(head.epoch),
      frameText(ownerHumanId),
      encodeU32(removed ? 1 : 0),
      frame(head.stateHash),
      frame(providerState),
    );
    try {
      return this.vault.seal(
        {
          providerId: this.id,
          domainId: head.domainId,
          revision: head.epoch,
          snapshotKind,
        },
        plaintext,
      );
    } finally {
      providerState.fill(0);
      plaintext.fill(0);
    }
  }

  private openState(
    snapshot: SealedProviderStateV2,
    snapshotKind: "active" | "candidate",
  ): OpenedState {
    if (!this.module) {
      throw new V2ProviderStateError(
        "OpenMLS provider must be initialized before synchronous state access",
      );
    }
    if (
      snapshot.providerId !== this.id
      || snapshot.deviceId !== this.vault.deviceId
      || snapshot.snapshotKind !== snapshotKind
    ) {
      throw new V2ProviderStateError(
        `Invalid ${snapshotKind} OpenMLS snapshot coordinates`,
      );
    }
    const plaintext = this.vault.open(snapshot, {
      providerId: this.id,
      domainId: snapshot.domainId,
      revision: snapshot.revision,
      snapshotKind,
    });
    if (!plaintext) {
      throw new V2ProviderStateError(
        `Unable to open ${snapshotKind} OpenMLS snapshot`,
      );
    }
    let provider: WasmProvider | null = null;
    let group: WasmGroup | null = null;
    let providerState: Uint8Array | null = null;
    try {
      const decoded = decodeExact(plaintext, (reader) => {
        readStateDomain(reader, STATE_DOMAIN, "OpenMLS state domain");
        reader.readVersion(STATE_FORMAT_VERSION);
        if (reader.readText(V2_LIMITS.idBytes) !== this.id) {
          throw new V2ProviderStateError(
            "OpenMLS state provider id is invalid",
          );
        }
        const domainId = cryptoDomainId(
          reader.readText(V2_LIMITS.idBytes),
        );
        const deviceId = cryptoDeviceId(
          reader.readText(V2_LIMITS.idBytes),
        );
        const epoch = domainEpoch(reader.readU64());
        const ownerHumanId = humanId(
          reader.readText(V2_LIMITS.idBytes),
        );
        const removedValue = reader.readU32();
        if (removedValue !== 0 && removedValue !== 1) {
          throw new V2ProviderStateError(
            "OpenMLS removed-state flag is invalid",
          );
        }
        return {
          domainId,
          deviceId,
          epoch,
          ownerHumanId,
          removed: removedValue === 1,
          stateHash: exactBytes(
            "OpenMLS public state hash",
            reader.readFrame(HASH_BYTES),
            HASH_BYTES,
          ),
          providerState: reader.readFrame(
            V2_PROVIDER_STATE_MAX_BYTES,
          ),
        };
      });
      providerState = decoded.providerState;
      if (
        decoded.domainId !== snapshot.domainId
        || decoded.deviceId !== this.vault.deviceId
        || decoded.epoch !== snapshot.revision
      ) {
        throw new V2ProviderStateError(
          "OpenMLS state metadata does not match its sealed snapshot",
        );
      }
      provider = this.module.Provider.deserialize_device_state(
        providerState,
      );
      group = this.module.Group.load_device_state(
        provider,
        snapshot.domainId,
      );
      const roster = this.roster(group);
      const ownEntry = roster.find(
        (entry) => entry.deviceId === this.vault.deviceId,
      );
      if (
        decoded.removed
          ? ownEntry !== undefined
          : !ownEntry || ownEntry.humanId !== decoded.ownerHumanId
      ) {
        throw new V2ProviderStateError(
          "OpenMLS state identity does not match its authenticated roster",
        );
      }
      return Object.freeze({
        provider,
        group,
        humanId: decoded.ownerHumanId,
        removed: decoded.removed,
        head: cloneProviderHeadV2({
          providerId: this.id,
          domainId: snapshot.domainId,
          epoch: snapshot.revision,
          stateHash: decoded.stateHash,
        }),
      });
    } catch (error) {
      group?.free();
      provider?.free();
      throw error;
    } finally {
      providerState?.fill(0);
      plaintext.fill(0);
    }
  }

  private closeState(opened: OpenedState): void {
    opened.group.free();
    opened.provider.free();
  }

  private sealJoinMaterial(
    join: JoinMaterial,
  ): SealedProviderStateV2 {
    const plaintext = concatV2(
      frameText(JOIN_DOMAIN),
      encodeU32(STATE_FORMAT_VERSION),
      frameText(this.id),
      frameText(join.domainId),
      frameText(join.deviceId),
      frameText(join.joinId),
      encodeU32(joinLifecycleCode(join.lifecycle)),
      encodeProviderHead(join.expectedHead),
      frameText(join.humanId),
      frame(join.keyPackageBytes),
      frame(join.providerState),
    );
    try {
      return this.vault.seal(
        {
          providerId: this.id,
          domainId: join.domainId,
          revision: domainEpoch(Number(join.expectedHead.epoch) + 1),
          snapshotKind: "candidate",
        },
        plaintext,
      );
    } finally {
      plaintext.fill(0);
    }
  }

  private openJoinMaterial(
    snapshot: SealedProviderStateV2,
  ): JoinMaterial {
    if (
      snapshot.providerId !== this.id
      || snapshot.deviceId !== this.vault.deviceId
      || snapshot.snapshotKind !== "candidate"
    ) {
      throw new V2ProviderStateError(
        "Invalid local OpenMLS join state",
      );
    }
    const plaintext = this.vault.open(snapshot, {
      providerId: this.id,
      domainId: snapshot.domainId,
      revision: snapshot.revision,
      snapshotKind: "candidate",
    });
    if (!plaintext) {
      throw new V2ProviderStateError(
        "Unable to open local OpenMLS join state",
      );
    }
    try {
      return decodeExact(plaintext, (reader) => {
        readStateDomain(
          reader,
          JOIN_DOMAIN,
          "OpenMLS join-state domain",
        );
        reader.readVersion(STATE_FORMAT_VERSION);
        if (reader.readText(V2_LIMITS.idBytes) !== this.id) {
          throw new V2ProviderStateError(
            "OpenMLS join-state provider id is invalid",
          );
        }
        const domainId = cryptoDomainId(
          reader.readText(V2_LIMITS.idBytes),
        );
        const deviceId = cryptoDeviceId(
          reader.readText(V2_LIMITS.idBytes),
        );
        const joinId = reader.readText(V2_LIMITS.idBytes);
        const lifecycle = joinLifecycleFromCode(reader.readU32());
        const expectedHead = decodeProviderHead(reader);
        const ownerHumanId = humanId(
          reader.readText(V2_LIMITS.idBytes),
        );
        if (
          domainId !== snapshot.domainId
          || deviceId !== this.vault.deviceId
          || expectedHead.providerId !== this.id
          || expectedHead.domainId !== domainId
          || Number(expectedHead.epoch) + 1 !== Number(snapshot.revision)
        ) {
          throw new V2ProviderStateError(
            "OpenMLS join-state metadata mismatch",
          );
        }
        return {
          joinId,
          lifecycle,
          domainId,
          humanId: ownerHumanId,
          deviceId,
          expectedHead,
          keyPackageBytes: reader.readFrame(
            V2_PROVIDER_STATE_MAX_BYTES,
          ),
          providerState: reader.readFrame(
            V2_PROVIDER_STATE_MAX_BYTES,
          ),
        };
      });
    } finally {
      plaintext.fill(0);
    }
  }

  private markJoinState(
    snapshot: SealedProviderStateV2,
    join: JoinMaterial,
    lifecycle: Exclude<JoinMaterial["lifecycle"], "prepared">,
  ): void {
    const tombstone = this.sealJoinMaterial({
      ...join,
      lifecycle,
      keyPackageBytes: new Uint8Array(join.keyPackageBytes.length),
      providerState: new Uint8Array(join.providerState.length),
    });
    if (tombstone.ciphertext.length !== snapshot.ciphertext.length) {
      throw new V2ProviderStateError(
        "Local OpenMLS join tombstone length changed unexpectedly",
      );
    }
    snapshot.ciphertext.set(tombstone.ciphertext);
  }

  private assertWelcomeCandidate(
    join: JoinMaterial,
    sourceId: string,
  ): void {
    if (sourceId !== join.joinId) {
      throw new V2ProviderStateError(
        "OpenMLS Welcome candidate does not match its sealed join request",
      );
    }
  }

  private destroyJoinSecrets(join: JoinMaterial): void {
    join.providerState.fill(0);
    join.keyPackageBytes.fill(0);
  }

  private ratchetTreeBytes(group: WasmGroup): Uint8Array {
    const tree = group.export_ratchet_tree();
    try {
      const bytes = copyOwnedBytesV2(tree.to_bytes());
      if (
        bytes.length < 1
        || bytes.length > V2_PROVIDER_STATE_MAX_BYTES
      ) {
        throw new V2ProviderStateError(
          "OpenMLS ratchet tree exceeds the v2 provider-state limit",
        );
      }
      return bytes;
    } finally {
      tree.free();
    }
  }

  private roster(group: WasmGroup): readonly RosterEntry[] {
    const bytes = copyOwnedBytesV2(group.member_roster());
    const maximumRosterBytes = this.identityCodec?.maxRosterBytes
      ?? V2_LIMITS.namespaceKeyringBytes;
    if (bytes.length > maximumRosterBytes) {
      throw new V2ProviderStateError(
        "OpenMLS roster exceeds the v2 byte limit",
      );
    }
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    let offset = 0;
    const readU32Le = (): number => {
      if (offset + 4 > bytes.length) {
        throw new V2ProviderStateError(
          "Authenticated OpenMLS roster is truncated",
        );
      }
      const value = view.getUint32(offset, true);
      offset += 4;
      return value;
    };
    const count = readU32Le();
    if (
      this.identityCodec === undefined
      && count > V2_LIMITS.deviceLeavesPerDomain
    ) {
      throw new V2ProviderStateError(
        "OpenMLS roster exceeds the 256-device Domain limit",
      );
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const roster: RosterEntry[] = [];
    const devices = new Set<CryptoDeviceId>();
    const leaves = new Set<number>();
    for (let index = 0; index < count; index++) {
      const leafIndex = readU32Le();
      const identityLength = readU32Le();
      if (
        identityLength > (
          this.identityCodec?.maxCredentialStringBytes
          ?? MAX_CREDENTIAL_STRING_BYTES
        )
        || offset + identityLength > bytes.length
      ) {
        throw new V2ProviderStateError(
          "Authenticated OpenMLS roster identity is invalid",
        );
      }
      let credential: string;
      try {
        credential = decoder.decode(
          bytes.slice(offset, offset + identityLength),
        );
      } catch {
        throw new V2ProviderStateError(
          "Authenticated OpenMLS roster identity is not UTF-8",
        );
      }
      offset += identityLength;
      const identity = this.parseAuthenticatedCredential(credential);
      if (
        devices.has(identity.deviceId)
        || leaves.has(leafIndex)
      ) {
        throw new V2ProviderStateError(
          "Authenticated OpenMLS roster contains duplicate identity",
        );
      }
      devices.add(identity.deviceId);
      leaves.add(leafIndex);
      const entry = {
        leafIndex,
        humanId: identity.humanId,
        deviceId: identity.deviceId,
      } as OpenMlsV2AuthenticatedRosterEntry;
      Object.defineProperty(entry, "credentialName", {
        configurable: false,
        enumerable: false,
        value: credential,
        writable: false,
      });
      roster.push(Object.freeze(entry));
    }
    if (offset !== bytes.length) {
      throw new V2ProviderStateError(
        "Authenticated OpenMLS roster has trailing bytes",
      );
    }
    roster.sort((left, right) => left.leafIndex - right.leafIndex);
    if (
      this.identityCodec === undefined
      &&
      new Set(roster.map((entry) => entry.humanId)).size
      > V2_LIMITS.humanParticipantsPerDomain
    ) {
      throw new V2ProviderStateError(
        "OpenMLS roster exceeds the 64-Human Domain limit",
      );
    }
    return Object.freeze(roster);
  }

  private encodeRoster(
    roster: readonly RosterEntry[],
  ): Uint8Array {
    if (this.identityCodec !== undefined) {
      return this.identityCodec.encodeRoster(roster);
    }
    const bytes = concatV2(
      frameText(ROSTER_DOMAIN),
      encodeU32(roster.length),
      ...roster.map((entry) =>
        concatV2(
          encodeU32(entry.leafIndex),
          frameText(entry.humanId),
          frameText(entry.deviceId),
        )
      ),
    );
    if (bytes.length > V2_LIMITS.namespaceKeyringBytes) {
      throw new V2ProviderStateError(
        "Canonical OpenMLS roster exceeds the v2 byte limit",
      );
    }
    return bytes;
  }

  private assertAddRoster(
    current: readonly RosterEntry[],
    next: readonly RosterEntry[],
    request: OpenMlsV2JoinRequestPublic,
  ): void {
    const joined = next.find(
      (entry) => entry.deviceId === request.deviceId,
    );
    if (
      next.length !== current.length + 1
      || !joined
      || joined.humanId !== request.humanId
      || (
        request.credentialName !== undefined
        && joined.credentialName !== request.credentialName
      )
      || current.some((entry) => {
        const retained = next.find(
          (candidate) => candidate.deviceId === entry.deviceId,
        );
        return !retained
          || retained.humanId !== entry.humanId
          || retained.credentialName !== entry.credentialName
          || retained.leafIndex !== entry.leafIndex;
      })
    ) {
      throw new V2ProviderStateError(
        "Join request identity does not match the authenticated OpenMLS roster",
      );
    }
  }

  private assertRemoveRoster(
    current: readonly RosterEntry[],
    next: readonly RosterEntry[],
    removedDeviceId: CryptoDeviceId,
  ): void {
    if (
      next.length !== current.length - 1
      || current.some((entry) => {
        if (entry.deviceId === removedDeviceId) return false;
        const retained = next.find(
          (candidate) => candidate.deviceId === entry.deviceId,
        );
        return !retained
          || retained.humanId !== entry.humanId
          || retained.credentialName !== entry.credentialName
          || retained.leafIndex !== entry.leafIndex;
      })
    ) {
      throw new V2ProviderStateError(
        "Removal does not match the authenticated OpenMLS roster",
      );
    }
  }

  private encodeWelcome(
    welcomeBytes: Uint8Array,
    ratchetTreeBytes: Uint8Array,
  ): Uint8Array {
    if (
      welcomeBytes.length < 1
      || welcomeBytes.length > V2_PROVIDER_STATE_MAX_BYTES
      || ratchetTreeBytes.length < 1
      || ratchetTreeBytes.length > V2_PROVIDER_STATE_MAX_BYTES
    ) {
      throw new V2ProviderStateError(
        "OpenMLS Welcome material exceeds v2 limits",
      );
    }
    const encoded = concatV2(
      frameText(WELCOME_DOMAIN),
      encodeU32(STATE_FORMAT_VERSION),
      frame(welcomeBytes),
      frame(ratchetTreeBytes),
    );
    if (encoded.length > V2_PROVIDER_STATE_MAX_BYTES) {
      throw new V2ProviderStateError(
        "OpenMLS Welcome bundle exceeds the v2 provider-state limit",
      );
    }
    return encoded;
  }

  private decodeWelcome(bytes: Uint8Array): WelcomeMaterial {
    if (
      !(bytes instanceof Uint8Array)
      || bytes.length < 1
      || bytes.length > V2_PROVIDER_STATE_MAX_BYTES
    ) {
      throw new V2ProviderStateError(
        "OpenMLS Welcome bundle is invalid",
      );
    }
    return decodeExact(bytes, (reader) => {
      readStateDomain(
        reader,
        WELCOME_DOMAIN,
        "OpenMLS Welcome domain",
      );
      reader.readVersion(STATE_FORMAT_VERSION);
      const welcomeBytes = reader.readFrame(
        V2_PROVIDER_STATE_MAX_BYTES,
      );
      const ratchetTreeBytes = reader.readFrame(
        V2_PROVIDER_STATE_MAX_BYTES,
      );
      if (welcomeBytes.length < 1 || ratchetTreeBytes.length < 1) {
        throw new V2ProviderStateError(
          "OpenMLS Welcome material is empty",
        );
      }
      return Object.freeze({ welcomeBytes, ratchetTreeBytes });
    });
  }

  private validateTransition(
    transition: ProviderPublicTransitionV2,
  ): ProviderPublicTransitionV2 {
    if (
      transition.formatVersion !== V2_PROVIDER_TRANSITION_FORMAT_VERSION
      || transition.providerId !== this.id
      || transition.domainId !== transition.expectedHead.domainId
      || transition.domainId !== transition.nextHead.domainId
      || transition.expectedHead.providerId !== this.id
      || transition.nextHead.providerId !== this.id
      || Number(transition.nextHead.epoch)
        !== Number(transition.expectedHead.epoch) + 1
      || !(transition.commitBytes instanceof Uint8Array)
      || transition.commitBytes.length < 1
      || transition.commitBytes.length > V2_PROVIDER_STATE_MAX_BYTES
      || !(transition.welcomeBytes instanceof Uint8Array)
      || transition.welcomeBytes.length > V2_PROVIDER_STATE_MAX_BYTES
      || !(transition.welcomeHash instanceof Uint8Array)
      || transition.welcomeHash.length !== HASH_BYTES
      || (
        transition.welcomeBytes.length > 0
        && !equalBytes(
          this.crypto.hash(transition.welcomeBytes),
          transition.welcomeHash,
        )
      )
      || !(transition.rosterBytes instanceof Uint8Array)
      || transition.rosterBytes.length < 1
      || transition.rosterBytes.length > (
        this.identityCodec?.maxRosterBytes
        ?? V2_LIMITS.namespaceKeyringBytes
      )
      || !(transition.expectedHead.stateHash instanceof Uint8Array)
      || transition.expectedHead.stateHash.length !== HASH_BYTES
      || !(transition.nextHead.stateHash instanceof Uint8Array)
      || transition.nextHead.stateHash.length !== HASH_BYTES
    ) {
      throw new V2ProviderStateError(
        "OpenMLS public transition is invalid",
      );
    }
    cryptoDomainId(transition.domainId);
    domainEpoch(transition.expectedHead.epoch);
    domainEpoch(transition.nextHead.epoch);
    return cloneProviderPublicTransitionV2(transition);
  }

  private assertJoinRequest(
    request: OpenMlsV2JoinRequestPublic,
  ): void {
    if (
      request.formatVersion !== V2_PROVIDER_TRANSITION_FORMAT_VERSION
      || request.providerId !== this.id
      || request.domainId !== request.expectedHead.domainId
      || request.providerId !== request.expectedHead.providerId
      || !(request.expectedHead.stateHash instanceof Uint8Array)
      || request.expectedHead.stateHash.length !== HASH_BYTES
      || !(request.keyPackageBytes instanceof Uint8Array)
      || request.keyPackageBytes.length < 1
      || request.keyPackageBytes.length > V2_PROVIDER_STATE_MAX_BYTES
      || (
        request.credentialName !== undefined
        && (
          this.identityCodec === undefined
          || request.credentialName.length
            > this.identityCodec.maxCredentialStringBytes
        )
      )
    ) {
      throw new V2ProviderStateError(
        "OpenMLS join request is invalid",
      );
    }
    cryptoDomainId(request.domainId);
    humanId(request.humanId);
    cryptoDeviceId(request.deviceId);
    domainEpoch(request.expectedHead.epoch);
    if (request.credentialName !== undefined) {
      const identity = this.parseAuthenticatedCredential(
        request.credentialName,
      );
      if (
        identity.humanId !== request.humanId
        || identity.deviceId !== request.deviceId
      ) {
        throw new V2ProviderStateError(
          "OpenMLS join credential does not match its public identity",
        );
      }
    }
  }

  private ownCredentialName(ownerHumanId: HumanId): string {
    return this.identityCodec?.credentialName({
      humanId: ownerHumanId,
      deviceId: this.vault.deviceId,
    }) ?? credentialName(ownerHumanId, this.vault.deviceId);
  }

  private parseAuthenticatedCredential(value: string): Readonly<{
    readonly humanId: HumanId;
    readonly deviceId: CryptoDeviceId;
  }> {
    return this.identityCodec?.parseCredentialName(value)
      ?? parseCredentialName(value);
  }
}
