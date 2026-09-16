import {
  acceptAll,
  createCommit,
  createGroup,
  decodeGroupState,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  mlsExporter,
  processMessage,
  zeroOutUint8Array,
  type CiphersuiteImpl,
  type CiphersuiteName,
  type ClientState,
  type Credential,
  type KeyPackage,
  type LeafIndex,
  type PrivateKeyPackage,
  type Proposal,
} from "ts-mls";
import { defaultClientConfig } from "ts-mls/clientConfig.js";
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
  type DomainEpoch,
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

const PROVIDER_ID = "ts-mls-v2";
const STATE_FORMAT_VERSION = 2;
const STATE_DOMAIN = "nautilo/lattice-crypto/ts-mls-device-state/v2";
const JOIN_DOMAIN = "nautilo/lattice-crypto/ts-mls-join-state/v2";
const CREDENTIAL_DOMAIN = "nautilo/lattice-crypto/ts-mls-credential/v2";
const ROSTER_DOMAIN = "nautilo/lattice-crypto/ts-mls-roster/v2";
const INITIAL_HEAD_DOMAIN = "nautilo/lattice-crypto/ts-mls-initial-head/v2";
const NEXT_HEAD_DOMAIN = "nautilo/lattice-crypto/ts-mls-next-head/v2";
const JOIN_ID_DOMAIN = "nautilo/lattice-crypto/ts-mls-join-id/v2";
const HASH_BYTES = 32;

interface MlsState {
  readonly state: ClientState;
  readonly humanId: HumanId;
  readonly head: ProviderPublicHeadV2;
}

interface OpenedMlsState extends MlsState {
  readonly stateFrame: Uint8Array;
  readonly stateHashFrame: Uint8Array;
}

interface RosterEntry {
  readonly leafIndex: LeafIndex;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
}

interface JoinMaterial {
  readonly joinId: string;
  readonly lifecycle: "prepared" | "applied" | "aborted";
  readonly domainId: CryptoDomainId;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly keyPackageBytes: Uint8Array;
  readonly privatePackage: PrivateKeyPackage;
}

function destroyPrivateKeyPackage(value: PrivateKeyPackage): void {
  value.initPrivateKey.fill(0);
  value.hpkePrivateKey.fill(0);
  value.signaturePrivateKey.fill(0);
}

