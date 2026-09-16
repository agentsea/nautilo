import type { LatticeCrypto } from "../crypto/index.ts";
import {
  type SealedProviderStateV2,
  DeviceProviderStateVaultV2,
} from "../device/v2-state-vault.ts";
import {
  exportDomainRoot,
} from "../domain/roots.ts";
import {
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
  V2_PROVIDER_TRANSITION_FORMAT_VERSION,
  cloneProviderHeadV2,
  cloneProviderPublicTransitionV2,
  candidatePayloadSnapshotV2,
  destroyOpenedProviderCandidateStateV2,
  markLocalProviderCandidateV2,
  openLocalProviderCandidateV2,
  providerHeadsEqualV2,
  providerPublicTransitionDigestMatchesV2,
  sealLocalProviderCandidateV2,
} from "../transition/provider-candidate.ts";
import {
  V2_LIMITS,
} from "../v2-types/limits.ts";
import {
  type CryptoDeviceId,
  type CryptoDomainId,
  type DomainEpoch,
  type HumanId,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "../v2-types/ids.ts";
import type {
  DomainRootsV2,
  DummyProviderBootstrapV2,
  V2GroupKeyProvider,
} from "./v2-provider.ts";
import { V2ProviderStateError } from "./v2-provider.ts";

const DUMMY_PROVIDER_ID = "dummy-v2";
const DUMMY_STATE_FORMAT_VERSION = 2;
const DUMMY_SEMANTIC_STATE_FORMAT_VERSION = 3;
const DUMMY_STATE_DOMAIN =
  "nautilo/lattice-crypto/dummy-provider-state/v2";
const DUMMY_INITIAL_HEAD_DOMAIN =
  "nautilo/lattice-crypto/dummy-provider-initial-head/v2";
const DUMMY_NEXT_HEAD_DOMAIN =
  "nautilo/lattice-crypto/dummy-provider-next-head/v2";
const DUMMY_UPDATE_SECRET_LABEL =
  "nautilo/lattice-crypto/dummy-provider-update/v2";
const EXPORTER_SECRET_BYTES = 32;
const PUBLIC_HASH_BYTES = 32;
const COMMIT_BYTES = 32;

interface DummyStateBaseV2 {
  readonly domainId: CryptoDomainId;
  readonly epoch: DomainEpoch;
  readonly exporterSecret: Uint8Array;
  readonly stateHash: Uint8Array;
}

interface DummyRosterEntry {
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
}

type DummyStateV2 = DummyStateBaseV2 & (
  | Readonly<{
    readonly roster: null;
    readonly removed?: never;
  }>
  | Readonly<{
    readonly roster: readonly DummyRosterEntry[];
    readonly removed: boolean;
  }>
);

function exactBytes(
  label: string,
  bytes: Uint8Array,
  length: number,
): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new V2ProviderStateError(
      `${label} must be exactly ${length} bytes`,
    );
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function encodeState(
  deviceId: string,
  state: DummyStateV2,
): Uint8Array {
  return concatV2(
    encodeU32(
      state.roster === null
        ? DUMMY_STATE_FORMAT_VERSION
        : DUMMY_SEMANTIC_STATE_FORMAT_VERSION,
    ),
    frameText(DUMMY_STATE_DOMAIN),
    frameText(DUMMY_PROVIDER_ID),
    frameText(state.domainId),
    frameText(deviceId),
    encodeU64(state.epoch),
    frame(state.exporterSecret),
    frame(state.stateHash),
    ...(state.roster === null
      ? []
      : [
        frame(encodeRoster(state.roster)),
        encodeU32(state.removed ? 1 : 0),
      ]),
  );
}

function decodeState(bytes: Uint8Array, expectedDeviceId: string): DummyStateV2 {
  return decodeExact(bytes, (reader: StrictDecoder) => {
    const version = reader.readU32();
    if (
      version !== DUMMY_STATE_FORMAT_VERSION
      && version !== DUMMY_SEMANTIC_STATE_FORMAT_VERSION
    ) {
      throw new V2ProviderStateError(
        `Unsupported dummy provider state version ${version}`,
      );
    }
    if (reader.readText(128) !== DUMMY_STATE_DOMAIN) {
      throw new V2ProviderStateError("Dummy provider state domain is invalid");
    }
    if (reader.readText(V2_LIMITS.idBytes) !== DUMMY_PROVIDER_ID) {
      throw new V2ProviderStateError("Dummy provider id is invalid");
    }
    const domainId = cryptoDomainId(reader.readText(V2_LIMITS.idBytes));
    if (reader.readText(V2_LIMITS.idBytes) !== expectedDeviceId) {
      throw new V2ProviderStateError(
        "Dummy provider state belongs to another device",
      );
    }
    const state = {
      domainId,
      epoch: domainEpoch(reader.readU64()),
      exporterSecret: exactBytes(
        "Dummy exporter secret",
        reader.readFrame(EXPORTER_SECRET_BYTES),
        EXPORTER_SECRET_BYTES,
      ),
      stateHash: exactBytes(
        "Dummy public state hash",
        reader.readFrame(PUBLIC_HASH_BYTES),
        PUBLIC_HASH_BYTES,
      ),
    };
    if (version === DUMMY_STATE_FORMAT_VERSION) {
      return { ...state, roster: null };
    }
    const roster = decodeRoster(
      reader.readFrame(V2_LIMITS.namespaceKeyringBytes),
    );
    const removed = reader.readU32();
    if (removed !== 0 && removed !== 1) {
      throw new V2ProviderStateError(
        "Dummy provider removed marker is invalid",
      );
    }
    return { ...state, roster, removed: removed === 1 };
  });
}

function encodeRoster(roster: readonly DummyRosterEntry[]): Uint8Array {
  return concatV2(
    encodeU32(roster.length),
    ...roster.map((entry) =>
      concatV2(
        frameText(entry.humanId),
        frameText(entry.deviceId),
      )
    ),
  );
}

function decodeRoster(bytes: Uint8Array): readonly DummyRosterEntry[] {
  return decodeExact(bytes, (reader) => {
    const count = reader.readCount(V2_LIMITS.deviceLeavesPerDomain);
    const roster = Array.from({ length: count }, () => Object.freeze({
      humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      deviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
    }));
    if (new Set(roster.map((entry) => entry.deviceId)).size !== roster.length) {
      throw new V2ProviderStateError(
        "Dummy provider roster contains duplicate devices",
      );
    }
    if (
      new Set(roster.map((entry) => entry.humanId)).size
        > V2_LIMITS.humanParticipantsPerDomain
    ) {
      throw new V2ProviderStateError(
        "Dummy provider roster exceeds the Human limit",
      );
    }
    return Object.freeze(roster);
  });
}

/**
 * Binary-free semantic provider for candidate lifecycle and membership tests.
 * Its roster is deliberately simple, but add/remove and device exclusion
 * advance the same sealed candidate lifecycle as the MLS-backed providers.
 */
export class DummyV2GroupProvider implements V2GroupKeyProvider {
  readonly id = DUMMY_PROVIDER_ID;

  constructor(
    private readonly crypto: LatticeCrypto,
    private readonly vault: DeviceProviderStateVaultV2,
  ) {}

  bootstrapForTesting(
    input: DummyProviderBootstrapV2,
  ): SealedProviderStateV2 {
    const domainId = cryptoDomainId(input.domainId);
    const epoch = domainEpoch(input.epoch);
    const exporterSecret = exactBytes(
      "Dummy exporter secret",
      input.exporterSecret,
      EXPORTER_SECRET_BYTES,
    );
    const stateHash = this.crypto.hash(
      concatV2(
        frameText(DUMMY_INITIAL_HEAD_DOMAIN),
        frameText(domainId),
        encodeU64(epoch),
        frame(exporterSecret),
      ),
    );
    return this.sealState("active", {
      domainId,
      epoch,
      exporterSecret,
      stateHash,
      roster: null,
    });
  }

  bootstrapSemanticForTesting(input: DummyProviderBootstrapV2 & {
    readonly roster: readonly {
      readonly humanId: HumanId;
      readonly deviceId: CryptoDeviceId;
    }[];
    readonly stateHash?: Uint8Array;
  }): SealedProviderStateV2 {
    const domainId = cryptoDomainId(input.domainId);
    const epoch = domainEpoch(input.epoch);
    const exporterSecret = exactBytes(
      "Dummy exporter secret",
      input.exporterSecret,
      EXPORTER_SECRET_BYTES,
    );
    const roster = decodeRoster(encodeRoster(input.roster.map((entry) => ({
      humanId: humanId(entry.humanId),
      deviceId: cryptoDeviceId(entry.deviceId),
    }))));
    const rosterBytes = encodeRoster(roster);
    const stateHash = input.stateHash === undefined
      ? this.crypto.hash(concatV2(
        frameText(DUMMY_INITIAL_HEAD_DOMAIN),
        frameText(domainId),
        encodeU64(epoch),
        frame(exporterSecret),
        frame(rosterBytes),
      ))
      : exactBytes(
        "Dummy semantic state hash",
        input.stateHash,
        PUBLIC_HASH_BYTES,
      );
    return this.sealState("active", {
      domainId,
      epoch,
      exporterSecret,
      stateHash,
      roster,
      removed: !roster.some(
        (entry) => entry.deviceId === this.vault.deviceId,
      ),
    });
  }

  exportSemanticBootstrapForTesting(
    active: SealedProviderStateV2,
  ): DummyProviderBootstrapV2 & {
    readonly roster: readonly DummyRosterEntry[];
    readonly stateHash: Uint8Array;
  } {
    const state = this.openSemanticActive(active);
    return Object.freeze({
      domainId: state.domainId,
      epoch: state.epoch,
      exporterSecret: state.exporterSecret,
      stateHash: state.stateHash,
      roster: Object.freeze(state.roster.map((entry) => Object.freeze({
        humanId: entry.humanId,
        deviceId: entry.deviceId,
      }))),
    });
  }

  publicHead(active: SealedProviderStateV2): ProviderPublicHeadV2 {
    return this.head(this.openState(active, "active"));
  }

  publicRoster(active: SealedProviderStateV2): Uint8Array {
    const state = this.openState(active, "active");
    return state.roster === null
      ? new Uint8Array()
      : encodeRoster(state.roster);
  }

  async exportDomainRoots(
    active: SealedProviderStateV2,
  ): Promise<DomainRootsV2> {
    const state = this.openState(active, "active");
    if (state.removed) {
      throw new V2ProviderStateError(
        "Removed dummy device cannot export current Domain roots",
      );
    }
    const exporter = (
      label: string,
      context: Uint8Array,
      length: number,
    ): Promise<Uint8Array> => Promise.resolve(
      this.crypto.deriveKey(
        concatV2(state.exporterSecret, context),
        label,
        length,
      ),
    );
    let human: Uint8Array | null = null;
    try {
      human = await exportDomainRoot(
        "human",
        state.domainId,
        state.epoch,
        exporter,
      );
      const ai = await exportDomainRoot(
        "ai",
        state.domainId,
        state.epoch,
        exporter,
      );
      return Object.freeze({ human, ai });
    } catch (error) {
      human?.fill(0);
      throw error;
    }
  }

  prepareCommit(input: {
    readonly active: SealedProviderStateV2;
  }): Promise<PreparedProviderCommitV2> {
    try {
      const activeState = this.openState(input.active, "active");
      const actor = activeState.roster?.find(
        (entry) => entry.deviceId === this.vault.deviceId,
      ) ?? {
        // Legacy binary-free bootstrap snapshots predate semantic rosters and
        // exist only behind the test provider. Keep their update target stable
        // and device-bound without inventing a product Human authority.
        humanId: humanId(this.vault.deviceId),
        deviceId: this.vault.deviceId,
      };
      return Promise.resolve(
        this.prepareStateTransition(activeState, activeState.roster, {
          operation: "update",
          targetHumanId: actor.humanId,
          targetDeviceId: actor.deviceId,
        }),
      );
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new V2ProviderStateError("Unable to prepare dummy commit"),
      );
    }
  }

  prepareAdd(input: {
    readonly active: SealedProviderStateV2;
    readonly humanId: HumanId;
    readonly deviceId: CryptoDeviceId;
  }): Promise<PreparedProviderCommitV2> {
    try {
      const active = this.openSemanticActive(input.active);
      const entry = {
        humanId: humanId(input.humanId),
        deviceId: cryptoDeviceId(input.deviceId),
      };
      if (active.roster.some((current) =>
        current.deviceId === entry.deviceId
      )) {
        throw new V2ProviderStateError(
          "Dummy add device already exists in the authenticated roster",
        );
      }
      return Promise.resolve(this.prepareStateTransition(
        active,
        Object.freeze([...active.roster, Object.freeze(entry)]),
        {
          operation: "add",
          targetHumanId: entry.humanId,
          targetDeviceId: entry.deviceId,
        },
      ));
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new V2ProviderStateError("Unable to prepare dummy add"),
      );
    }
  }

  prepareRemove(input: {
    readonly active: SealedProviderStateV2;
    readonly removedDeviceId: CryptoDeviceId;
  }): Promise<PreparedProviderCommitV2> {
    try {
      const active = this.openSemanticActive(input.active);
      const removedDeviceId = cryptoDeviceId(input.removedDeviceId);
      if (!active.roster.some((entry) => entry.deviceId === removedDeviceId)) {
        throw new V2ProviderStateError(
          "Removed dummy device is not in the authenticated roster",
        );
      }
      if (active.roster.length === 1) {
        throw new V2ProviderStateError(
          "Final dummy device removal requires explicit Domain rebootstrap",
        );
      }
      return Promise.resolve(this.prepareStateTransition(
        active,
        Object.freeze(
          active.roster.filter((entry) => entry.deviceId !== removedDeviceId),
        ),
        {
          operation: "remove",
          targetHumanId: active.roster.find(
            (entry) => entry.deviceId === removedDeviceId,
          )!.humanId,
          targetDeviceId: removedDeviceId,
        },
      ));
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new V2ProviderStateError("Unable to prepare dummy remove"),
      );
    }
  }

  prepareIncoming(input: {
    readonly active: SealedProviderStateV2;
    readonly publicResult: ProviderPublicTransitionV2;
  }): Promise<LocalProviderCandidateV2> {
    try {
      const activeState = this.openState(input.active, "active");
      const transition = this.validatePublicTransition(input.publicResult);
      if (
        !providerHeadsEqualV2(this.head(activeState), transition.expectedHead)
      ) {
        throw new V2ProviderStateError(
          "Incoming commit does not match the exact expected public head",
        );
      }
      const nextState = this.nextState(
        activeState,
        transition.commitBytes,
        activeState.roster === null
          ? null
          : decodeRoster(transition.rosterBytes),
      );
      if (!providerHeadsEqualV2(this.head(nextState), transition.nextHead)) {
        throw new V2ProviderStateError(
          "Incoming commit does not match the exact next public head",
        );
      }
      return Promise.resolve(
        this.localCandidate(activeState, nextState, transition),
      );
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new V2ProviderStateError("Unable to prepare incoming dummy commit"),
      );
    }
  }

  validatePreparedCandidate(input: {
    readonly active: SealedProviderStateV2;
    readonly prepared: PreparedProviderCommitV2;
  }): Promise<void> {
    const activeState = this.openState(input.active, "active");
    const transition = this.validatePublicTransition(
      input.prepared.publicResult,
    );
    const openedCandidate = openLocalProviderCandidateV2({
      vault: this.vault,
      candidate: input.prepared.localCandidate,
    });
    try {
      if (
        !providerPublicTransitionDigestMatchesV2(
          this.crypto,
          transition,
          openedCandidate.publicTransitionDigest,
        )
      ) {
        throw new V2ProviderStateError(
          "Dummy prepared candidate does not match its public transition",
        );
      }
      if (openedCandidate.lifecycle === "applied") {
        if (
          !providerHeadsEqualV2(
            this.head(activeState),
            transition.nextHead,
          )
        ) {
          throw new V2ProviderStateError(
            "Applied dummy candidate does not match the active public head",
          );
        }
        return Promise.resolve();
      }
      if (
        openedCandidate.lifecycle !== "prepared"
        || !providerHeadsEqualV2(
          this.head(activeState),
          transition.expectedHead,
        )
      ) {
        throw new V2ProviderStateError(
          "Dummy prepared candidate does not match the active public head",
        );
      }
      const nested = candidatePayloadSnapshotV2(
        input.prepared.localCandidate,
        openedCandidate.payload,
      );
      try {
        const candidateState = this.openState(nested, "candidate");
        const expectedState = this.nextState(
          activeState,
          transition.commitBytes,
          activeState.roster === null
            ? null
            : decodeRoster(transition.rosterBytes),
        );
        if (
          !providerHeadsEqualV2(
            this.head(candidateState),
            transition.nextHead,
          )
          || !providerHeadsEqualV2(
            this.head(expectedState),
            transition.nextHead,
          )
        ) {
          throw new V2ProviderStateError(
            "Dummy public transition does not match its sealed candidate",
          );
        }
      } finally {
        nested.ciphertext.fill(0);
      }
    } finally
    // the opened candidate's detached digest and payload; neither buffer
    // escapes validatePreparedCandidate, so their required wipe is unobservable.
    {
      destroyOpenedProviderCandidateStateV2(openedCandidate);
    }
    return Promise.resolve();
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
      protectedCandidate.lifecycle === "aborted"
      || protectedCandidate.lifecycle === "stale"
    ) {
      destroyOpenedProviderCandidateStateV2(protectedCandidate);
      return Object.freeze({ status: "aborted" as const, active: input.active });
    }

    try {
      const activeState = this.openState(input.active, "active");
      const activeHead = this.head(activeState);
      if (providerHeadsEqualV2(activeHead, candidate.nextHead)) {
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
      if (!providerHeadsEqualV2(activeHead, candidate.expectedHead)) {
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
          "Applied candidate cannot be replayed against its old active head",
        );
      }
      const nested = candidatePayloadSnapshotV2(
        candidate,
        protectedCandidate.payload,
      );
      const candidateState = this.openState(nested, "candidate");
      nested.ciphertext.fill(0);
      if (!providerHeadsEqualV2(this.head(candidateState), candidate.nextHead)) {
        throw new V2ProviderStateError(
          "Candidate state does not match its exact next public head",
        );
      }
      const nextActive = this.sealState("active", candidateState);
      markLocalProviderCandidateV2({
        vault: this.vault,
        candidate,
        lifecycle: "applied",
      });
      return Object.freeze({
        status: "applied" as const,
        active: nextActive,
      });
    } finally
    // the opened candidate's detached digest and payload; neither buffer
    // escapes applyCandidate, so their required wipe is unobservable.
    {
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
    } finally
    // the opened candidate's detached digest and payload; neither buffer
    // escapes abortCandidate, so their required wipe is unobservable.
    {
      destroyOpenedProviderCandidateStateV2(protectedCandidate);
    }
  }

  private openState(
    snapshot: SealedProviderStateV2,
    snapshotKind: "active" | "candidate",
  ): DummyStateV2 {
    if (
      snapshot.providerId !== this.id
      || snapshot.deviceId !== this.vault.deviceId
      || snapshot.snapshotKind !== snapshotKind
    ) {
      throw new V2ProviderStateError(
        `Invalid ${snapshotKind} provider snapshot coordinates`,
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
        `Unable to open ${snapshotKind} provider snapshot`,
      );
    }
    const state = decodeState(plaintext, this.vault.deviceId);
    if (
      state.domainId !== snapshot.domainId
      || state.epoch !== snapshot.revision
    ) {
      throw new V2ProviderStateError(
        `${snapshotKind} provider snapshot metadata mismatch`,
      );
    }
    return state;
  }

  private sealState(
    snapshotKind: "active" | "candidate",
    state: DummyStateV2,
  ): SealedProviderStateV2 {
    return this.vault.seal(
      {
        providerId: this.id,
        domainId: state.domainId,
        revision: state.epoch,
        snapshotKind,
      },
      encodeState(this.vault.deviceId, state),
    );
  }

  private head(state: DummyStateV2): ProviderPublicHeadV2 {
    return cloneProviderHeadV2({
      providerId: this.id,
      domainId: state.domainId,
      epoch: state.epoch,
      stateHash: state.stateHash,
    });
  }

  private openSemanticActive(
    active: SealedProviderStateV2,
  ): DummyStateV2 & { readonly roster: readonly DummyRosterEntry[] } {
    const state = this.openState(active, "active");
    if (state.roster === null) {
      throw new V2ProviderStateError(
        "Dummy membership transition requires semantic roster state",
      );
    }
    if (state.removed) {
      throw new V2ProviderStateError(
        "Removed dummy device cannot prepare a membership transition",
      );
    }
    return state as DummyStateV2 & {
      readonly roster: readonly DummyRosterEntry[];
    };
  }

  private prepareStateTransition(
    active: DummyStateV2,
    roster: readonly DummyRosterEntry[] | null,
    authorizationTarget: Readonly<{
      readonly operation: ProviderTransitionOperationV2;
      readonly targetHumanId: HumanId;
      readonly targetDeviceId: CryptoDeviceId;
    }>,
  ): PreparedProviderCommitV2 {
    const commitBytes = this.crypto.randomBytes(COMMIT_BYTES);
    const nextState = this.nextState(active, commitBytes, roster);
    const publicResult = this.publicTransition(
      this.head(active),
      this.head(nextState),
      commitBytes,
      roster === null ? new Uint8Array() : encodeRoster(roster),
      authorizationTarget,
    );
    return Object.freeze({
      publicResult: cloneProviderPublicTransitionV2(publicResult),
      localCandidate: this.localCandidate(
        active,
        nextState,
        publicResult,
      ),
    });
  }

  private nextState(
    active: DummyStateV2,
    commitBytes: Uint8Array,
    roster: readonly DummyRosterEntry[] | null,
  ): DummyStateV2 {
    const commit = exactBytes(
      "Dummy public commit",
      commitBytes,
      COMMIT_BYTES,
    );
    const nextEpoch = domainEpoch(Number(active.epoch) + 1);
    const exporterSecret = this.crypto.deriveKey(
      concatV2(
        active.exporterSecret,
        frameText(active.domainId),
        encodeU64(nextEpoch),
        frame(commit),
      ),
      DUMMY_UPDATE_SECRET_LABEL,
      EXPORTER_SECRET_BYTES,
    );
    const publicRoster = roster === null ? null : encodeRoster(roster);
    const stateHash = this.crypto.hash(concatV2(
        frameText(DUMMY_NEXT_HEAD_DOMAIN),
        frameText(this.id),
        frameText(active.domainId),
        encodeU64(nextEpoch),
        frame(active.stateHash),
        frame(commit),
        ...(publicRoster === null ? [] : [frame(publicRoster)]),
      ));
    const common = {
      domainId: active.domainId,
      epoch: nextEpoch,
      exporterSecret,
      stateHash,
    };
    if (roster === null) return { ...common, roster };
    return {
      ...common,
      roster,
      removed: roster.every(
        (entry) => entry.deviceId !== this.vault.deviceId,
      ),
    };
  }

  private publicTransition(
    expectedHead: ProviderPublicHeadV2,
    nextHead: ProviderPublicHeadV2,
    commitBytes: Uint8Array,
    rosterBytes: Uint8Array,
    authorizationTarget: Readonly<{
      readonly operation: ProviderTransitionOperationV2;
      readonly targetHumanId: HumanId;
      readonly targetDeviceId: CryptoDeviceId;
    }>,
  ): ProviderPublicTransitionV2 {
    return cloneProviderPublicTransitionV2({
      formatVersion: V2_PROVIDER_TRANSITION_FORMAT_VERSION,
      providerId: this.id,
      domainId: expectedHead.domainId,
      ...authorizationTarget,
      expectedHead,
      nextHead,
      commitBytes,
      welcomeHash: this.crypto.hash(new Uint8Array()),
      welcomeBytes: new Uint8Array(0),
      rosterBytes,
    });
  }

  private localCandidate(
    expected: DummyStateV2,
    next: DummyStateV2,
    publicTransition: ProviderPublicTransitionV2,
  ): LocalProviderCandidateV2 {
    const nested = this.sealState("candidate", next);
    try {
      return sealLocalProviderCandidateV2({
        crypto: this.crypto,
        vault: this.vault,
        providerId: this.id,
        domainId: expected.domainId,
        expectedHead: this.head(expected),
        nextHead: this.head(next),
        publicTransition,
        payload: nested.ciphertext,
      });
    } finally
    // the detached nested ciphertext after the outer candidate seal copies it;
    // no reference escapes localCandidate, so its required wipe is unobservable.
    {
      nested.ciphertext.fill(0);
    }
  }

  private validatePublicTransition(
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
      || transition.commitBytes.length !== COMMIT_BYTES
      || !(transition.welcomeBytes instanceof Uint8Array)
      || transition.welcomeBytes.length !== 0
      || !(transition.welcomeHash instanceof Uint8Array)
      || transition.welcomeHash.length !== PUBLIC_HASH_BYTES
      || !equalBytes(
        transition.welcomeHash,
        this.crypto.hash(new Uint8Array()),
      )
      || !(transition.rosterBytes instanceof Uint8Array)
      || !(transition.expectedHead.stateHash instanceof Uint8Array)
      || transition.expectedHead.stateHash.length !== PUBLIC_HASH_BYTES
      || !(transition.nextHead.stateHash instanceof Uint8Array)
      || transition.nextHead.stateHash.length !== PUBLIC_HASH_BYTES
    ) {
      throw new V2ProviderStateError(
        "Dummy provider public transition is invalid",
      );
    }
    if (transition.rosterBytes.length > 0) {
      try {
        decodeRoster(transition.rosterBytes);
      } catch {
        throw new V2ProviderStateError(
          "Dummy provider public transition is invalid",
        );
      }
    }
    return cloneProviderPublicTransitionV2(transition);
  }

}
