import {
  createAgentRuntimeGeneration,
  deduplicateAgentRuntimeDomains,
  openAgentRuntimeFromDomain,
  sealAgentRuntimeToDomain,
} from "../src/agent-runtime/domain-envelope.ts";
import {
  prepareAgentRuntimeHandoffChallenge,
  prepareAgentRuntimeHandoffResponse,
  prepareAgentRuntimeHandoffTarget,
  prepareAgentRuntimeManagerHandoffChallenge,
  prepareAgentRuntimeManagerHandoffResponse,
  prepareAgentRuntimeManagerHandoffTarget,
  type AgentRuntimeManagerHandoffAuthorityContextV1,
} from "../src/agent-runtime/runtime-handoff-v2.ts";
import {
  aggregateAgentRuntimeRotationV2,
  agentRuntimeConfigDekAadV2,
  agentRuntimeConfigInventoryCommitmentV2,
  destroyAgentRuntimeRotationSourceLocalV2,
  prepareAgentRuntimeRotationSourceV2,
  type AgentRuntimeManagerAuthorityContextV2,
} from "../src/agent-runtime/runtime-rotation-v2.ts";
import {
  authorizeAgentRuntimeInitializationWriteV2,
} from "../src/agent-runtime/initialization-authorized-write.ts";
import {
  agentRuntimeSignerPublicationForTesting,
} from "../src/testing/index.ts";
import {
  LatticeCrypto,
  manualClock,
  seededRng,
} from "../src/crypto/index.ts";
import { findOrCreateCryptoDomain } from "../src/domain/registry.ts";
import { participantDigest } from "../src/domain/participants.ts";
import {
  createNamespaceBinding,
  namespaceBindingHash,
  verifyNamespaceBinding,
  verifyNamespaceBindingProof,
} from "../src/namespace/bindings.ts";
import {
  appendNamespaceGeneration,
  createInitialNamespaceKeyrings,
  openNamespaceKeyring,
  sealNamespaceKeyring,
} from "../src/namespace/keyrings.ts";
import type { NamespaceKeyringPlaintextV2 } from "../src/namespace/types.ts";
import {
  mintGrantV2,
  openGrantV2ForOperation,
} from "../src/grant/authorization.ts";
import {
  recoveryKeyGeneration,
  recoveryPublicKeyDigest,
} from "../src/format/recovery-v2.ts";
import { serializeGrantV2 } from "../src/format/grant-v2.ts";
import {
  parseAgentRuntimeDomainEnvelope,
  serializeAgentRuntimeDomainEnvelope,
} from "../src/format/agent-runtime-v2.ts";
import { serializeNamespaceBinding } from "../src/format/namespace-binding-v2.ts";
import { serializeNamespaceKeyringEnvelope } from "../src/format/namespace-keyring-v2.ts";
import { createObjectAccessManifestV2 } from "../src/format/object-access-manifest-v2.ts";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../src/format/object-v2.ts";
import {
  enumerateGrantDomains,
  type GrantNamespaceCandidateV2,
} from "../src/grant/enumeration.ts";
import {
  decryptObjectThroughNamespaceV2,
  openObjectDekForNamespaceV2,
  wrapObjectDekForNamespaceV2,
} from "../src/object/namespace-envelope.ts";
import {
  assertEnvelopeAuthorizedV2,
  prepareObjectAccessManifestUpdateV2,
  verifyObjectAccessManifestChainV2,
} from "../src/object/access-manifest.ts";
import {
  encryptObjectPayloadV2,
} from "../src/object/payload.ts";
import {
  openHumanRecoveryArchiveV2,
  persistPublishedHumanRecoveryArchiveV2,
  publishHumanRecoveryArchiveV2,
  type HumanRecoveryInventoryItemV2,
  type HumanRecoveryKeyringSourceV2,
} from "../src/recovery/human-archive-v2.ts";
import { InMemoryV2Store } from "../src/storage/v2-store.ts";
import { prepareDomainEpochAdvanceV2 } from "../src/transition/domain-epoch-advance.ts";
import { prepareHumanNamespaceRebindV2 } from "../src/transition/namespace-rebind.ts";
import {
  coordinateProviderTransitionV2,
  type ProviderTransitionAuthorizationContextV2,
} from "../src/transition/provider-coordinator.ts";
import type {
  V2ProviderFixture,
  V2ProviderMatrixRow,
  V2ProviderSemantic,
  V2ProviderSemanticTransition,
} from "../src/testing/v2-matrix.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../src/v2-types/ids.ts";
import { V2_LIMITS } from "../src/v2-types/limits.ts";
import {
  opaqueBytes,
} from "../src/v2-types/opaque.ts";

export interface V2ScenarioResult {
  readonly assertions: number;
  readonly scenarioAssertions: number;
  readonly scenarioEvidence: readonly string[];
  readonly providerTransitions: number;
}

export interface V2ScenarioRunOptions {
  readonly seedOffset?: number;
}

interface ScenarioState {
  assertions: number;
  baselineAssertions: number;
  evidence: string[];
  providerTransitions: number;
}

export interface RequiredV2Scenario {
  readonly id: number;
  readonly name: string;
  run(
    provider: V2ProviderMatrixRow,
    options?: V2ScenarioRunOptions,
  ): Promise<V2ScenarioResult>;
}

function check(state: ScenarioState, condition: unknown, message: string): void {
  state.assertions += 1;
  state.evidence.push(message);
  if (!condition) throw new Error(message);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function providerTransitionAuthorizationV2() {
  return {
    authorizationRevision: authorizationRevision(0),
    resolveCurrentAuthorization:
      (context: ProviderTransitionAuthorizationContextV2) => ({
        ...context,
        currentHead: {
          ...context.currentHead,
          stateHash: context.currentHead.stateHash.slice(),
        },
        nextHead: {
          ...context.nextHead,
          stateHash: context.nextHead.stateHash.slice(),
        },
        publicTransitionDigest: context.publicTransitionDigest.slice(),
        authorized: true,
        actorStatus: "active" as const,
      }),
  };
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    if (needle.every((byte, index) => haystack[offset + index] === byte)) {
      return true;
    }
  }
  return false;
}

function nestedFieldNames(value: unknown): readonly string[] {
  if (
    typeof value !== "object"
    || value === null
    || value instanceof Uint8Array
  ) {
    return [];
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).flatMap((field) => [
    field,
    ...nestedFieldNames(record[field]),
  ]);
}

function nestedByteArrays(value: unknown): readonly Uint8Array[] {
  if (value instanceof Uint8Array) return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value as Record<string, unknown>)
    .flatMap(nestedByteArrays);
}

function candidate(
  namespace: string,
  domain: string,
  participants: readonly string[],
  epoch = 0,
  authorization = 0,
): GrantNamespaceCandidateV2 {
  return {
    namespaceId: namespaceId(namespace),
    participants: participants.map(humanId),
    domainId: cryptoDomainId(domain),
    domainEpoch: domainEpoch(epoch),
    agentAuthorizationRevision: authorizationRevision(authorization),
    namespaceAccessRevision: accessRevision(0),
  };
}