function destroyClientState(state: ClientState): void {
  const secrets = new Set<Uint8Array>([
    state.keySchedule.senderDataSecret,
    state.keySchedule.exporterSecret,
    state.keySchedule.externalSecret,
    state.keySchedule.confirmationKey,
    state.keySchedule.membershipKey,
    state.keySchedule.resumptionPsk,
    state.keySchedule.epochAuthenticator,
    state.keySchedule.initSecret,
    ...Object.values(state.privatePath.privateKeys),
    state.signaturePrivateKey,
  ]);
  const collectSecretTree = (
    tree: ClientState["secretTree"],
  ): void => {
    for (const node of tree) {
      for (const generation of [node.handshake, node.application]) {
        secrets.add(generation.secret);
        Object.values(generation.unusedGenerations).forEach((secret) =>
          secrets.add(secret)
        );
      }
    }
  };
  collectSecretTree(state.secretTree);
  for (const historical of state.historicalReceiverData.values()) {
    secrets.add(historical.resumptionPsk);
    secrets.add(historical.senderDataSecret);
    collectSecretTree(historical.secretTree);
  }
  secrets.forEach((secret) => secret.fill(0));
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
  request: MlsV2JoinRequestPublic,
): MlsV2JoinRequestPublic {
  return Object.freeze({
    formatVersion: request.formatVersion,
    providerId: request.providerId,
    domainId: request.domainId,
    humanId: request.humanId,
    deviceId: request.deviceId,
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

export interface MlsV2JoinRequestPublic {
  readonly formatVersion: 2;
  readonly providerId: string;
  readonly domainId: CryptoDomainId;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly keyPackageBytes: Uint8Array;
}

export interface MlsV2JoinRequest {
  readonly publicResult: MlsV2JoinRequestPublic;
  readonly localState: SealedProviderStateV2;
}

function exactBytes(
  label: string,
  value: Uint8Array,
  length: number,
): Uint8Array {
  if (value.length !== length) {
    throw new V2ProviderStateError(
      `${label} must contain exactly ${length} bytes`,
    );
  }
  return value;
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

function epochFromState(state: ClientState): DomainEpoch {
  const epoch = state.groupContext.epoch;
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new V2ProviderStateError("MLS epoch exceeds the safe integer range");
  }
  return domainEpoch(Number(epoch));
}

function credentialBytes(
  human: HumanId,
  device: CryptoDeviceId,
): Uint8Array {
  return concatV2(
    frameText(CREDENTIAL_DOMAIN),
    frameText(human),
    frameText(device),
  );
}

function credentialFor(
  human: HumanId,
  device: CryptoDeviceId,
): Credential {
  return {
    credentialType: "basic",
    identity: credentialBytes(human, device),
  };
}

function parseCredential(
  credential: Credential,
): Readonly<{ humanId: HumanId; deviceId: CryptoDeviceId }> {
  if (credential.credentialType !== "basic") {
    throw new V2ProviderStateError("MLS credential must be basic");
  }
  return decodeExact(credential.identity, (reader) => {
    const domain = reader.readText(CREDENTIAL_DOMAIN.length);
    if (domain !== CREDENTIAL_DOMAIN) {
      throw new CanonicalDecodingError("MLS credential domain is unsupported");
    }
    return Object.freeze({
      humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      deviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
    });
  });
}

function decodeMessage(bytes: Uint8Array) {
  const decoded = decodeMlsMessage(bytes, 0);
  if (!decoded || decoded[1] !== bytes.length) {
    throw new V2ProviderStateError("MLS message is malformed or noncanonical");
  }
  return decoded[0];
}

function decodeKeyPackageMessage(bytes: Uint8Array): KeyPackage {
  const message = decodeMessage(bytes);
  if (message.wireformat !== "mls_key_package") {
    throw new V2ProviderStateError("Expected an MLS key package");
  }
  return message.keyPackage;
}

function readExactDomain(
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
    frame(exactBytes("MLS public state hash", head.stateHash, HASH_BYTES)),
  );
}

function decodeProviderHead(reader: StrictDecoder): ProviderPublicHeadV2 {
  return cloneProviderHeadV2({
    providerId: reader.readText(V2_LIMITS.idBytes),
    domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
    epoch: domainEpoch(reader.readU64()),
    stateHash: exactBytes(
      "MLS public state hash",
      reader.readFrame(HASH_BYTES),
      HASH_BYTES,
    ),
  });
}

function joinLifecycleCode(
  lifecycle: JoinMaterial["lifecycle"],
): number {
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
      throw new V2ProviderStateError("Local ts-mls join lifecycle is invalid");
  }
}

export class TsMlsV2GroupProvider implements V2GroupKeyProvider {
  readonly id = PROVIDER_ID;
  private impl!: CiphersuiteImpl;
  private readonly ready: Promise<void>;

  constructor(
    private readonly crypto: LatticeCrypto,
    private readonly vault: DeviceProviderStateVaultV2,
    ciphersuiteName: CiphersuiteName =
      "MLS_256_DHKEMP521_AES256GCM_SHA512_P521",
  ) {
    this.ready = getCiphersuiteImpl(
      getCiphersuiteFromName(ciphersuiteName),
    ).then((impl) => {
      this.impl = impl;
    });
  }

  async createInitialState(input: {
    readonly domainId: CryptoDomainId;
    readonly humanId: HumanId;
  }): Promise<SealedProviderStateV2> {
    const domainId = cryptoDomainId(input.domainId);
    const ownerHumanId = humanId(input.humanId);
    await this.ready;
    const generated = await generateKeyPackage(
      credentialFor(ownerHumanId, this.vault.deviceId),
      defaultCapabilities(),
      defaultLifetime,
      [],
      this.impl,
    );
    let state: ClientState | undefined;
    try {
      state = await createGroup(
        new TextEncoder().encode(domainId),
        generated.publicPackage,
        generated.privatePackage,
        [],
        this.impl,
      );
      const rosterBytes = this.rosterBytes(state);
      const head = this.initialHead(domainId, state, rosterBytes);
      return this.sealState("active", {
        state,
        humanId: ownerHumanId,
        head,
      });
    } finally {
      destroyPrivateKeyPackage(generated.privatePackage);
      if (state) destroyClientState(state);
    }
  }

  async createJoinRequest(input: {
    readonly domainId: CryptoDomainId;
    readonly humanId: HumanId;
    readonly expectedHead: ProviderPublicHeadV2;
  }): Promise<MlsV2JoinRequest> {
    const domainId = cryptoDomainId(input.domainId);
    const joiningHumanId = humanId(input.humanId);
    const expectedHead = cloneProviderHeadV2(input.expectedHead);
    await this.ready;
    if (
      expectedHead.providerId !== this.id
      || expectedHead.domainId !== domainId
    ) {
      throw new V2ProviderStateError(
        "Join request requires the exact trusted ts-mls public head",
      );
    }
    const generated = await generateKeyPackage(
      credentialFor(joiningHumanId, this.vault.deviceId),
      defaultCapabilities(),
      defaultLifetime,
      [],
      this.impl,
    );
    try {
      const keyPackageBytes = copyOwnedBytesV2(encodeMlsMessage({
        wireformat: "mls_key_package",
        version: "mls10",
        keyPackage: generated.publicPackage,
      }));
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
        privatePackage: generated.privatePackage,
      });
      return Object.freeze({
        publicResult: Object.freeze({
          formatVersion: V2_PROVIDER_TRANSITION_FORMAT_VERSION,
          providerId: this.id,
          domainId,
          humanId: joiningHumanId,
          deviceId: this.vault.deviceId,
          expectedHead: cloneProviderHeadV2(expectedHead),
          keyPackageBytes,
        }),
        localState,
      });
    } finally {
      destroyPrivateKeyPackage(generated.privatePackage);
    }
  }

  async prepareAdd(input: {
    readonly active: SealedProviderStateV2;
    readonly joinRequest: MlsV2JoinRequestPublic;
  }): Promise<PreparedProviderCommitV2> {
    this.assertJoinRequest(input.joinRequest);
    const active = snapshotSealedProviderState(input.active);
    const joinRequest = snapshotJoinRequest(input.joinRequest);
    await this.ready;
    const opened = this.openState(active, "active");
    try {
      // assertJoinRequest binds the request Domain to its expected head, so exact
      // head equality also proves the active/request Domain equality.
      if (
        !providerHeadsEqualV2(
          opened.head,
          joinRequest.expectedHead,
        )
      ) {
        throw new V2ProviderStateError(
          "Join request does not match the active Domain head",
        );
      }
      const currentRoster = this.roster(opened.state);
      if (
        currentRoster.some(
          (entry) => entry.deviceId === joinRequest.deviceId,
        )
      ) {
        throw new V2ProviderStateError(
          "Join request device already exists in the authenticated MLS roster",
        );
      }
      if (currentRoster.length >= V2_LIMITS.deviceLeavesPerDomain) {
        throw new V2ProviderStateError(
          "Join request would exceed the 256-device Domain limit",
        );
      }
      const currentHumans = new Set(
        currentRoster.map((entry) => entry.humanId),
      );
      if (
        !currentHumans.has(joinRequest.humanId)
        && currentHumans.size >= V2_LIMITS.humanParticipantsPerDomain
      ) {
        throw new V2ProviderStateError(
          "Join request would exceed the 64-Human Domain limit",
        );
      }
      const joiningKeyPackage = decodeKeyPackageMessage(
        joinRequest.keyPackageBytes,
      );
      const joiningCredential = parseCredential(
        joiningKeyPackage.leafNode.credential,
      );
      if (
        joiningCredential.humanId !== joinRequest.humanId
        || joiningCredential.deviceId !== joinRequest.deviceId
      ) {
        throw new V2ProviderStateError(
          "Join request identity does not match its signed MLS key package",
        );
      }
      const proposal: Proposal = {
        proposalType: "add",
        add: {
          keyPackage: joiningKeyPackage,
        },
      };
      return await this.prepareProposals(opened, [proposal], {
        operation: "add",
        targetHumanId: joinRequest.humanId,
        targetDeviceId: joinRequest.deviceId,
      });
    } finally {
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
    try {
      this.assertGroupActive(opened.state);
      const target = this.roster(opened.state).find(
        (entry) => entry.deviceId === removedDeviceId,
      );
      if (!target) {
        throw new V2ProviderStateError(
          "Removed device is not in the authenticated MLS roster",
        );
      }
      if (this.roster(opened.state).length === 1) {
        throw new V2ProviderStateError(
          "Final MLS device removal requires explicit Domain rebootstrap",
        );
      }
      const proposal: Proposal = {
        proposalType: "remove",
        remove: { removed: target.leafIndex },
      };
      return await this.prepareProposals(opened, [proposal], {
        operation: "remove",
        targetHumanId: target.humanId,
        targetDeviceId: target.deviceId,
      });
    } finally {
      this.closeState(opened);
    }
  }

  async prepareCommit(input: {
    readonly active: SealedProviderStateV2;
  }): Promise<PreparedProviderCommitV2> {
    const active = snapshotSealedProviderState(input.active);
    await this.ready;
    const opened = this.openState(active, "active");
    try {
      this.assertGroupActive(opened.state);
      return await this.prepareProposals(opened, [], {
        operation: "update",
        targetHumanId: opened.humanId,
        targetDeviceId: this.vault.deviceId,
      });
    } finally {
      this.closeState(opened);
    }
  }

  async prepareIncoming(input: {
    readonly active: SealedProviderStateV2;
    readonly publicResult: ProviderPublicTransitionV2;
  }): Promise<LocalProviderCandidateV2> {
    const active = snapshotSealedProviderState(input.active);
    const transition = this.validateTransition(
      input.publicResult,
    );
    await this.ready;
    const opened = this.openState(active, "active");
    let processed:
      | Awaited<ReturnType<typeof processMessage>>
      | undefined;
    try {
      this.assertGroupActive(opened.state);
      if (!providerHeadsEqualV2(opened.head, transition.expectedHead)) {
        throw new V2ProviderStateError(
          "Incoming MLS commit does not match the exact expected public head",
        );
      }
      const message = decodeMessage(transition.commitBytes);
      if (
        message.wireformat !== "mls_private_message"
        && message.wireformat !== "mls_public_message"
      ) {
        throw new V2ProviderStateError("Expected an MLS commit message");
      }
      processed = await processMessage(
        message,
        opened.state,
        emptyPskIndex,
        acceptAll,
        this.impl,
      );
      if (processed.kind !== "newState") {
        throw new V2ProviderStateError(
          "MLS commit produced an application message",
        );
      }
      const actualRoster = this.rosterBytes(processed.newState);
      if (!equalBytes(actualRoster, transition.rosterBytes)) {
        throw new V2ProviderStateError(
          "Incoming MLS commit roster does not match public transition bytes",
        );
      }
      const nextHead = this.nextHead(
        transition.expectedHead,
        transition.commitBytes,
        transition.welcomeHash,
        actualRoster,
        processed.newState,
      );
      if (!providerHeadsEqualV2(nextHead, transition.nextHead)) {
        throw new V2ProviderStateError(
          "Incoming MLS commit does not match the exact next public head",
        );
      }
      return this.localCandidate(
        { state: processed.newState, humanId: opened.humanId, head: nextHead },
        transition.expectedHead,
        transition,
      );
    } finally {
      if (processed) {
        if (processed.kind === "applicationMessage") {
          processed.message.fill(0);
        }
        processed.consumed.forEach(zeroOutUint8Array);
        destroyClientState(processed.newState);
      }
      this.closeState(opened);
    }
  }

  async validatePreparedCandidate(input: {
    readonly active: SealedProviderStateV2;
    readonly prepared: PreparedProviderCommitV2;
  }): Promise<void> {
    const active = snapshotSealedProviderState(input.active);
    const prepared = Object.freeze({
      publicResult: this.validateTransition(
        input.prepared.publicResult,
      ),
      localCandidate: snapshotLocalCandidate(
        input.prepared.localCandidate,
      ),
    });
    await this.ready;
    const activeState = this.openState(active, "active");
    const transition = prepared.publicResult;
    let openedCandidate:
      | ReturnType<typeof openLocalProviderCandidateV2>
      | undefined;
    try {
      openedCandidate = openLocalProviderCandidateV2({
        vault: this.vault,
        candidate: prepared.localCandidate,
      });
      if (
        !providerPublicTransitionDigestMatchesV2(
          this.crypto,
          transition,
          openedCandidate.publicTransitionDigest,
        )
      ) {
        throw new V2ProviderStateError(
          "ts-mls prepared candidate does not match its public transition",
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
            "Applied ts-mls candidate does not match the active public head",
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
          "ts-mls prepared candidate does not match the active public head",
        );
      }
      const nested = candidatePayloadSnapshotV2(
        prepared.localCandidate,
        openedCandidate.payload,
      );
      let candidateState: OpenedMlsState | undefined;
      try {
        candidateState = this.openState(nested, "candidate");
        const actualRoster = this.rosterBytes(candidateState.state);
        const expectedNextHead = this.nextHead(
          transition.expectedHead,
          transition.commitBytes,
          transition.welcomeHash,
          actualRoster,
          candidateState.state,
        );
        if (
          !equalBytes(actualRoster, transition.rosterBytes)
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
            "ts-mls public transition does not match its sealed candidate",
          );
        }
      } finally {
        if (candidateState) this.closeState(candidateState);
        nested.ciphertext.fill(0);
      }
    } finally
    // the opened candidate's detached digest and payload; neither buffer escapes
    // validatePreparedCandidate, so their required wipe is unobservable.
    {
      if (openedCandidate) {
        destroyOpenedProviderCandidateStateV2(openedCandidate);
      }
      this.closeState(activeState);
    }
  }

  async prepareWelcome(input: {
    readonly joinState: SealedProviderStateV2;
    readonly publicResult: ProviderPublicTransitionV2;
  }): Promise<LocalProviderCandidateV2> {
    const joinState = snapshotSealedProviderState(input.joinState);
    const transition = this.validateTransition(
      input.publicResult,
    );
    await this.ready;
    const join = this.openJoinMaterial(joinState);
    let joined: ClientState | undefined;
    try {
      // validateTransition binds Domain and next epoch to expectedHead; exact
      // expected-head equality below therefore proves both Welcome coordinates.
      if (
        join.lifecycle !== "prepared"
        || !providerHeadsEqualV2(
          transition.expectedHead,
          join.expectedHead,
        )
      ) {
        throw new V2ProviderStateError(
          "MLS Welcome does not match the local join request",
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
          "MLS Welcome does not match its public commitment",
        );
      }
      const welcomeMessage = decodeMessage(transition.welcomeBytes);
      if (welcomeMessage.wireformat !== "mls_welcome") {
        throw new V2ProviderStateError("Expected an MLS Welcome");
      }
      joined = await joinGroup(
        welcomeMessage.welcome,
        decodeKeyPackageMessage(join.keyPackageBytes),
        join.privatePackage,
        emptyPskIndex,
        this.impl,
      );
      const actualRoster = this.rosterBytes(joined);
      if (!equalBytes(actualRoster, transition.rosterBytes)) {
        throw new V2ProviderStateError(
          "MLS Welcome roster does not match public transition bytes",
        );
      }
      const nextHead = this.nextHead(
        transition.expectedHead,
        transition.commitBytes,
        transition.welcomeHash,
        actualRoster,
        joined,
      );
      if (!providerHeadsEqualV2(nextHead, transition.nextHead)) {
        throw new V2ProviderStateError(
          "MLS Welcome does not match the exact next public head",
        );
      }
      return this.localCandidate(
        { state: joined, humanId: join.humanId, head: nextHead },
        transition.expectedHead,
        transition,
        join.joinId,
      );
    } finally
    // private-key frames are detached method-local copies; the exact wipe is
    // tested directly, but this ownership-boundary call is unobservable.
    {
      if (joined) destroyClientState(joined);
      this.destroyJoinSecrets(join);
    }
  }

  activateWelcome(input: {
    readonly candidate: LocalProviderCandidateV2;
    readonly joinState: SealedProviderStateV2;
  }): ProviderApplyResultV2 {
    const join = this.openJoinMaterial(input.joinState);
    let protectedCandidate:
      | ReturnType<typeof openLocalProviderCandidateV2>
      | undefined;
    try {
      protectedCandidate = openLocalProviderCandidateV2({
        vault: this.vault,
        candidate: input.candidate,
      });
      this.assertWelcomeCandidate(join, protectedCandidate.sourceId);
      if (join.lifecycle === "aborted") {
        throw new V2ProviderStateError("MLS Welcome join state was aborted");
      }
      if (protectedCandidate.lifecycle === "aborted") {
        throw new V2ProviderStateError("MLS Welcome candidate was aborted");
      }
      if (protectedCandidate.lifecycle === "applied") {
        throw new V2ProviderStateError("MLS Welcome was already activated");
      }
      const nested = candidatePayloadSnapshotV2(
        input.candidate,
        protectedCandidate.payload,
      );
      let candidateState: OpenedMlsState | undefined;
      try {
        candidateState = this.openState(nested, "candidate");
        if (
          !providerHeadsEqualV2(candidateState.head, input.candidate.nextHead)
        ) {
          throw new V2ProviderStateError(
            "MLS Welcome candidate does not match its next public head",
          );
        }
        const active = this.sealState("active", candidateState);
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
        nested.ciphertext.fill(0);
      }
    } finally
    // detached opened-candidate and decoded-join secret buffers; both exact wipes
    // are tested directly, but this call-site cleanup is unobservable.
    {
      if (protectedCandidate) {
        destroyOpenedProviderCandidateStateV2(protectedCandidate);
      }
      this.destroyJoinSecrets(join);
    }
  }

  abortWelcome(input: {
    readonly candidate: LocalProviderCandidateV2;
    readonly joinState: SealedProviderStateV2;
  }): ProviderAbortResultV2 {
    const join = this.openJoinMaterial(input.joinState);
    let protectedCandidate:
      | ReturnType<typeof openLocalProviderCandidateV2>
      | undefined;
    try {
      protectedCandidate = openLocalProviderCandidateV2({
        vault: this.vault,
        candidate: input.candidate,
      });
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
    } finally
    // detached opened-candidate and decoded-join secret buffers; both exact wipes
    // are tested directly, but this call-site cleanup is unobservable.
    {
      if (protectedCandidate) {
        destroyOpenedProviderCandidateStateV2(protectedCandidate);
      }
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
      return this.rosterBytes(opened.state);
    } finally {
      this.closeState(opened);
    }
  }

  async exportDomainRoots(
    active: SealedProviderStateV2,
  ): Promise<DomainRootsV2> {
    const snapshot = snapshotSealedProviderState(active);
    await this.ready;
    const opened = this.openState(snapshot, "active");
    try {
      if (opened.state.groupActiveState.kind === "removedFromGroup") {
        throw new V2ProviderStateError(
          "Removed MLS device cannot export the current Domain roots",
        );
      }
      this.assertGroupActive(opened.state);
      const exporter = (
        label: string,
        context: Uint8Array,
        length: number,
      ): Promise<Uint8Array> => mlsExporter(
        opened.state.keySchedule.exporterSecret,
        label,
        context,
        length,
        this.impl,
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
        "MLS Welcome candidates require the Welcome lifecycle",
      );
    }
    if (
      protectedCandidate.lifecycle === "aborted"
      || protectedCandidate.lifecycle === "stale"
    ) {
      destroyOpenedProviderCandidateStateV2(protectedCandidate);
      return Object.freeze({ status: "aborted" as const, active: input.active });
    }
    let activeState: OpenedMlsState | undefined;
    try {
      activeState = this.openState(input.active, "active");
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
      if (!providerHeadsEqualV2(activeState.head, candidate.expectedHead)) {
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
          "Applied MLS candidate cannot be replayed against its old head",
        );
      }
      const nested = candidatePayloadSnapshotV2(
        candidate,
        protectedCandidate.payload,
      );
      let candidateState: OpenedMlsState | undefined;
      try {
        candidateState = this.openState(nested, "candidate");
        if (!providerHeadsEqualV2(candidateState.head, candidate.nextHead)) {
          throw new V2ProviderStateError(
            "MLS candidate does not match its exact next public head",
          );
        }
        const active = this.sealState("active", candidateState);
        markLocalProviderCandidateV2({
          vault: this.vault,
          candidate,
          lifecycle: "applied",
        });
        return Object.freeze({ status: "applied" as const, active });
      } finally {
        if (candidateState) this.closeState(candidateState);
        nested.ciphertext.fill(0);
      }
    } finally
    // the opened candidate's detached digest and payload; neither buffer escapes
    // applyCandidate, so their required wipe is unobservable.
    {
      if (activeState) this.closeState(activeState);
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
          "MLS Welcome candidates require the Welcome lifecycle",
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
    } finally
    // the opened candidate's detached digest and payload; neither buffer escapes
    // abortCandidate, so their required wipe is unobservable.
    {
      destroyOpenedProviderCandidateStateV2(protectedCandidate);
    }
  }

  private async prepareProposals(
    opened: OpenedMlsState,
    proposals: readonly Proposal[],
    authorizationTarget: Readonly<{
      readonly operation: ProviderTransitionOperationV2;
      readonly targetHumanId: HumanId;
      readonly targetDeviceId: CryptoDeviceId;
    }>,
  ): Promise<PreparedProviderCommitV2> {
    const committed = await createCommit(
      { state: opened.state, cipherSuite: this.impl },
      {
        extraProposals: [...proposals],
        ratchetTreeExtension: true,
      },
    );
    try {
      const commitBytes = encodeMlsMessage(committed.commit);
      const welcomeBytes = committed.welcome
        ? encodeMlsMessage({
          wireformat: "mls_welcome",
          version: "mls10",
          welcome: committed.welcome,
        })
        : new Uint8Array();
      const rosterBytes = this.rosterBytes(committed.newState);
      const welcomeHash = this.crypto.hash(welcomeBytes);
      const nextHead = this.nextHead(
        opened.head,
        commitBytes,
        welcomeHash,
        rosterBytes,
        committed.newState,
      );
      const publicResult = cloneProviderPublicTransitionV2({
        formatVersion: V2_PROVIDER_TRANSITION_FORMAT_VERSION,
        providerId: this.id,
        domainId: opened.head.domainId,
        ...authorizationTarget,
        expectedHead: opened.head,
        nextHead,
        commitBytes,
        welcomeHash,
        welcomeBytes,
        rosterBytes,
      });
      const localCandidate = this.localCandidate(
        {
          state: committed.newState,
          humanId: opened.humanId,
          head: nextHead,
        },
        opened.head,
        publicResult,
      );
      return Object.freeze({ publicResult, localCandidate });
    } finally {
      committed.consumed.forEach(zeroOutUint8Array);
      destroyClientState(committed.newState);
    }
  }

  private initialHead(
    domainId: CryptoDomainId,
    state: ClientState,
    rosterBytes: Uint8Array,
  ): ProviderPublicHeadV2 {
    const epoch = epochFromState(state);
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
        this.publicGroupContextBytes(state),
      )),
    });
  }

  private nextHead(
    expected: ProviderPublicHeadV2,
    commitBytes: Uint8Array,
    welcomeHash: Uint8Array,
    rosterBytes: Uint8Array,
    state: ClientState,
  ): ProviderPublicHeadV2 {
    const epoch = epochFromState(state);
    if (Number(epoch) !== Number(expected.epoch) + 1) {
      throw new V2ProviderStateError(
        "MLS commit must advance the Domain epoch exactly once",
      );
    }
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
        encodeU64(epoch),
        this.publicGroupContextBytes(state),
      )),
    });
  }

  private publicGroupContextBytes(state: ClientState): Uint8Array {
    return concatV2(
      frameText(state.groupContext.cipherSuite),
      frame(state.groupContext.treeHash),
      frame(state.groupContext.confirmedTranscriptHash),
    );
  }

  private roster(state: ClientState): readonly RosterEntry[] {
    const roster: RosterEntry[] = [];
    const seenDevices = new Set<CryptoDeviceId>();
    for (const [nodeIndex, node] of state.ratchetTree.entries()) {
      if (node?.nodeType !== "leaf") continue;
      const identity = parseCredential(node.leaf.credential);
      if (seenDevices.has(identity.deviceId)) {
        throw new V2ProviderStateError(
          "Authenticated MLS roster contains a duplicate device identity",
        );
      }
      seenDevices.add(identity.deviceId);
      roster.push({
        leafIndex: (nodeIndex / 2) as LeafIndex,
        humanId: identity.humanId,
        deviceId: identity.deviceId,
      });
    }
    return Object.freeze(roster);
  }

  private rosterBytes(state: ClientState): Uint8Array {
    const roster = this.roster(state);
    if (roster.length > V2_LIMITS.deviceLeavesPerDomain) {
      throw new V2ProviderStateError(
        "MLS roster exceeds the 256-device Domain limit",
      );
    }
    if (
      new Set(roster.map((entry) => entry.humanId)).size
      > V2_LIMITS.humanParticipantsPerDomain
    ) {
      throw new V2ProviderStateError(
        "MLS roster exceeds the 64-Human Domain limit",
      );
    }
    return concatV2(
      frameText(ROSTER_DOMAIN),
      encodeU32(roster.length),
      ...roster.map((entry) =>
        concatV2(
          encodeU32(Number(entry.leafIndex)),
          frameText(entry.humanId),
          frameText(entry.deviceId),
        )
      ),
    );
  }

  private sealState(
    snapshotKind: "active" | "candidate",
    opened: MlsState,
  ): SealedProviderStateV2 {
    const stateBytes = encodeGroupState(opened.state);
    const plaintext = concatV2(
      frameText(STATE_DOMAIN),
      encodeU32(STATE_FORMAT_VERSION),
      frameText(opened.humanId),
      frame(opened.head.stateHash),
      frame(stateBytes),
    );
    try {
      return this.vault.seal(
        {
          providerId: this.id,
          domainId: opened.head.domainId,
          revision: opened.head.epoch,
          snapshotKind,
        },
        plaintext,
      );
    } finally {
      stateBytes.fill(0);
      plaintext.fill(0);
    }
  }

  private openState(
    snapshot: SealedProviderStateV2,
    snapshotKind: "active" | "candidate",
  ): OpenedMlsState {
    if (
      snapshot.providerId !== this.id
      || snapshot.deviceId !== this.vault.deviceId
      || snapshot.snapshotKind !== snapshotKind
    ) {
      throw new V2ProviderStateError(
        `Invalid ${snapshotKind} ts-mls snapshot coordinates`,
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
        `Unable to open ${snapshotKind} ts-mls snapshot`,
      );
    }
    try {
      let decoded:
        | Readonly<{
          readonly state: ClientState;
          readonly humanId: HumanId;
          readonly stateHash: Uint8Array;
          readonly encodedState: Uint8Array;
        }>
        | undefined;
      let decodedState: ClientState | undefined;
      try {
        decoded = decodeExact(plaintext, (reader) => {
          readExactDomain(reader, STATE_DOMAIN, "ts-mls state domain");
          reader.readVersion(STATE_FORMAT_VERSION);
          const ownerHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
          const stateHash = exactBytes(
            "ts-mls public state hash",
            reader.readFrame(HASH_BYTES),
            HASH_BYTES,
          );
          const encodedState = reader.readFrame(V2_PROVIDER_STATE_MAX_BYTES);
          const groupState = decodeGroupState(encodedState, 0);
          if (!groupState || groupState[1] !== encodedState.length) {
            throw new CanonicalDecodingError(
              "ts-mls group state is malformed or noncanonical",
            );
          }
          const state: ClientState = {
            ...groupState[0],
            clientConfig: defaultClientConfig,
          };
          decodedState = state;
          return {
            state,
            humanId: ownerHumanId,
            stateHash,
            encodedState,
          };
        });
        const groupId = new TextDecoder().decode(
          decoded.state.groupContext.groupId,
        );
        if (
          groupId !== snapshot.domainId
          || epochFromState(decoded.state) !== snapshot.revision
        ) {
          throw new V2ProviderStateError(
            "ts-mls state metadata does not match its sealed snapshot",
          );
        }
        if (decoded.state.groupActiveState.kind === "active") {
          const ownNodeIndex =
            Number(decoded.state.privatePath.leafIndex) * 2;
          const ownNode = decoded.state.ratchetTree[ownNodeIndex];
          if (ownNode?.nodeType !== "leaf") {
            throw new V2ProviderStateError(
              "Active ts-mls state has no authenticated own leaf",
            );
          }
          const ownIdentity = parseCredential(ownNode.leaf.credential);
          if (
            ownIdentity.deviceId !== this.vault.deviceId
            || ownIdentity.humanId !== decoded.humanId
          ) {
            throw new V2ProviderStateError(
              "Active ts-mls state identity does not match its device snapshot",
            );
          }
        }
        return Object.freeze({
          state: decoded.state,
          humanId: decoded.humanId,
          head: cloneProviderHeadV2({
            providerId: this.id,
            domainId: snapshot.domainId,
            epoch: snapshot.revision,
            stateHash: decoded.stateHash,
          }),
          stateFrame: decoded.encodedState,
          stateHashFrame: decoded.stateHash,
        });
      } catch (error) {
        if (decoded) {
          decoded.encodedState.fill(0);
          decoded.stateHash.fill(0);
          destroyClientState(decoded.state);
        } else if (decodedState) {
          destroyClientState(decodedState);
        }
        throw error;
      }
    } finally {
      plaintext.fill(0);
    }
  }

  private closeState(opened: OpenedMlsState): void {
    opened.stateFrame.fill(0);
    opened.stateHashFrame.fill(0);
    destroyClientState(opened.state);
  }

  private sealJoinMaterial(join: JoinMaterial): SealedProviderStateV2 {
    const plaintext = concatV2(
      frameText(JOIN_DOMAIN),
      encodeU32(STATE_FORMAT_VERSION),
      frameText(join.joinId),
      encodeU32(joinLifecycleCode(join.lifecycle)),
      frameText(join.humanId),
      frameText(join.deviceId),
      encodeProviderHead(join.expectedHead),
      frame(join.keyPackageBytes),
      frame(join.privatePackage.initPrivateKey),
      frame(join.privatePackage.hpkePrivateKey),
      frame(join.privatePackage.signaturePrivateKey),
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

  private openJoinMaterial(snapshot: SealedProviderStateV2): JoinMaterial {
    if (
      snapshot.providerId !== this.id
      || snapshot.deviceId !== this.vault.deviceId
      || snapshot.snapshotKind !== "candidate"
    ) {
      throw new V2ProviderStateError("Invalid local ts-mls join state");
    }
    const plaintext = this.vault.open(snapshot, {
      providerId: this.id,
      domainId: snapshot.domainId,
      revision: snapshot.revision,
      snapshotKind: "candidate",
    });
    if (!plaintext) {
      throw new V2ProviderStateError("Unable to open local ts-mls join state");
    }
    try {
      return decodeExact(plaintext, (reader) => {
        readExactDomain(reader, JOIN_DOMAIN, "ts-mls join state domain");
        reader.readVersion(STATE_FORMAT_VERSION);
        const joinId = reader.readText(V2_LIMITS.idBytes);
        const lifecycle = joinLifecycleFromCode(reader.readU32());
        const joiningHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
        const joiningDeviceId = cryptoDeviceId(
          reader.readText(V2_LIMITS.idBytes),
        );
        const expectedHead = decodeProviderHead(reader);
        if (
          joiningDeviceId !== this.vault.deviceId
          || expectedHead.providerId !== this.id
          || expectedHead.domainId !== snapshot.domainId
          || Number(expectedHead.epoch) + 1 !== Number(snapshot.revision)
        ) {
          throw new V2ProviderStateError(
            "Local ts-mls join state metadata mismatch",
          );
        }
        return {
          joinId,
          lifecycle,
          domainId: snapshot.domainId,
          humanId: joiningHumanId,
          deviceId: joiningDeviceId,
          expectedHead,
          keyPackageBytes: reader.readFrame(V2_PROVIDER_STATE_MAX_BYTES),
          privatePackage: {
            initPrivateKey: reader.readFrame(V2_PROVIDER_STATE_MAX_BYTES),
            hpkePrivateKey: reader.readFrame(V2_PROVIDER_STATE_MAX_BYTES),
            signaturePrivateKey: reader.readFrame(V2_PROVIDER_STATE_MAX_BYTES),
          },
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
      privatePackage: {
        initPrivateKey: new Uint8Array(join.privatePackage.initPrivateKey.length),
        hpkePrivateKey: new Uint8Array(join.privatePackage.hpkePrivateKey.length),
        signaturePrivateKey: new Uint8Array(
          join.privatePackage.signaturePrivateKey.length,
        ),
      },
    });
    if (tombstone.ciphertext.length !== snapshot.ciphertext.length) {
      throw new V2ProviderStateError(
        "Local ts-mls join tombstone length changed unexpectedly",
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
        "MLS Welcome candidate does not match its sealed join request",
      );
    }
  }

  private destroyJoinSecrets(join: JoinMaterial): void {
    join.keyPackageBytes.fill(0);
    destroyPrivateKeyPackage(join.privatePackage);
  }

  private localCandidate(
    next: MlsState,
    expectedHead: ProviderPublicHeadV2,
    publicTransition: ProviderPublicTransitionV2,
    sourceId?: string,
  ): LocalProviderCandidateV2 {
    const nested = this.sealState("candidate", next);
    try {
      return sealLocalProviderCandidateV2({
        crypto: this.crypto,
        vault: this.vault,
        providerId: this.id,
        domainId: next.head.domainId,
        expectedHead,
        nextHead: next.head,
        publicTransition,
        payload: nested.ciphertext,
        sourceId: sourceId ?? V2_PROVIDER_CANDIDATE_SOURCE_ID,
      });
    } finally {
      nested.ciphertext.fill(0);
    }
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
      || transition.rosterBytes.length > V2_LIMITS.namespaceKeyringBytes
      || !(transition.expectedHead.stateHash instanceof Uint8Array)
      || transition.expectedHead.stateHash.length !== HASH_BYTES
      || !(transition.nextHead.stateHash instanceof Uint8Array)
      || transition.nextHead.stateHash.length !== HASH_BYTES
    ) {
      throw new V2ProviderStateError(
        "ts-mls public transition is invalid",
      );
    }
    return cloneProviderPublicTransitionV2(transition);
  }

  private assertJoinRequest(request: MlsV2JoinRequestPublic): void {
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
    ) {
      throw new V2ProviderStateError("ts-mls join request is invalid");
    }
    cryptoDomainId(request.domainId);
    humanId(request.humanId);
    cryptoDeviceId(request.deviceId);
    domainEpoch(request.expectedHead.epoch);
  }

  private assertGroupActive(state: ClientState): void {
    if (state.groupActiveState.kind !== "active") {
      throw new V2ProviderStateError(
        "Removed or suspended MLS device cannot prepare a transition",
      );
    }
  }

}