async function throws<T>(run: () => T | PromiseLike<T>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function providerFixture(
  row: V2ProviderMatrixRow,
  scenarioId: number,
  seedOffset = 0,
): Promise<{
  readonly fixture: V2ProviderFixture;
  readonly oldRoots: Awaited<ReturnType<V2ProviderFixture["provider"]["exportDomainRoots"]>>;
  readonly newRoots: Awaited<ReturnType<V2ProviderFixture["provider"]["exportDomainRoots"]>>;
  readonly state: ScenarioState;
}> {
  const fixture = await row.create({
    seed: 10_000 + scenarioId * 101 + row.id.length + seedOffset,
    domainId: cryptoDomainId(`scenario-${scenarioId}-${row.id}`),
  });
  const state: ScenarioState = {
    assertions: 0,
    baselineAssertions: 0,
    evidence: [],
    providerTransitions: 0,
  };
  const oldRoots = await fixture.provider.exportDomainRoots(fixture.active);
  const aborted = await fixture.provider.prepareCommit({
    active: fixture.active,
  });
  check(
    state,
    fixture.provider.abortCandidate(aborted.localCandidate).status === "aborted",
    "provider abort must be explicit",
  );
  check(
    state,
    sameBytes(
      (await fixture.provider.exportDomainRoots(fixture.active)).ai,
      oldRoots.ai,
    ),
    "preparation and abort must leave active roots unchanged",
  );
  const prepared = await fixture.provider.prepareCommit({
    active: fixture.active,
  });
  const applied = fixture.provider.applyCandidate({
    active: fixture.active,
    candidate: prepared.localCandidate,
  });
  check(state, applied.status === "applied", "provider transition must apply");
  check(
    state,
    Number(fixture.provider.publicHead(applied.active).epoch)
      === Number(fixture.provider.publicHead(fixture.active).epoch) + 1,
    "provider transition must advance exactly one epoch",
  );
  const duplicate = fixture.provider.applyCandidate({
    active: applied.active,
    candidate: prepared.localCandidate,
  });
  check(state, duplicate.status === "duplicate", "provider replay must be idempotent");
  const newRoots = await fixture.provider.exportDomainRoots(applied.active);
  check(state, !sameBytes(oldRoots.ai, newRoots.ai), "epoch must rotate AI root");
  state.providerTransitions += 1;
  state.baselineAssertions = state.assertions;
  return { fixture, oldRoots, newRoots, state };
}

async function providerSemanticTransition(
  row: V2ProviderMatrixRow,
  fixture: V2ProviderFixture,
  state: ScenarioState,
  semantic: V2ProviderSemantic,
  seed: number,
): Promise<V2ProviderSemanticTransition> {
  const transition = await row.exerciseSemanticTransition({
    fixture,
    semantic,
    seed,
  });
  check(
    state,
    Number(transition.afterHead.epoch)
      === Number(transition.beforeHead.epoch) + 1,
    "scenario provider transition must advance exactly one epoch",
  );
  check(
    state,
    !sameBytes(transition.beforeRoots.human, transition.afterRoots.human)
      && !sameBytes(transition.beforeRoots.ai, transition.afterRoots.ai),
    "scenario provider transition must rotate both Domain roots",
  );
  check(
    state,
    transition.actualSemantic === semantic
      && !sameBytes(transition.beforeRoster, transition.afterRoster),
    `provider:${row.id}:${semantic}`,
  );
  {
    if (semantic === "human-add" || semantic === "device-add") {
      check(
        state,
        transition.joiningPeerRoots !== null
          && sameBytes(
            transition.afterRoots.human,
            transition.joiningPeerRoots.human,
          )
          && sameBytes(
            transition.afterRoots.ai,
            transition.joiningPeerRoots.ai,
          ),
        "joining provider member must export the activated Domain roots",
      );
    } else {
      check(
        state,
        transition.removedPeerCannotExport,
        "removed provider member must lose current Domain-root export",
      );
      if (semantic === "human-remove") {
        check(
          state,
          transition.retainedPeerRoots !== null
            && sameBytes(
              transition.afterRoots.human,
              transition.retainedPeerRoots.human,
            )
            && sameBytes(
              transition.afterRoots.ai,
              transition.retainedPeerRoots.ai,
            ),
          "retained provider member must export the post-removal roots",
        );
      }
    }
  }
  state.providerTransitions += 1;
  return transition;
}

function keyringEntryKey(
  keyring: ReturnType<typeof createInitialNamespaceKeyrings>["human"],
  generation: number,
): Uint8Array {
  const entry = keyring.generations.find(
    (item) => Number(item.generation) === generation,
  );
  if (!entry) throw new Error(`missing Namespace generation ${generation}`);
  return entry.key;
}

function objectContext(id: string, keyClass: "human" | "ai" = "ai") {
  return {
    objectId: objectId(id),
    keyClass,
    objectType: "message",
    createdAt: unixTimestamp(1_800_000_000_000),
  } as const;
}

function envelopeContext(
  id: string,
  namespace: string,
  generation: number,
  revision = 0,
  keyClass: "human" | "ai" = "ai",
) {
  return {
    objectId: objectId(id),
    namespaceId: namespaceId(namespace),
    keyClass,
    keyGeneration: namespaceGeneration(generation),
    bindingRevisionAtWrap: accessRevision(revision),
  } as const;
}

function initialBinding(
  fixture: V2ProviderFixture,
  roots: { readonly human: Uint8Array; readonly ai: Uint8Array },
  namespace = "room-ab",
  active = fixture.active,
  committerDeviceId = cryptoDeviceId("alice-device"),
  signing = fixture.crypto.generateSigningKeyPair(),
) {
  const deviceId = committerDeviceId;
  const keyrings = createInitialNamespaceKeyrings(
    fixture.crypto,
    namespaceId(namespace),
  );
  const metadata = {
    domainId: fixture.provider.publicHead(active).domainId,
    domainEpoch: fixture.provider.publicHead(active).epoch,
    previousBindingHash: null,
    committerDeviceId: deviceId,
  } as const;
  const humanEnvelope = sealNamespaceKeyring({
    crypto: fixture.crypto,
    domainRoot: roots.human,
    keyring: keyrings.human,
    metadata,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto: fixture.crypto,
    domainRoot: roots.ai,
    keyring: keyrings.ai,
    metadata,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto: fixture.crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: signing.privateKey,
    resolveCurrentCommitter: () => signing.publicKey,
  });
  return { aiEnvelope, binding, deviceId, humanEnvelope, keyrings, signing };
}

async function grantProof(
  fixture: V2ProviderFixture,
  state: ScenarioState,
  roots: { readonly ai: Uint8Array },
  overrides: {
    epoch?: number;
    authorization?: number;
    active?: boolean;
    expectOpen?: boolean;
  } = {},
) {
  const crypto = fixture.crypto;
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const head = fixture.provider.publicHead(fixture.active);
  const epoch = domainEpoch(overrides.epoch ?? Number(head.epoch));
  const revision = authorizationRevision(overrides.authorization ?? 2);
  const grant = await mintGrantV2(crypto, {
    id: grantId(`grant-${head.domainId}`),
    issuingDeviceId: cryptoDeviceId("alice-device"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "invocation",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId("alice")],
    operations: ["decrypt"],
    issuedAt: 100,
    expiresAt: 200,
    coveredDomains: [{
      domainId: head.domainId,
      domainEpoch: epoch,
      agentAuthorizationRevision: revision,
      aiRoot: roots.ai,
    }],
    singleUse: false,
  });
  const authorization = {
    now: 101,
    expectedIssuingDeviceId: cryptoDeviceId("alice-device"),
    issuingDeviceHumanId: humanId("alice"),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: overrides.active ?? true,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "invocation",
    recipientEncryptionPrivateKey: recipient.privateKey,
    operation: "decrypt" as const,
    singleUseAvailable: true,
    namespaceId: namespaceId("room-ab"),
    namespaceAccessRevision: accessRevision(0),
    namespaceParticipants: [humanId("alice"), humanId("bob")],
    domainId: head.domainId,
    domainEpoch: epoch,
    agentAuthorizationRevision: revision,
    hostAllowsOperation: true,
  };
  const opened = await openGrantV2ForOperation(crypto, grant, authorization);
  check(
    state,
    opened !== null === (overrides.expectOpen ?? true),
    "grant open result must match current device authorization",
  );
  return { authorization, grant, issuer, opened, recipient };
}

function runtimeProof(
  fixture: V2ProviderFixture,
  state: ScenarioState,
  aiRoot: Uint8Array,
) {
  const crypto = fixture.crypto;
  const signing = crypto.generateSigningKeyPair();
  const runtime = createAgentRuntimeGeneration({
    crypto,
    agentId: agentId("genie"),
    generation: agentRuntimeGeneration(0),
  });
  const head = fixture.provider.publicHead(fixture.active);
  const context = {
    domainId: head.domainId,
    domainEpoch: head.epoch,
    agentAuthorizationRevision: authorizationRevision(1),
    committerDeviceId: cryptoDeviceId("alice-device"),
  };
  const envelope = sealAgentRuntimeToDomain({
    crypto,
    domainRoot: aiRoot,
    runtime,
    context,
    committerSigningPrivateKey: signing.privateKey,
    currentCommitterAuthorized: () => true,
  });
  const opened = openAgentRuntimeFromDomain({
    crypto,
    domainRoot: aiRoot,
    envelope,
    expected: {
      agentId: runtime.agentId,
      domainId: context.domainId,
      domainEpoch: context.domainEpoch,
      agentAuthorizationRevision: context.agentAuthorizationRevision,
      runtimeGeneration: runtime.generation,
      committerDeviceId: context.committerDeviceId,
    },
    resolveHistoricalCommitter: () => signing.publicKey,
  });
  check(state, sameBytes(opened.key, runtime.key), "Runtime envelope must restore exact key");
  return { context, envelope, opened, runtime, signing };
}

function manifestProof(fixture: V2ProviderFixture) {
  const { crypto } = fixture;
  const signing = crypto.generateSigningKeyPair();
  const deviceId = cryptoDeviceId("alice-device");
  const payloadHash = crypto.hash(new TextEncoder().encode("payload"));
  const payloadDek = crypto.randomBytes(32);
  const envelopeA = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespaceV2(
      crypto,
      crypto.randomBytes(32),
      envelopeContext("manifest-object", "room-a", 0),
      payloadDek,
    ),
  );
  const envelopeB = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespaceV2(
      crypto,
      crypto.randomBytes(32),
      envelopeContext("manifest-object", "room-b", 0),
      payloadDek,
    ),
  );
  const genesis = createObjectAccessManifestV2(
    crypto,
    {
      objectId: objectId("manifest-object"),
      payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [crypto.hash(envelopeA)],
      committerDeviceId: deviceId,
      hostAuthorizationRevision: authorizationRevision(1),
    },
    signing.privateKey,
  );
  const resolver = (id: string) =>
    id === deviceId ? signing.publicKey : null;
  const attached = prepareObjectAccessManifestUpdateV2(crypto, {
    currentManifestBytes: genesis.bytes,
    currentEnvelopeBytes: [envelopeA],
    trustedMinimumHead: {
      objectId: objectId("manifest-object"),
      payloadHash,
      accessRevision: accessRevision(0),
      manifestHash: genesis.hash,
    },
    proof: [],
    resolveSigningPublicKey: resolver,
    operation: { type: "attach", envelopeBytes: envelopeB },
    sourceAuthorized: true,
    targetAuthorized: true,
    committerDeviceId: deviceId,
    hostAuthorizationRevision: authorizationRevision(2),
    signingPrivateKey: signing.privateKey,
  });
  const detached = prepareObjectAccessManifestUpdateV2(crypto, {
    currentManifestBytes: attached.manifestBytes,
    currentEnvelopeBytes: attached.envelopeBytes,
    trustedMinimumHead: {
      objectId: objectId("manifest-object"),
      payloadHash,
      accessRevision: accessRevision(1),
      manifestHash: attached.manifestHash,
    },
    proof: [],
    resolveSigningPublicKey: resolver,
    operation: { type: "detach", envelopeBytes: envelopeB },
    sourceAuthorized: true,
    targetAuthorized: true,
    committerDeviceId: deviceId,
    hostAuthorizationRevision: authorizationRevision(3),
    signingPrivateKey: signing.privateKey,
  });
  const verified = verifyObjectAccessManifestChainV2(crypto, {
    manifestBytes: detached.manifestBytes,
    proof: [attached.manifestBytes],
    trustedMinimumHead: {
      objectId: objectId("manifest-object"),
      payloadHash,
      accessRevision: accessRevision(0),
      manifestHash: genesis.hash,
    },
    resolveSigningPublicKey: resolver,
  });
  return {
    attached,
    detached,
    envelopeA,
    envelopeB,
    genesis,
    payloadHash,
    resolver,
    verified,
  };
}

async function recoveryProof(
  fixture: V2ProviderFixture,
  roots: { readonly human: Uint8Array; readonly ai: Uint8Array },
) {
  const data = initialBinding(fixture, roots, "recovery-room");
  const trustedHead = verifyNamespaceBindingProof({
    crypto: fixture.crypto,
    anchor: null,
    proof: [data.binding],
    resolveHistoricalCommitter: () => data.signing.publicKey,
  });
  const targetHuman = humanId("alice");
  const kit = await fixture.crypto.createRecoveryKit();
  const recovery = await fixture.crypto.deriveEncryptionKeyPair(kit.secret);
  const generation = recoveryKeyGeneration(1);
  const trustedRecoveryKey = () => ({
    humanId: targetHuman,
    recoveryKeyId: kit.keyId,
    recoveryGeneration: generation,
    publicKeyDigest: recoveryPublicKeyDigest(recovery.publicKey),
  });
  const sources: readonly HumanRecoveryKeyringSourceV2[] = [
    {
      authorizedHumanId: targetHuman,
      trustedNamespaceHead: trustedHead,
      keyClass: "human",
      currentKeyringEnvelope: data.humanEnvelope,
      currentDomainRoot: roots.human,
      resolveHistoricalCommitter: () => data.signing.publicKey,
    },
    {
      authorizedHumanId: targetHuman,
      trustedNamespaceHead: trustedHead,
      keyClass: "ai",
      currentKeyringEnvelope: data.aiEnvelope,
      currentDomainRoot: roots.ai,
      resolveHistoricalCommitter: () => data.signing.publicKey,
    },
  ];
  const inventory: readonly HumanRecoveryInventoryItemV2[] = sources.map(
    ({ authorizedHumanId, trustedNamespaceHead, keyClass }) => ({
      authorizedHumanId,
      trustedNamespaceHead,
      keyClass,
    }),
  );
  const publicationInput = {
    crypto: fixture.crypto,
    humanId: targetHuman,
    recoveryKeyId: kit.keyId,
    recoveryGeneration: generation,
    recoveryPublicKey: recovery.publicKey,
    resolveTrustedCurrentRecoveryKey: trustedRecoveryKey,
    issuerDeviceId: data.deviceId,
    createdAt: unixTimestamp(1_800_000_000_000),
    sources,
    issuerSigningPrivateKey: data.signing.privateKey,
    resolveIssuerDevice: () => data.signing.publicKey,
  } as const;
  const published = await publishHumanRecoveryArchiveV2(publicationInput);
  const restored = await openHumanRecoveryArchiveV2({
    crypto: fixture.crypto,
    archiveBytes: published.archiveBytes,
    humanId: targetHuman,
    currentRecoveryKeyId: kit.keyId,
    currentRecoveryGeneration: generation,
    recoveryPrivateKey: recovery.privateKey,
    resolveTrustedCurrentRecoveryKey: trustedRecoveryKey,
    expectedInventory: inventory,
    resolveIssuerDevice: () => data.signing.publicKey,
  });
  return {
    data,
    inventory,
    publicationInput,
    published,
    recoveryPrivateKey: recovery.privateKey,
    recoveryKitSecret: kit.secret,
    restored,
    sources,
  };
}

async function runBehavior(
  id: number,
  row: V2ProviderMatrixRow,
  options: V2ScenarioRunOptions = {},
): Promise<V2ScenarioResult> {
  const { fixture, oldRoots, newRoots, state } = await providerFixture(
    row,
    id,
    options.seedOffset,
  );
  const crypto = fixture.crypto;

  if (id === 1) {
    const store = new InMemoryV2Store();
    let allocations = 0;
    const registrations: Awaited<
      ReturnType<typeof findOrCreateCryptoDomain>
    >[] = [];
    for (let index = 0; index < 50; index += 1) {
      registrations.push(await findOrCreateCryptoDomain(store, {
        participants: [humanId("alice"), humanId("bob")],
        createDomainId: () => {
          allocations += 1;
          return cryptoDomainId(`domain-ab-${index}`);
        },
        rosterBytes: Uint8Array.of(index),
      }));
    }
    check(
      state,
      registrations.every((entry) =>
        entry.domain.id === registrations[0]!.domain.id
      ) && (await store.listDomains()).length === 1,
      "fifty exact-set Namespace registrations must reuse one stored Domain",
    );
    check(
      state,
      registrations[0]?.status === "created"
        && registrations.slice(1).every((entry) => entry.status === "existing")
        && allocations === 1,
      "exact-set Domain reuse must allocate only the first Domain",
    );
  } else if (id === 2) {
    const enumeration = enumerateGrantDomains([humanId("alice")], [
      candidate("room-ab-1", "domain-ab", ["alice", "bob"]),
      candidate("room-ab-2", "domain-ab", ["alice", "bob"]),
      candidate("room-ac-1", "domain-ac", ["alice", "charlie"]),
      candidate("room-ac-2", "domain-ac", ["alice", "charlie"]),
    ]);
    check(
      state,
      enumeration.distinctDomainCount === 2
        && enumeration.domains.length === 2,
      "grant enumeration must emit one root per distinct covered Domain",
    );
    check(
      state,
      enumeration.coveredNamespaceCount === 4,
      "grant enumeration must preserve every covered Namespace",
    );
  } else if (id >= 3 && id <= 5) {
    const semantic = id === 5 ? "human-remove" : "human-add";
    const targetFixture = await row.create({
      seed:
        20_000 + id * 101 + row.id.length + (options.seedOffset ?? 0),
      domainId: cryptoDomainId(`scenario-${id}-${row.id}-target`),
    });
    const transition = await providerSemanticTransition(
      row,
      targetFixture,
      state,
      semantic,
      21_000 + id * 101 + row.id.length + (options.seedOffset ?? 0),
    );
    const source = initialBinding(
      fixture,
      oldRoots,
      "room-history",
    );
    const rebind = prepareHumanNamespaceRebindV2({
      crypto,
      reason: semantic === "human-remove" ? "human_remove" : "human_add",
      current: {
        anchor: null,
        proof: [source.binding],
        humanEnvelope: source.humanEnvelope,
        aiEnvelope: source.aiEnvelope,
        oldHumanDomainRoot: oldRoots.human,
        oldAiDomainRoot: oldRoots.ai,
      },
      target: {
        domainId: transition.afterHead.domainId,
        domainEpoch: transition.afterHead.epoch,
        humanDomainRoot: transition.afterRoots.human,
        aiDomainRoot: transition.afterRoots.ai,
      },
      committer: {
        deviceId: source.deviceId,
        signingPrivateKey: source.signing.privateKey,
      },
      resolveHistoricalCommitter: () => source.signing.publicKey,
      resolveSourceCommitter: () => source.signing.publicKey,
      resolveTargetCommitter: () => source.signing.publicKey,
    });
    const rings1 = openNamespaceKeyring({
      crypto,
      domainRoot: transition.afterRoots.ai,
      envelope: rebind.aiEnvelope,
      resolveHistoricalCommitter: () => source.signing.publicKey,
    });
    const before = encryptObjectPayloadV2(crypto, objectContext("before"), new TextEncoder().encode("before"));
    const after = encryptObjectPayloadV2(crypto, objectContext("after"), new TextEncoder().encode("after"));
    const wrappedBefore = wrapObjectDekForNamespaceV2(crypto, keyringEntryKey(rings1 as never, 0), envelopeContext("before", "room-history", 0), before.dek);
    const wrappedAfter = wrapObjectDekForNamespaceV2(crypto, keyringEntryKey(rings1 as never, 1), envelopeContext("after", "room-history", 1, 1), after.dek);
    check(state, rings1.generations.length === 2, "membership rebind must carry history and append a generation");
    check(state, decryptObjectThroughNamespaceV2(crypto, keyringEntryKey(rings1 as never, 0), wrappedBefore, before.payload) !== null, "retained generation must read history");
    check(state, decryptObjectThroughNamespaceV2(crypto, keyringEntryKey(rings1 as never, 1), wrappedAfter, after.payload) !== null, "new member must read current write");
    check(state, openObjectDekForNamespaceV2(crypto, keyringEntryKey(rings1 as never, 0), wrappedAfter) === null, "old generation must not open post-transition write");
  } else if (id === 6 || id === 7 || id === 9) {
    const semantic = id === 9 ? "device-add" : "human-add";
    const transition = await providerSemanticTransition(
      row,
      fixture,
      state,
      semantic,
      24_000 + id * 101 + row.id.length + (options.seedOffset ?? 0),
    );
    const proof = await grantProof(
      fixture,
      state,
      transition.beforeRoots,
      { epoch: Number(transition.beforeHead.epoch) },
    );
    const stale = await openGrantV2ForOperation(crypto, proof.grant, {
      ...proof.authorization,
      domainEpoch: transition.afterHead.epoch,
    });
    check(state, stale === null, "pre-transition grant must fail at a new Domain epoch");
    if (id === 7) {
      const fresh = await grantProof(
        fixture,
        state,
        transition.afterRoots,
        {
          epoch: Number(transition.afterHead.epoch),
          authorization: 3,
        },
      );
      check(state, fresh.grant.coveredDomains.length === 1, "fresh grant must cover retained Domain once");
      if (fresh.opened === null) throw new Error("expected opened fresh grant");
      const signing = crypto.generateSigningKeyPair();
      const keyrings = createInitialNamespaceKeyrings(
        crypto,
        namespaceId("fresh-grant-room"),
      );
      const retained = appendNamespaceGeneration(crypto, keyrings.ai);
      const envelope = sealNamespaceKeyring({
        crypto,
        domainRoot: fresh.opened.aiRoot,
        keyring: retained,
        metadata: {
          domainId: fresh.opened.domainId,
          domainEpoch: transition.afterHead.epoch,
          previousBindingHash: null,
          committerDeviceId: cryptoDeviceId("alice-device"),
        },
        committerSigningPrivateKey: signing.privateKey,
        resolveCurrentCommitter: () => signing.publicKey,
      });
      const grantKeyring = openNamespaceKeyring({
        crypto,
        domainRoot: fresh.opened.aiRoot,
        envelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      });
      check(
        state,
        grantKeyring.generations.length === 2,
        "fresh grant AI root must open retained and current generations",
      );
    } else if (id === 9) {
      const source = initialBinding(
        fixture,
        transition.beforeRoots,
        "device-add-room",
        transition.beforeActive,
      );
      const advanced = prepareDomainEpochAdvanceV2({
        crypto,
        reason: "device_add",
        domain: {
          domainId: source.binding.domainId,
          oldEpoch: source.binding.domainEpoch,
          nextEpoch: transition.afterHead.epoch,
          oldHumanRoot: transition.beforeRoots.human,
          oldAiRoot: transition.beforeRoots.ai,
          nextHumanRoot: transition.afterRoots.human,
          nextAiRoot: transition.afterRoots.ai,
        },
        affected: [{
          anchor: null,
          proof: [source.binding],
          humanEnvelope: source.humanEnvelope,
          aiEnvelope: source.aiEnvelope,
        }],
        committer: {
          deviceId: source.deviceId,
          signingPrivateKey: source.signing.privateKey,
        },
        resolveHistoricalCommitter: () => source.signing.publicKey,
        resolveSourceCommitter: () => source.signing.publicKey,
        resolveTargetCommitter: () => source.signing.publicKey,
      });
      const changed = advanced.namespaces[0]!;
      const human = openNamespaceKeyring({
        crypto,
        domainRoot: transition.afterRoots.human,
        envelope: changed.humanEnvelope,
        resolveHistoricalCommitter: () => source.signing.publicKey,
      });
      const ai = openNamespaceKeyring({
        crypto,
        domainRoot: transition.afterRoots.ai,
        envelope: changed.aiEnvelope,
        resolveHistoricalCommitter: () => source.signing.publicKey,
      });
      check(
        state,
        human.generations.length === 1 && ai.generations.length === 1,
        "device add must preserve current Namespace generations",
      );
    }
  } else if (id === 8) {
    const binding = initialBinding(fixture, oldRoots);
    const openedHuman = openNamespaceKeyring({
      crypto,
      domainRoot: oldRoots.human,
      envelope: binding.humanEnvelope,
      resolveHistoricalCommitter: () => binding.signing.publicKey,
    });
    check(state, openedHuman.keyClass === "human", "Human keyring must open to Human root");
    check(state, await throws(() => openNamespaceKeyring({
      crypto,
      domainRoot: oldRoots.ai,
      envelope: binding.humanEnvelope,
      resolveHistoricalCommitter: () => binding.signing.publicKey,
    })), "AI root must never open Human keyring");
  } else if (id === 10) {
    const transition = await providerSemanticTransition(
      row,
      fixture,
      state,
      "device-revoke",
      25_000 + row.id.length + (options.seedOffset ?? 0),
    );
    const signing = crypto.generateSigningKeyPair();
    const sources = ["room-revoke-a", "room-revoke-b"].map((namespace) =>
      initialBinding(
        fixture,
        transition.beforeRoots,
        namespace,
        transition.beforeActive,
        cryptoDeviceId("alice-device"),
        signing,
      )
    );
    const source = sources[0]!;
    const advanced = prepareDomainEpochAdvanceV2({
      crypto,
      reason: "device_revoke",
      domain: {
        domainId: source.binding.domainId,
        oldEpoch: source.binding.domainEpoch,
        nextEpoch: transition.afterHead.epoch,
        oldHumanRoot: transition.beforeRoots.human,
        oldAiRoot: transition.beforeRoots.ai,
        nextHumanRoot: transition.afterRoots.human,
        nextAiRoot: transition.afterRoots.ai,
      },
      affected: sources.map((affected) => ({
        anchor: null,
        proof: [affected.binding],
        humanEnvelope: affected.humanEnvelope,
        aiEnvelope: affected.aiEnvelope,
      })),
      committer: {
        deviceId: source.deviceId,
        signingPrivateKey: source.signing.privateKey,
      },
      resolveHistoricalCommitter: () => source.signing.publicKey,
      resolveSourceCommitter: () => source.signing.publicKey,
      resolveTargetCommitter: () => source.signing.publicKey,
    });
    const opened = advanced.namespaces.map((changed) => ({
      namespaceId: changed.binding.namespaceId,
      human: openNamespaceKeyring({
        crypto,
        domainRoot: transition.afterRoots.human,
        envelope: changed.humanEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }),
      ai: openNamespaceKeyring({
        crypto,
        domainRoot: transition.afterRoots.ai,
        envelope: changed.aiEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }),
    }));
    check(
      state,
      opened.length === 2
        && new Set(opened.map((entry) => entry.namespaceId)).size === 2,
      "device revoke must rotate every affected Namespace",
    );
    check(
      state,
      opened.every((entry) =>
        Number(entry.human.currentGeneration) === 1
        && Number(entry.ai.currentGeneration) === 1
      ),
      "device revoke must rotate both key classes in every affected Namespace",
    );
  } else if (id === 11 || id === 27) {
    const store = new InMemoryV2Store();
    const ids = ["room-one", "room-two"];
    const [first, second] = await Promise.all(ids.map((preferredId) =>
      findOrCreateCryptoDomain(store, {
        createDomainId: () => cryptoDomainId(preferredId),
        participants: [humanId("bob"), humanId("alice")],
        rosterBytes: new Uint8Array([1]),
      })));
    if (!first || !second) throw new Error("expected two Domain create results");
    check(state, first.domain.id === second.domain.id, "concurrent exact-set creators must converge");
    if (id === 11) {
      check(state, (await store.listDomains()).length === 1, "one room leaving cannot mutate the shared Domain record");
      const moving = initialBinding(fixture, oldRoots, "shared-room-moving");
      const peer = initialBinding(fixture, oldRoots, "shared-room-peer");
      const peerBindingBytes = serializeNamespaceBinding(peer.binding);
      const peerHumanBytes = serializeNamespaceKeyringEnvelope(
        peer.humanEnvelope,
      );
      const peerAiBytes = serializeNamespaceKeyringEnvelope(peer.aiEnvelope);
      const targetFixture = await row.create({
        seed: 30_000 + row.id.length + (options.seedOffset ?? 0),
        domainId: cryptoDomainId(`scenario-11-${row.id}-target`),
      });
      const targetTransition = await providerSemanticTransition(
        row,
        targetFixture,
        state,
        "human-add",
        31_000 + row.id.length + (options.seedOffset ?? 0),
      );
      const moved = prepareHumanNamespaceRebindV2({
        crypto,
        reason: "human_add",
        current: {
          anchor: null,
          proof: [moving.binding],
          humanEnvelope: moving.humanEnvelope,
          aiEnvelope: moving.aiEnvelope,
          oldHumanDomainRoot: oldRoots.human,
          oldAiDomainRoot: oldRoots.ai,
        },
        target: {
          domainId: targetTransition.afterHead.domainId,
          domainEpoch: targetTransition.afterHead.epoch,
          humanDomainRoot: targetTransition.afterRoots.human,
          aiDomainRoot: targetTransition.afterRoots.ai,
        },
        committer: {
          deviceId: moving.deviceId,
          signingPrivateKey: moving.signing.privateKey,
        },
        resolveHistoricalCommitter: () => moving.signing.publicKey,
        resolveSourceCommitter: () => moving.signing.publicKey,
        resolveTargetCommitter: () => moving.signing.publicKey,
      });
      check(
        state,
        moved.binding.domainId === targetTransition.afterHead.domainId,
        "one Room must rebind into the target Domain",
      );
      check(
        state,
        sameBytes(peerBindingBytes, serializeNamespaceBinding(peer.binding))
          && sameBytes(
            peerHumanBytes,
            serializeNamespaceKeyringEnvelope(peer.humanEnvelope),
          )
          && sameBytes(
            peerAiBytes,
            serializeNamespaceKeyringEnvelope(peer.aiEnvelope),
          ),
        "peer Namespace binding and keyring-envelope bytes must remain unchanged",
      );
    } else {
      let failedClosed = false;
      try {
        await findOrCreateCryptoDomain({
          findDomain: () => Promise.resolve({
            id: "collision-substitution",
            participantDigest: participantDigest([humanId("alice")]),
            participants: ["alice"],
            epoch: 0,
            authorizationRevision: 0,
            rosterBytes: new Uint8Array([1]),
          }),
          createDomainIfAbsent: () => Promise.reject(
            new Error("collision substitution must not create"),
          ),
        }, {
          participants: [humanId("bob")],
          createDomainId: () => cryptoDomainId("must-not-create"),
          rosterBytes: new Uint8Array([1]),
        });
      } catch (error) {
        failedClosed = error instanceof Error
          && error.message.includes("different participants");
      }
      check(
        state,
        failedClosed,
        "digest collision or hostile storage substitution must fail closed instead of aliasing exact participants",
      );
    }
  } else if (id === 12) {
    const payloadA = encryptObjectPayloadV2(
      crypto,
      objectContext("swap-a"),
      new TextEncoder().encode("a"),
    );
    const payloadB = encryptObjectPayloadV2(
      crypto,
      objectContext("swap-b"),
      new TextEncoder().encode("b"),
    );
    const sameDomainNamespaceKey = crypto.randomBytes(32);
    const envelopeA = wrapObjectDekForNamespaceV2(
      crypto,
      sameDomainNamespaceKey,
      envelopeContext("swap-a", "room-a", 0),
      payloadA.dek,
    );
    const envelopeB = wrapObjectDekForNamespaceV2(
      crypto,
      sameDomainNamespaceKey,
      envelopeContext("swap-b", "room-b", 0),
      payloadB.dek,
    );
    check(
      state,
      decryptObjectThroughNamespaceV2(
        crypto,
        sameDomainNamespaceKey,
        envelopeA,
        payloadA.payload,
      ) !== null
        && decryptObjectThroughNamespaceV2(
          crypto,
          sameDomainNamespaceKey,
          envelopeB,
          payloadB.payload,
        ) !== null,
      "each same-Domain Namespace envelope must open its own object",
    );
    check(
      state,
      decryptObjectThroughNamespaceV2(
        crypto,
        sameDomainNamespaceKey,
        envelopeB,
        payloadA.payload,
      ) === null
        && decryptObjectThroughNamespaceV2(
          crypto,
          sameDomainNamespaceKey,
          envelopeA,
          payloadB.payload,
        ) === null,
      "same-Domain Namespace envelope substitution must fail with the correct wrapping key",
    );
  } else if (id === 14) {
    const shared = encryptObjectPayloadV2(
      crypto,
      objectContext("shared"),
      new TextEncoder().encode("shared"),
    );
    const other = encryptObjectPayloadV2(
      crypto,
      objectContext("other"),
      new TextEncoder().encode("other"),
    );
    const keyA = crypto.randomBytes(32);
    const keyB = crypto.randomBytes(32);
    const envelopeA = wrapObjectDekForNamespaceV2(
      crypto,
      keyA,
      envelopeContext("shared", "room-a", 0),
      shared.dek,
    );
    const envelopeB = wrapObjectDekForNamespaceV2(
      crypto,
      keyB,
      envelopeContext("shared", "room-b", 0),
      shared.dek,
    );
    check(
      state,
      decryptObjectThroughNamespaceV2(
        crypto,
        keyA,
        envelopeA,
        shared.payload,
      ) !== null
        && decryptObjectThroughNamespaceV2(
          crypto,
          keyB,
          envelopeB,
          shared.payload,
        ) !== null,
      "one payload must remain readable through two differently bound Namespace envelopes",
    );
    check(
      state,
      !sameBytes(
        encodeNamespaceObjectEnvelopeV2(envelopeA),
        encodeNamespaceObjectEnvelopeV2(envelopeB),
      )
        && decryptObjectThroughNamespaceV2(
          crypto,
          keyA,
          envelopeA,
          other.payload,
        ) === null,
      "M:N envelopes must be byte-distinct and reject cross-object substitution",
    );
  } else if (id === 13) {
    const issued = enumerateGrantDomains([humanId("alice")], [
      candidate("room-a", "domain-a", ["alice"], 0, 1),
    ]);
    const later = enumerateGrantDomains([humanId("alice")], [
      candidate("room-a", "domain-a", ["alice"], 0, 2),
      candidate("room-b", "domain-b", ["alice"], 0, 1),
    ]);
    check(state, issued.distinctDomainCount === 1 && later.distinctDomainCount === 2, "newly eligible Domain must not be in old enumeration");
    check(state, later.domains[0]?.agentAuthorizationRevision === 2, "already-covered Domain must advance authorization revision");
    const proof = await grantProof(fixture, state, oldRoots, {
      authorization: 1,
    });
    check(
      state,
      await openGrantV2ForOperation(crypto, proof.grant, {
        ...proof.authorization,
        domainId: cryptoDomainId("newly-eligible-domain"),
        domainEpoch: domainEpoch(0),
        agentAuthorizationRevision: authorizationRevision(1),
      }) === null,
      "minted grant must not gain a newly eligible Domain",
    );
    check(
      state,
      await openGrantV2ForOperation(crypto, proof.grant, {
        ...proof.authorization,
        agentAuthorizationRevision: authorizationRevision(2),
      }) === null,
      "existing-Domain authorization revision advance must invalidate old grant",
    );
  } else if (id === 15) {
    const first = encryptObjectPayloadV2(crypto, objectContext("revision-1"), new TextEncoder().encode("one"));
    const second = encryptObjectPayloadV2(crypto, objectContext("revision-2"), new TextEncoder().encode("two"));
    check(state, !sameBytes(first.dek, second.dek), "new content revision must use a fresh DEK");
    const detachedKey = crypto.randomBytes(32);
    const attachedKey = crypto.randomBytes(32);
    const onlyRemaining = wrapObjectDekForNamespaceV2(crypto, attachedKey, envelopeContext("revision-2", "room-b", 0), second.dek);
    check(state, openObjectDekForNamespaceV2(crypto, detachedKey, onlyRemaining) === null, "detached Namespace must not read later revision");
    const manifest = manifestProof(fixture);
    check(state, await throws(() =>
      assertEnvelopeAuthorizedV2(crypto, manifest.verified, manifest.envelopeB)
    ), "detached envelope replay must fail against the current manifest");
  } else if (id === 16 || id === 28) {
    const revocation = id === 28
      ? await providerSemanticTransition(
        row,
        fixture,
        state,
        "device-revoke",
        38_000 + row.id.length + (options.seedOffset ?? 0),
      )
      : null;
    const data = initialBinding(
      fixture,
      revocation?.beforeRoots ?? oldRoots,
      `binding-${id}`,
      revocation?.beforeActive ?? fixture.active,
      revocation?.removedDeviceId ?? cryptoDeviceId("alice-device"),
    );
    const verified = verifyNamespaceBindingProof({
      crypto,
      anchor: null,
      proof: [data.binding],
      resolveHistoricalCommitter: () => data.signing.publicKey,
    });
    check(state, sameBytes(verified.bindingHash, namespaceBindingHash(data.binding)), "binding proof must retain exact head");
    const tampered = { ...data.binding, accessRevision: accessRevision(1) };
    check(state, await throws(() => verifyNamespaceBinding({
      crypto,
      binding: tampered,
      resolveHistoricalCommitter: () => data.signing.publicKey,
    })), "binding rollback/fork substitution must fail");
    if (id === 16) {
      const manifest = manifestProof(fixture);
      check(state, await throws(() => verifyObjectAccessManifestChainV2(crypto, {
        manifestBytes: manifest.genesis.bytes,
        proof: [],
        trustedMinimumHead: {
          objectId: objectId("manifest-object"),
          payloadHash: manifest.payloadHash,
          accessRevision: accessRevision(2),
          manifestHash: manifest.detached.manifestHash,
        },
        resolveSigningPublicKey: manifest.resolver,
      })), "object access manifest rollback must fail against retained anchor");
    }
    if (id === 28) {
      if (!revocation || revocation.removedDeviceId === null) {
        throw new Error("scenario 28 requires an actual revoked device");
      }
      const revokedDeviceId = revocation.removedDeviceId;
      const historical = verifyNamespaceBinding({
        crypto,
        binding: data.binding,
        resolveHistoricalCommitter: () => data.signing.publicKey,
      });
      const retained = openNamespaceKeyring({
        crypto,
        domainRoot: revocation.beforeRoots.human,
        envelope: data.humanEnvelope,
        resolveHistoricalCommitter: () => data.signing.publicKey,
      });
      check(
        state,
        historical && retained.generations.length === 1,
        "historical binding and retained keyring must survive actual device revocation",
      );
      check(state, await throws(() => sealNamespaceKeyring({
        crypto,
        domainRoot: revocation.afterRoots.human,
        keyring: data.keyrings.human,
        metadata: {
          domainId: data.binding.domainId,
          domainEpoch: revocation.afterHead.epoch,
          previousBindingHash: namespaceBindingHash(data.binding),
          committerDeviceId: revokedDeviceId,
        },
        committerSigningPrivateKey: data.signing.privateKey,
        resolveCurrentCommitter: () => null,
      })), "actually revoked device must fail current-roster transition authority");
    }
  } else if (id === 17) {
    const full = {
      formatVersion: 2 as const,
      namespaceId: namespaceId("room-full"),
      keyClass: "ai" as const,
      accessRevision: accessRevision(0),
      currentGeneration: namespaceGeneration(V2_LIMITS.retainedNamespaceGenerations - 1),
      generations: Array.from({ length: V2_LIMITS.retainedNamespaceGenerations }, (_, generation) => ({
        generation: namespaceGeneration(generation),
        key: new Uint8Array(32).fill(generation & 0xff),
      })),
    };
    check(state, await throws(() => appendNamespaceGeneration(crypto, full)), "4,096-generation ceiling must fail closed");
    check(state, full.generations.length === V2_LIMITS.retainedNamespaceGenerations, "ceiling failure must preserve retained history");
  } else if (id === 18) {
    const recovered = await recoveryProof(fixture, oldRoots);
    check(state, recovered.restored.length === 2, "recovery must restore both authorized key classes");
    check(
      state,
      recovered.restored.every(
        (keyring) => keyring.namespaceId === namespaceId("recovery-room"),
      ),
      "recovery must restore only the authorized Namespace inventory",
    );
    check(
      state,
      await throws(() => openHumanRecoveryArchiveV2({
        crypto,
        archiveBytes: recovered.published.archiveBytes,
        humanId: humanId("alice"),
        currentRecoveryKeyId:
          recovered.publicationInput.recoveryKeyId,
        currentRecoveryGeneration:
          recovered.publicationInput.recoveryGeneration,
        recoveryPrivateKey: new Uint8Array(32),
        resolveTrustedCurrentRecoveryKey:
          recovered.publicationInput.resolveTrustedCurrentRecoveryKey,
        expectedInventory: [
          ...recovered.inventory,
          {
            authorizedHumanId: humanId("alice"),
            trustedNamespaceHead: recovered.inventory[0]!.trustedNamespaceHead,
            keyClass: "human",
          },
        ],
        resolveIssuerDevice: () => recovered.data.signing.publicKey,
      })),
      "unauthorized or duplicate recovery inventory must fail closed",
    );
  } else if (id === 19) {
    const store = new InMemoryV2Store();
    const sentinel = new TextEncoder().encode("PLAINTEXT-SENTINEL");
    const encryptedPayload = encryptObjectPayloadV2(
      crypto,
      objectContext("opaque-object"),
      sentinel,
    );
    await store.putObject({
      objectId: "opaque-object",
      payloadBytes: opaqueBytes(
        "encrypted-payload",
        encodeEncryptedPayloadV2(encryptedPayload.payload),
      ),
    });
    const runtime = runtimeProof(fixture, state, oldRoots.ai);
    const runtimeEnvelopeBytes =
      serializeAgentRuntimeDomainEnvelope(runtime.envelope);
    const emptyConfigInventory =
      agentRuntimeConfigInventoryCommitmentV2({
        crypto,
        agentId: runtime.runtime.agentId,
        runtimeGeneration: runtime.runtime.generation,
        activeConfigObjects: [],
      });
    const runtimeState = {
      runtime: {
        agentId: runtime.runtime.agentId,
        authorizationRevision:
          runtime.context.agentAuthorizationRevision,
        runtimeGeneration: runtime.runtime.generation,
      },
      configInventory: emptyConfigInventory,
      configObjects: [],
      domainEnvelopes: [{
        agentId: runtime.runtime.agentId,
        domainId: runtime.context.domainId,
        domainEpoch: runtime.context.domainEpoch,
        agentAuthorizationRevision:
          runtime.context.agentAuthorizationRevision,
        runtimeGeneration: runtime.runtime.generation,
        committerDeviceId: runtime.context.committerDeviceId,
        envelopeHash: crypto.hash(runtimeEnvelopeBytes),
        envelopeBytes: opaqueBytes(
          "agent-runtime-domain-envelope",
          runtimeEnvelopeBytes,
        ),
      }],
      challengeConsumptions: [],
    };
    const runtimeSignerPublication =
      agentRuntimeSignerPublicationForTesting({
        state: runtimeState.runtime,
        transitionKind: "initialization",
      });
    await store.putAgentRuntimeAtomicStateIfAbsent(
      authorizeAgentRuntimeInitializationWriteV2({
        state: runtimeState,
        authorization: {
          context: {
            purpose: "persist-agent-runtime-initialization",
            operationId: runtimeSignerPublication.operationId,
            expectedState: runtimeState.runtime,
            expectedManager: {
              managerHumanId:
                runtimeSignerPublication.managerHumanId,
              managerAuthorizationRevision:
                runtimeSignerPublication.managerAuthorizationRevision,
              managerDeviceId:
                runtimeSignerPublication.managerDeviceId,
            },
            configInventory: runtimeState.configInventory,
            expectedDomains: [runtime.context],
          },
          currentManager: {
            managerHumanId: runtimeSignerPublication.managerHumanId,
            managerAuthorizationRevision:
              runtimeSignerPublication.managerAuthorizationRevision,
            managerDeviceId: runtimeSignerPublication.managerDeviceId,
          },
          currentManagerSigningPublicKey: runtime.signing.publicKey,
          authorizedDomains: [{
            ...runtime.context,
            committerSigningPublicKey: runtime.signing.publicKey,
          }],
        },
        signerPublication: runtimeSignerPublication,
      }),
    );
    const storedGrantProof = await grantProof(
      fixture,
      state,
      oldRoots,
    );
    const storedGrantId =
      `grant-${fixture.provider.publicHead(fixture.active).domainId}`;
    await store.putGrant({
      grantId: storedGrantId,
      grantBytes: opaqueBytes(
        "grant",
        serializeGrantV2(storedGrantProof.grant),
      ),
      consumed: false,
    });
    const recovered = await recoveryProof(fixture, oldRoots);
    await persistPublishedHumanRecoveryArchiveV2({
      crypto: fixture.crypto,
      storage: store,
      prepared: recovered.published,
      resolveTrustedCurrentRecoveryKey:
        recovered.publicationInput.resolveTrustedCurrentRecoveryKey,
      resolveIssuerDevice:
        recovered.publicationInput.resolveIssuerDevice,
    });
    const forbiddenSecrets = [
      sentinel,
      encryptedPayload.dek,
      runtime.runtime.key,
      runtime.signing.privateKey,
      storedGrantProof.issuer.privateKey,
      storedGrantProof.recipient.privateKey,
      recovered.recoveryPrivateKey,
      recovered.recoveryKitSecret,
      recovered.data.signing.privateKey,
      ...recovered.data.keyrings.human.generations.map((entry) => entry.key),
      ...recovered.data.keyrings.ai.generations.map((entry) => entry.key),
      oldRoots.human,
      oldRoots.ai,
    ];
    const containsForbiddenSecret = (value: unknown) =>
      nestedByteArrays(value).some((bytes) =>
        forbiddenSecrets.some((secret) =>
          sameBytes(bytes, secret) || containsBytes(bytes, secret)
        )
      );
    const snapshot = store.snapshot();
    check(
      state,
      !containsForbiddenSecret(snapshot),
      "complete reference-store snapshot must contain no forbidden secret class",
    );
    check(
      state,
      nestedFieldNames(snapshot).every((field) =>
        !new Set([
          "key",
          "privateKey",
          "domainRoot",
          "humanRoot",
          "aiRoot",
          "dek",
          "plaintext",
        ]).has(field)
      ),
      "complete reference-store snapshot shape must expose no secret-bearing field",
    );
    check(
      state,
      containsForbiddenSecret({
        otherwisePlausibleRecord: {
          ciphertext: crypto.randomBytes(32),
          leakedSecret: encryptedPayload.dek.slice(),
        },
      }),
      "reference-store secret scanner must detect a known nested leak",
    );
  } else if (id === 20) {
    const targets = Array.from({ length: 50 }, () => ({
      domainId: cryptoDomainId("domain-ab"),
      domainEpoch: domainEpoch(0),
      agentAuthorizationRevision: authorizationRevision(1),
    }));
    check(state, deduplicateAgentRuntimeDomains(targets).length === 1, "fifty same-Domain Rooms must use one Runtime envelope");
  } else if (id >= 21 && id <= 23) {
      const runtime = runtimeProof(fixture, state, oldRoots.ai);
    if (id === 21) {
      const targetSigning = crypto.generateSigningKeyPair();
      const targetContext = {
        domainId: cryptoDomainId("second-runtime-domain"),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(1),
        committerDeviceId: cryptoDeviceId("target-runtime-device"),
      };
      const secondEnvelope = sealAgentRuntimeToDomain({
        crypto,
        domainRoot: newRoots.ai,
        runtime: runtime.runtime,
        context: targetContext,
        committerSigningPrivateKey: targetSigning.privateKey,
        currentCommitterAuthorized: () => true,
      });
      const secondOpened = openAgentRuntimeFromDomain({
        crypto,
        domainRoot: newRoots.ai,
        envelope: secondEnvelope,
        expected: {
          agentId: runtime.runtime.agentId,
          domainId: targetContext.domainId,
          domainEpoch: targetContext.domainEpoch,
          agentAuthorizationRevision: targetContext.agentAuthorizationRevision,
          runtimeGeneration: runtime.runtime.generation,
          committerDeviceId: targetContext.committerDeviceId,
        },
        resolveHistoricalCommitter: () => targetSigning.publicKey,
      });
      check(state, sameBytes(secondOpened.key, runtime.opened.key), "two authorized Domains must load identical Runtime behavior");
      check(state, await throws(() => openAgentRuntimeFromDomain({
        crypto,
        domainRoot: newRoots.ai,
        envelope: runtime.envelope,
        expected: {
          agentId: runtime.runtime.agentId,
          domainId: runtime.context.domainId,
          domainEpoch: runtime.context.domainEpoch,
          agentAuthorizationRevision: runtime.context.agentAuthorizationRevision,
          runtimeGeneration: runtime.runtime.generation,
          committerDeviceId: runtime.context.committerDeviceId,
        },
        resolveHistoricalCommitter: () => runtime.signing.publicKey,
      })), "different Domain root must not open Runtime material");
      const managementKey = crypto.randomBytes(32);
      const managerRoot = crypto.randomBytes(32);
      const managementCiphertext = crypto.aeadSeal(
        managerRoot,
        managementKey,
        new TextEncoder().encode("management"),
      );
      check(
        state,
        crypto.aeadOpen(
          oldRoots.ai,
          managementCiphertext,
          new TextEncoder().encode("management"),
        ) === null
          && crypto.aeadOpen(
            newRoots.ai,
            managementCiphertext,
            new TextEncoder().encode("management"),
          ) === null,
        "Domain roots must not open manager-only Management material",
      );
    } else if (id === 22) {
      const activeConfigInventory =
        agentRuntimeConfigInventoryCommitmentV2({
          crypto,
          agentId: runtime.runtime.agentId,
          runtimeGeneration: runtime.runtime.generation,
          activeConfigObjects: [],
        });
      const plan = {
        operationId: `runtime-no-rotation-${row.id}`,
        agentId: runtime.runtime.agentId,
        oldAuthorizationRevision: authorizationRevision(1),
        newAuthorizationRevision: authorizationRevision(2),
        currentRuntimeGeneration: runtime.runtime.generation,
        runtimeRotationRequired: false,
        currentManager: null,
        activeConfigInventory,
        remainingDomains: [runtime.context],
      };
      let cryptoAccesses = 0;
      const forbiddenCrypto = new Proxy(crypto, {
        get() {
          cryptoAccesses += 1;
          throw new Error(
            "no-rotation preparation must not use cryptography",
          );
        },
      });
      const prepared = prepareAgentRuntimeRotationSourceV2({
        crypto: forbiddenCrypto,
        currentState: {
          agentId: runtime.runtime.agentId,
          authorizationRevision: plan.oldAuthorizationRevision,
          runtimeGeneration: runtime.runtime.generation,
        },
        plan,
      });
      check(
        state,
        prepared.kind === "unchanged",
        "a remaining Runtime-authorizing edge must take the no-rotation path",
      );
      check(
        state,
        cryptoAccesses === 0,
        "no-rotation preparation must call no cryptographic primitive",
      );
      if (prepared.kind !== "unchanged") {
        throw new Error("scenario 22 requires an unchanged Runtime");
      }
      check(
        state,
        prepared.expectedState.runtimeGeneration
          === runtime.runtime.generation
          && prepared.nextAuthorizationRevision
            === plan.newAuthorizationRevision,
        "no-rotation preparation must preserve generation and advance authorization",
      );
      check(
        state,
        !("sourceLocal" in prepared) && !("publicCandidate" in prepared),
        "no-rotation preparation must expose no Runtime or crypto candidate",
      );
      check(
        state,
        sameBytes(runtime.runtime.key, runtime.opened.key),
        "remaining Runtime-authorizing edge must preserve the existing Runtime",
      );
    } else {
      const staleGrant = await grantProof(
        fixture,
        state,
        oldRoots,
        { authorization: 2 },
      );
      const targetFixtures = await Promise.all([
        row.create({
          seed: 23_100 + row.id.length,
          domainId: cryptoDomainId(`scenario-23-${row.id}-remaining-a`),
        }),
        row.create({
          seed: 23_200 + row.id.length,
          domainId: cryptoDomainId(`scenario-23-${row.id}-remaining-z`),
        }),
      ]);
      const targetRoots = await Promise.all(targetFixtures.map((target) =>
        target.provider.exportDomainRoots(target.active)
      ));
      const targetSignings = [
        crypto.generateSigningKeyPair(),
        crypto.generateSigningKeyPair(),
      ] as const;
      const remainingDomains = targetFixtures.map((target, index) => {
        const head = target.provider.publicHead(target.active);
        return {
          domainId: head.domainId,
          domainEpoch: head.epoch,
          agentAuthorizationRevision: authorizationRevision(3),
          committerDeviceId: cryptoDeviceId(
            `scenario-23-${row.id}-target-${index}`,
          ),
        };
      });
      const configDeks = [
        crypto.randomBytes(32),
        crypto.randomBytes(32),
      ] as const;
      const activeConfigObjects = configDeks.map((dek, index) => {
        const metadata = {
          agentId: runtime.runtime.agentId,
          objectId: objectId(`scenario-23-config-${index}`),
          configRevision: authorizationRevision(index + 1),
          runtimeGeneration: runtime.runtime.generation,
        };
        return {
          ...metadata,
          wrappedDek: crypto.aeadSeal(
            runtime.runtime.key,
            dek,
            agentRuntimeConfigDekAadV2(metadata),
          ),
        };
      });
      const managerSigning = crypto.generateSigningKeyPair();
      const manager = {
        managerHumanId: humanId("scenario-23-manager"),
        managerAuthorizationRevision: authorizationRevision(8),
        managerDeviceId: cryptoDeviceId(
          `scenario-23-${row.id}-manager-device`,
        ),
      };
      const plan = {
        operationId: `runtime-rotation-${row.id}`,
        agentId: runtime.runtime.agentId,
        oldAuthorizationRevision: authorizationRevision(2),
        newAuthorizationRevision: authorizationRevision(3),
        currentRuntimeGeneration: runtime.runtime.generation,
        runtimeRotationRequired: true,
        currentManager: manager,
        activeConfigInventory: agentRuntimeConfigInventoryCommitmentV2({
          crypto,
          agentId: runtime.runtime.agentId,
          runtimeGeneration: runtime.runtime.generation,
          activeConfigObjects,
        }),
        remainingDomains,
      };
      const rotationManagerAuthority = (
        context: AgentRuntimeManagerAuthorityContextV2,
      ) => (
        context.operationId === plan.operationId
          && context.agentId === plan.agentId
          && context.oldAuthorizationRevision
            === plan.oldAuthorizationRevision
          && context.newAuthorizationRevision
            === plan.newAuthorizationRevision
          && context.currentRuntimeGeneration
            === plan.currentRuntimeGeneration
          && context.nextRuntimeGeneration
            === agentRuntimeGeneration(1)
          && context.managerHumanId === manager.managerHumanId
          && context.managerAuthorizationRevision
            === manager.managerAuthorizationRevision
          && context.managerDeviceId === manager.managerDeviceId
      ) ? managerSigning.publicKey : null;
      const handoffManagerAuthority = (
        context: AgentRuntimeManagerHandoffAuthorityContextV1,
      ) => (
        context.operationId === plan.operationId
          && context.agentId === plan.agentId
          && context.runtimeGeneration === agentRuntimeGeneration(1)
          && context.source.managerHumanId === manager.managerHumanId
          && context.source.managerAuthorizationRevision
            === manager.managerAuthorizationRevision
          && context.source.managerDeviceId === manager.managerDeviceId
      ) ? managerSigning.publicKey : null;
      const targetAuthority = (
        context: AgentRuntimeManagerHandoffAuthorityContextV1,
      ) => {
        const index = remainingDomains.findIndex((domain) =>
          domain.domainId === context.target.domainId
          && domain.domainEpoch === context.target.domainEpoch
          && domain.agentAuthorizationRevision
            === context.target.agentAuthorizationRevision
          && domain.committerDeviceId === context.target.committerDeviceId
        );
        return index < 0 ? null : targetSignings[index]!.publicKey;
      };
      const source = prepareAgentRuntimeRotationSourceV2({
        crypto,
        currentState: {
          agentId: runtime.runtime.agentId,
          authorizationRevision: plan.oldAuthorizationRevision,
          runtimeGeneration: runtime.runtime.generation,
        },
        currentRuntime: runtime.runtime,
        plan,
        activeConfigObjects,
        resolveCurrentManagerAuthority: rotationManagerAuthority,
        managerSigningPrivateKey: managerSigning.privateKey,
      });
      if (source.kind !== "rotated") {
        throw new Error("scenario 23 requires a rotated Runtime");
      }
      check(
        state,
        source.sourceLocal.runtime.generation
          === agentRuntimeGeneration(1)
          && !sameBytes(
            source.sourceLocal.runtime.key,
            runtime.runtime.key,
          ),
        "final-edge removal must create exactly one fresh Runtime generation",
      );
      check(
        state,
        source.publicCandidate.configRewraps.length
          === activeConfigObjects.length
          && source.publicCandidate.targetIntents.length
            === remainingDomains.length,
        "rotation manifest must cover the exact active config and Domain inventories",
      );

      const handoffs = await Promise.all(
        source.publicCandidate.targetIntents.map(async (intent, index) => {
          const ephemeral = await crypto.generateEncryptionKeyPair();
          const challenge =
            prepareAgentRuntimeManagerHandoffChallenge({
              crypto,
              plan: intent,
              targetEphemeralPublicKey: ephemeral.publicKey,
              targetCommitterSigningPrivateKey:
                targetSignings[index]!.privateKey,
              resolveCurrentTargetCommitter: targetAuthority,
              ttlMs: 60_000,
            });
          const response =
            await prepareAgentRuntimeManagerHandoffResponse({
              crypto,
              challengeBytes: challenge.challengeBytes,
              expectedPlan: intent,
              freshRuntime: source.sourceLocal.runtime,
              managerSigningPrivateKey: managerSigning.privateKey,
              resolveCurrentManagerAuthority: handoffManagerAuthority,
              resolveCurrentTargetCommitter: targetAuthority,
            });
          const completion =
            await prepareAgentRuntimeManagerHandoffTarget({
              crypto,
              challengeBytes: challenge.challengeBytes,
              responseBytes: response,
              expectedPlan: intent,
              trustedChallengeState: {
                challengeHash: challenge.challengeHash,
                consumed: false,
              },
              targetEphemeralPrivateKey: ephemeral.privateKey,
              targetDomainRoot: targetRoots[index]!.ai,
              targetCommitterSigningPrivateKey:
                targetSignings[index]!.privateKey,
              resolveCurrentManagerAuthority: handoffManagerAuthority,
              resolveCurrentTargetCommitter: targetAuthority,
            });
          return { challenge, completion };
        }),
      );
      check(
        state,
        !sameBytes(
          handoffs[0]!.challenge.challengeHash,
          handoffs[1]!.challenge.challengeHash,
        )
          && !sameBytes(
            handoffs[0]!.completion.targetReceiptSignature,
            handoffs[1]!.completion.targetReceiptSignature,
          ),
        "each remaining Domain must produce a separate handoff and target receipt",
      );
      const atomic = aggregateAgentRuntimeRotationV2({
        crypto,
        publicCandidate: source.publicCandidate,
        completedTargets: handoffs.map((handoff) => handoff.completion),
        resolveCurrentManagerAuthority: rotationManagerAuthority,
        resolveCurrentTargetCommitter: targetAuthority,
      });
      check(
        state,
        atomic.nextState.authorizationRevision
          === plan.newAuthorizationRevision
          && atomic.nextState.runtimeGeneration
            === source.sourceLocal.runtime.generation
          && atomic.configRewraps.length === activeConfigObjects.length
          && atomic.domainEnvelopes.length === remainingDomains.length,
        "atomic aggregate must advance state only with complete config and Domain coverage",
      );

      for (let index = 0; index < activeConfigObjects.length; index += 1) {
        const current = activeConfigObjects[index]!;
        const openedDek = crypto.aeadOpen(
          source.sourceLocal.runtime.key,
          atomic.configRewraps[index]!.nextWrappedDek.ciphertext,
          agentRuntimeConfigDekAadV2({
            agentId: current.agentId,
            objectId: current.objectId,
            configRevision: current.configRevision,
            runtimeGeneration: source.sourceLocal.runtime.generation,
          }),
        );
        check(
          state,
          openedDek !== null && sameBytes(openedDek, configDeks[index]!),
          "every active config DEK must open under the fresh Runtime only",
        );
        openedDek?.fill(0);
      }

      for (let index = 0; index < atomic.domainEnvelopes.length; index += 1) {
        const record = atomic.domainEnvelopes[index]!;
        const envelope = parseAgentRuntimeDomainEnvelope(
          record.envelopeBytes.ciphertext,
        );
        const opened = openAgentRuntimeFromDomain({
          crypto,
          domainRoot: targetRoots[index]!.ai,
          envelope,
          expected: envelope,
          resolveHistoricalCommitter: () =>
            targetSignings[index]!.publicKey,
        });
        check(
          state,
          sameBytes(opened.key, source.sourceLocal.runtime.key),
          "every remaining Domain must open the same fresh Runtime",
        );
        opened.key.fill(0);
      }

      check(state, await throws(() => openAgentRuntimeFromDomain({
        crypto,
        domainRoot: oldRoots.ai,
        envelope: runtime.envelope,
        expected: {
          agentId: runtime.runtime.agentId,
          domainId: runtime.context.domainId,
          domainEpoch: runtime.context.domainEpoch,
          agentAuthorizationRevision: runtime.context.agentAuthorizationRevision,
          runtimeGeneration: source.sourceLocal.runtime.generation,
          committerDeviceId: runtime.context.committerDeviceId,
        },
        resolveHistoricalCommitter: () => runtime.signing.publicKey,
      })), "stale Runtime envelope must not open new generation");
      check(
        state,
        await openGrantV2ForOperation(crypto, staleGrant.grant, {
          ...staleGrant.authorization,
          agentAuthorizationRevision: plan.newAuthorizationRevision,
        }) === null,
        "a stale pre-rotation grant must fail current authorization",
      );

      const serverArtifacts = {
        publicCandidate: source.publicCandidate,
        atomic,
      };
      const forbiddenFields = new Set([
        "runtime",
        "key",
        "domainRoot",
        "privateKey",
        "dek",
        "aiRoot",
        "humanRoot",
      ]);
      check(
        state,
        nestedFieldNames(serverArtifacts)
          .every((field) => !forbiddenFields.has(field)),
        "server rotation artifacts must contain no secret-bearing field",
      );
      const secrets = [
        runtime.runtime.key,
        source.sourceLocal.runtime.key,
        managerSigning.privateKey,
        ...configDeks,
        ...targetRoots.flatMap((roots) => [roots.ai, roots.human]),
        ...targetSignings.map((signing) => signing.privateKey),
      ];
      check(
        state,
        nestedByteArrays(serverArtifacts).every((bytes) =>
          secrets.every((secret) =>
            !sameBytes(bytes, secret) && !containsBytes(bytes, secret)
          )
        ),
        "server rotation artifacts must not contain Runtime, Domain, DEK, or private-key bytes",
      );
      destroyAgentRuntimeRotationSourceLocalV2(source.sourceLocal);
      check(
        state,
        source.sourceLocal.runtime.key.every((byte) => byte === 0),
        "source-local fresh Runtime must be explicitly destroyable after aggregation",
      );
    }
  } else if (id === 24) {
    const autonomousWork = { status: "pending" as "pending" | "running" };
    const store = new InMemoryV2Store();
    const inactive = await grantProof(fixture, state, oldRoots, {
      active: false,
      expectOpen: false,
    });
    const denied = await openGrantV2ForOperation(crypto, inactive.grant, inactive.authorization);
    if (denied !== null) autonomousWork.status = "running";
    check(state, denied === null, "no active device authorization must deny grant");
    check(
      state,
      autonomousWork.status === "pending",
      "missing device authorization must leave autonomous work pending",
    );
    check(state, !(await store.getAgentRuntimeAtomicState("genie")), "denial must create no persistent server key");
  } else if (id === 25) {
    const runtime = runtimeProof(fixture, state, oldRoots.ai);
    const handoffClock = manualClock(1_000_000);
    const handoffCrypto = new LatticeCrypto(
      seededRng(25_000 + row.id.length),
      handoffClock,
    );
    const sourceSigning = runtime.signing;
    const targetSigning = crypto.generateSigningKeyPair();
    const targetEphemeral = await crypto.generateEncryptionKeyPair();
    const plan = {
      operationId: "handoff-25",
      agentId: runtime.runtime.agentId,
      runtimeGeneration: runtime.runtime.generation,
      source: runtime.context,
      target: {
        domainId: cryptoDomainId("target-domain"),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(1),
        committerDeviceId: cryptoDeviceId("target-device"),
      },
    };
    const resolver = (context: { role: "source" | "target" }) =>
      context.role === "source" ? sourceSigning.publicKey : targetSigning.publicKey;
    const challenge = prepareAgentRuntimeHandoffChallenge({
      crypto: handoffCrypto,
      plan,
      targetEphemeralPublicKey: targetEphemeral.publicKey,
      targetCommitterSigningPrivateKey: targetSigning.privateKey,
      resolveCurrentCommitter: resolver,
      ttlMs: 60_000,
    });
    const response = await prepareAgentRuntimeHandoffResponse({
      crypto: handoffCrypto,
      challengeBytes: challenge.challengeBytes,
      expectedPlan: plan,
      sourceDomainRoot: oldRoots.ai,
      sourceEnvelope: runtime.envelope,
      resolveHistoricalSourceCommitter: () => sourceSigning.publicKey,
      sourceCommitterSigningPrivateKey: sourceSigning.privateKey,
      resolveCurrentCommitter: resolver,
    });
    const target = await prepareAgentRuntimeHandoffTarget({
      crypto: handoffCrypto,
      challengeBytes: challenge.challengeBytes,
      responseBytes: response,
      expectedPlan: plan,
      trustedChallengeState: { challengeHash: challenge.challengeHash, consumed: false },
      targetEphemeralPrivateKey: targetEphemeral.privateKey,
      targetDomainRoot: newRoots.ai,
      targetCommitterSigningPrivateKey: targetSigning.privateKey,
      resolveCurrentCommitter: resolver,
    });
    check(state, target.targetEnvelope.domainId === plan.target.domainId, "opaque handoff must create target Domain envelope");
    check(state, await throws(() => prepareAgentRuntimeHandoffTarget({
      crypto: handoffCrypto,
      challengeBytes: challenge.challengeBytes,
      responseBytes: response,
      expectedPlan: plan,
      trustedChallengeState: { challengeHash: challenge.challengeHash, consumed: true },
      targetEphemeralPrivateKey: targetEphemeral.privateKey,
      targetDomainRoot: newRoots.ai,
      targetCommitterSigningPrivateKey: targetSigning.privateKey,
      resolveCurrentCommitter: resolver,
    })), "handoff replay must fail closed");
    for (const expectedPlan of [
      {
        ...plan,
        target: {
          ...plan.target,
          domainId: cryptoDomainId("wrong-target-domain"),
        },
      },
      {
        ...plan,
        target: {
          ...plan.target,
          agentAuthorizationRevision: authorizationRevision(2),
        },
      },
    ]) {
      check(
        state,
        await throws(() => prepareAgentRuntimeHandoffResponse({
          crypto: handoffCrypto,
          challengeBytes: challenge.challengeBytes,
          expectedPlan,
          sourceDomainRoot: oldRoots.ai,
          sourceEnvelope: runtime.envelope,
          resolveHistoricalSourceCommitter: () =>
            sourceSigning.publicKey,
          sourceCommitterSigningPrivateKey: sourceSigning.privateKey,
          resolveCurrentCommitter: resolver,
        })),
        "handoff must reject wrong Domain or authorization revision",
      );
    }
    check(
      state,
      await throws(() => prepareAgentRuntimeHandoffResponse({
        crypto: handoffCrypto,
        challengeBytes: challenge.challengeBytes,
        expectedPlan: plan,
        sourceDomainRoot: oldRoots.ai,
        sourceEnvelope: runtime.envelope,
        resolveHistoricalSourceCommitter: () => sourceSigning.publicKey,
        sourceCommitterSigningPrivateKey: sourceSigning.privateKey,
        resolveCurrentCommitter: ({ role }) =>
          role === "target" ? targetSigning.publicKey : null,
      })),
      "handoff must reject a missing current source committer",
    );
    handoffClock.advance(60_000);
    check(
      state,
      await throws(() => prepareAgentRuntimeHandoffTarget({
        crypto: handoffCrypto,
        challengeBytes: challenge.challengeBytes,
        responseBytes: response,
        expectedPlan: plan,
        trustedChallengeState: {
          challengeHash: challenge.challengeHash,
          consumed: false,
        },
        targetEphemeralPrivateKey: targetEphemeral.privateKey,
        targetDomainRoot: newRoots.ai,
        targetCommitterSigningPrivateKey: targetSigning.privateKey,
        resolveCurrentCommitter: resolver,
      })),
      "stale handoff challenge must fail closed",
    );
  } else if (id === 26) {
    const store = new InMemoryV2Store();
    const initialHead = fixture.provider.publicHead(fixture.active);
    const initialRoster = fixture.provider.publicRoster(fixture.active);
    const participants = [humanId("scenario-26-alice")];
    await store.createDomainIfAbsent({
      id: initialHead.domainId,
      participantDigest: participantDigest(participants),
      participants,
      epoch: Number(initialHead.epoch),
      authorizationRevision: 0,
      rosterBytes: initialRoster,
    });
    check(
      state,
      await store.putDomainProviderHeadIfAbsent(
        initialHead,
        initialRoster,
      ) === "inserted",
      "provider public head must initialize before transition CAS",
    );

    const abortedSemantic = await row.prepareSemanticTransition({
      fixture,
      semantic: "human-add",
      seed: 36_001 + row.id.length + (options.seedOffset ?? 0),
    });
    const aborted = abortedSemantic.prepared;
    check(
      state,
      abortedSemantic.actualSemantic === "human-add",
      `provider:${row.id}:human-add`,
    );
    check(
      state,
      fixture.provider.abortCandidate(aborted.localCandidate).status
        === "aborted",
      "prepared provider transition must abort",
    );
    const abortedResult = await coordinateProviderTransitionV2({
      storage: store,
      provider: fixture.provider,
      active: fixture.active,
      prepared: aborted,
      authorization: providerTransitionAuthorizationV2(),
    });
    check(
      state,
      abortedResult.status === "aborted",
      "aborted provider candidate must not reach storage CAS",
    );

    const stale = (await row.prepareSemanticTransition({
      fixture,
      semantic: "human-add",
      seed: 36_002 + row.id.length + (options.seedOffset ?? 0),
    })).prepared;
    const retry = (await row.prepareSemanticTransition({
      fixture,
      semantic: "human-add",
      seed: 36_003 + row.id.length + (options.seedOffset ?? 0),
    })).prepared;
    const winner = await coordinateProviderTransitionV2({
      storage: store,
      provider: fixture.provider,
      active: fixture.active,
      prepared: retry,
      authorization: providerTransitionAuthorizationV2(),
    });
    check(state, winner.status === "applied", "retry winner must apply");
    check(
      state,
      Number(fixture.provider.publicHead(winner.active).epoch)
        === Number(initialHead.epoch) + 1,
      "retry must advance exactly once",
    );
    const staleResult = await coordinateProviderTransitionV2({
      storage: store,
      provider: fixture.provider,
      active: fixture.active,
      prepared: stale,
      authorization: providerTransitionAuthorizationV2(),
    });
    check(
      state,
      staleResult.status === "stale",
      "losing provider candidate must observe stale CAS",
    );
    check(
      state,
      fixture.provider.publicHead(staleResult.active).epoch
        === initialHead.epoch,
      "stale provider candidate must preserve the prior active state",
    );
    const replay = await coordinateProviderTransitionV2({
      storage: store,
      provider: fixture.provider,
      active: winner.active,
      prepared: retry,
      authorization: providerTransitionAuthorizationV2(),
    });
    check(
      state,
      replay.status === "duplicate",
      "winning provider candidate replay must be idempotent",
    );
    check(
      state,
      (await store.getDomainProviderHead(initialHead.domainId))?.epoch
        === retry.publicResult.nextHead.epoch,
      "provider storage head must contain the single winning epoch",
    );
    state.providerTransitions += 1;
  } else if (id === 29) {
    const source = initialBinding(fixture, oldRoots, "rebind-object-room");
    const retainedKey = source.keyrings.ai.generations[0]!.key;
    const payload = encryptObjectPayloadV2(
      crypto,
      objectContext("rebind-object"),
      new TextEncoder().encode("retained-across-rebind"),
    );
    const wrapped = wrapObjectDekForNamespaceV2(
      crypto,
      retainedKey,
      envelopeContext("rebind-object", "rebind-object-room", 0),
      payload.dek,
    );
    const payloadBytes = payload.payload.ciphertext.slice();
    const wrappedBytes = wrapped.wrappedDek.slice();
    const targetFixture = await row.create({
      seed: 40_000 + row.id.length + (options.seedOffset ?? 0),
      domainId: cryptoDomainId(`scenario-29-${row.id}-target`),
    });
    const targetTransition = await providerSemanticTransition(
      row,
      targetFixture,
      state,
      "human-add",
      41_000 + row.id.length + (options.seedOffset ?? 0),
    );
    const moved = prepareHumanNamespaceRebindV2({
      crypto,
      reason: "human_add",
      current: {
        anchor: null,
        proof: [source.binding],
        humanEnvelope: source.humanEnvelope,
        aiEnvelope: source.aiEnvelope,
        oldHumanDomainRoot: oldRoots.human,
        oldAiDomainRoot: oldRoots.ai,
      },
      target: {
        domainId: targetTransition.afterHead.domainId,
        domainEpoch: targetTransition.afterHead.epoch,
        humanDomainRoot: targetTransition.afterRoots.human,
        aiDomainRoot: targetTransition.afterRoots.ai,
      },
      committer: {
        deviceId: source.deviceId,
        signingPrivateKey: source.signing.privateKey,
      },
      resolveHistoricalCommitter: () => source.signing.publicKey,
      resolveSourceCommitter: () => source.signing.publicKey,
      resolveTargetCommitter: () => source.signing.publicKey,
    });
    const retained = openNamespaceKeyring({
      crypto,
      domainRoot: targetTransition.afterRoots.ai,
      envelope: moved.aiEnvelope,
      resolveHistoricalCommitter: () => source.signing.publicKey,
    }).generations[0]!.key;
    const plaintext = decryptObjectThroughNamespaceV2(
      crypto,
      retained,
      wrapped,
      payload.payload,
    );
    check(
      state,
      plaintext !== null
        && new TextDecoder().decode(plaintext) === "retained-across-rebind",
      "retained pre-rebind envelope must remain readable after real rebind",
    );
    check(
      state,
      sameBytes(payloadBytes, payload.payload.ciphertext)
        && sameBytes(wrappedBytes, wrapped.wrappedDek),
      "real Namespace rebind must leave stored payload and wrapped DEK byte-identical",
    );
    check(
      state,
      await throws(() => encodeNamespaceObjectEnvelopeV2({
        ...wrapped,
        context: {
          ...wrapped.context,
          domainId: targetTransition.afterHead.domainId,
        },
      } as never)),
      "injecting Domain ID into the exact envelope fixture must be rejected",
    );
    check(
      state,
      await throws(() => encodeNamespaceObjectEnvelopeV2({
        ...wrapped,
        context: {
          ...wrapped.context,
          domainEpoch: targetTransition.afterHead.epoch,
        },
      } as never)),
      "injecting Domain epoch into the exact envelope fixture must be rejected",
    );
  } else if (id === 30) {
    const recovered = await recoveryProof(fixture, oldRoots);
    let hpkeCalls = 0;
    let randomCalls = 0;
    const originalSeal = crypto.sealTo.bind(crypto);
    const originalRandom = crypto.randomBytes.bind(crypto);
    crypto.sealTo = async (...args) => {
      hpkeCalls += 1;
      return originalSeal(...args);
    };
    crypto.randomBytes = (length) => {
      randomCalls += 1;
      return originalRandom(length);
    };
    check(
      state,
      await throws(() => publishHumanRecoveryArchiveV2({
        ...recovered.publicationInput,
        sources: Array.from(
          { length: V2_LIMITS.recoveryPackages + 1 },
          () => recovered.sources[0]!,
        ),
      })),
      "recovery package-count exhaustion must fail before publication",
    );
    check(state, hpkeCalls === 0, "limit exhaustion must fail before any HPKE output");
    check(state, randomCalls === 0, "limit exhaustion must fail before any random output");

    const generations = Object.freeze(
      Array.from(
        { length: V2_LIMITS.retainedNamespaceGenerations },
        (_, generation) => Object.freeze({
          generation: namespaceGeneration(generation),
          key: new Uint8Array(32).fill(generation & 0xff),
        }),
      ),
    );
    const largeSources: HumanRecoveryKeyringSourceV2[] = Array.from(
      { length: 375 },
      (_, index) => {
        const targetNamespaceId = namespaceId(
          `recovery-limit-${String(index).padStart(3, "0")}`,
        );
        const humanKeyring: NamespaceKeyringPlaintextV2 = {
          formatVersion: 2,
          namespaceId: targetNamespaceId,
          keyClass: "human",
          accessRevision: accessRevision(0),
          currentGeneration: namespaceGeneration(
            V2_LIMITS.retainedNamespaceGenerations - 1,
          ),
          generations,
        };
        const aiKeyring: NamespaceKeyringPlaintextV2 = {
          ...recovered.data.keyrings.ai,
          namespaceId: targetNamespaceId,
        };
        const metadata = {
          domainId: fixture.provider.publicHead(fixture.active).domainId,
          domainEpoch: fixture.provider.publicHead(fixture.active).epoch,
          previousBindingHash: null,
          committerDeviceId: recovered.data.deviceId,
        };
        const humanEnvelope = sealNamespaceKeyring({
          crypto,
          domainRoot: oldRoots.human,
          keyring: humanKeyring,
          metadata,
          committerSigningPrivateKey: recovered.data.signing.privateKey,
          resolveCurrentCommitter: () => recovered.data.signing.publicKey,
        });
        const aiEnvelope = sealNamespaceKeyring({
          crypto,
          domainRoot: oldRoots.ai,
          keyring: aiKeyring,
          metadata,
          committerSigningPrivateKey: recovered.data.signing.privateKey,
          resolveCurrentCommitter: () => recovered.data.signing.publicKey,
        });
        const binding = createNamespaceBinding({
          crypto,
          humanEnvelope,
          aiEnvelope,
          committerSigningPrivateKey: recovered.data.signing.privateKey,
          resolveCurrentCommitter: () => recovered.data.signing.publicKey,
        });
        return {
          authorizedHumanId: recovered.publicationInput.humanId,
          trustedNamespaceHead: verifyNamespaceBindingProof({
            crypto,
            anchor: null,
            proof: [binding],
            resolveHistoricalCommitter: () => recovered.data.signing.publicKey,
          }),
          keyClass: "human",
          currentKeyringEnvelope: humanEnvelope,
          currentDomainRoot: oldRoots.human,
          resolveHistoricalCommitter: () => recovered.data.signing.publicKey,
        };
      },
    );
    hpkeCalls = 0;
    randomCalls = 0;
    try {
      check(
        state,
        await throws(() => publishHumanRecoveryArchiveV2({
          ...recovered.publicationInput,
          sources: largeSources,
        })),
        "recovery aggregate-byte exhaustion must fail before publication",
      );
      check(state, hpkeCalls === 0, "aggregate limit must fail before any HPKE output");
      check(state, randomCalls === 0, "aggregate limit must fail before any random output");
    } finally {
      for (const entry of generations) entry.key.fill(0);
    }
    const store = new InMemoryV2Store();
    check(state, await store.getRecoveryArchive("alice") === null, "failed publication must leave no partial archive");
  }

  const scenarioEvidence = state.evidence.slice(state.baselineAssertions);
  return Object.freeze({
    assertions: state.assertions,
    scenarioAssertions: state.assertions - state.baselineAssertions,
    scenarioEvidence: Object.freeze(scenarioEvidence),
    providerTransitions: state.providerTransitions,
  });
}

const names = [
  "two and fifty Namespaces reuse Domain AB",
  "grant enumerates each covered Domain once",
  "AB to ABC grants complete retained history",
  "old AB material cannot read post-add generation",
  "ABC to AC preserves history and excludes future writes",
  "pre-transition grant fails after activation",
  "fresh grant reads retained and current AI content",
  "Agent cannot open Human-only material",
  "device add preserves generations and invalidates stale grants",
  "device revoke rotates affected Namespace generations",
  "one Room leaves a shared Domain without changing peers",
  "same-Domain Namespace envelope swap fails",
  "post-issuance eligibility cannot widen a grant",
  "one payload supports M:N Namespace envelopes",
  "detach denies reads and new revision uses fresh DEK",
  "binding and manifest rollback, fork, replay, and substitution fail",
  "4,096-generation ceiling preserves history",
  "recovery restores authorized history only",
  "reference store contains no usable plaintext secret",
  "fifty same-Domain Rooms use one Runtime envelope",
  "two Domains load identical Runtime but not Management",
  "remaining authorization edge preserves Runtime",
  "final authorization removal rotates Runtime globally",
  "missing device authorization leaves work pending without server key",
  "separate devices complete opaque Runtime handoff",
  "provider abort, stale CAS, and retry advance exactly once",
  "concurrent Domain create converges and digest collisions do not alias",
  "historical binding survives committer revocation",
  "pre-rebind envelope stays readable and byte-identical",
  "recovery limit exhaustion publishes nothing",
] as const;

export const requiredV2Scenarios: readonly RequiredV2Scenario[] =
  Object.freeze(names.map((name, index) => Object.freeze({
    id: index + 1,
    name,
    run: (
      provider: V2ProviderMatrixRow,
      options?: V2ScenarioRunOptions,
    ) => runBehavior(index + 1, provider, options),
  })));
