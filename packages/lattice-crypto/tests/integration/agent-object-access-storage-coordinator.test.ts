import { describe, expect, test } from "bun:test";
import {
  createAgentRuntimeInitializationSignerPublicationV1,
  encodeAgentRuntimeSignerPublicationV1,
  type AgentRuntimeSignerPublicationV1,
} from "../../src/agent-runtime/signer-publication-v1.ts";
import {
  sealAgentRuntimeToDomain,
} from "../../src/agent-runtime/domain-envelope.ts";
import {
  authorizeAgentRuntimeInitializationWriteV2,
} from "../../src/agent-runtime/initialization-authorized-write.ts";
import {
  agentRuntimeConfigInventoryCommitmentV2,
} from "../../src/agent-runtime/runtime-rotation-v2.ts";
import type {
  AgentRuntimeGenerationV2,
} from "../../src/agent-runtime/types.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { participantDigest } from "../../src/domain/participants.ts";
import {
  serializeAgentRuntimeDomainEnvelope,
} from "../../src/format/agent-runtime-v2.ts";
import {
  GRANT_V2_FORMAT_VERSION,
  GRANT_V2_SCHEME,
  serializeGrantV2,
} from "../../src/format/grant-v2.ts";
import {
  NAMESPACE_BINDING_FORMAT_VERSION,
  serializeNamespaceBinding,
} from "../../src/format/namespace-binding-v2.ts";
import {
  NAMESPACE_KEYRING_FORMAT_VERSION,
  serializeNamespaceKeyringEnvelope,
} from "../../src/format/namespace-keyring-v2.ts";
import {
  decodeObjectAccessManifestV2OrV3,
} from "../../src/format/object-access-manifest.ts";
import {
  decodeObjectAccessManifestV3,
} from "../../src/format/object-access-manifest-v3.ts";
import {
  decodeNamespaceObjectEnvelopeV2,
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {
  assertAuthenticPreparedAgentObjectAccessManifestGenesisV3,
  prepareAgentObjectAccessManifestGenesisV3,
  type PreparedAgentObjectAccessManifestGenesisV3,
} from "../../src/object/agent-access-manifest.ts";
import {
  persistPreparedAgentObjectAccessManifestGenesisV3,
} from "../../src/object/agent-storage-coordinator.ts";
import {
  authorizeObjectAccessWriteV2,
  consumeAuthorizedObjectAccessWriteV2,
  type AgentObjectAccessGenesisAuthorizationExpectationV3,
  type AuthorizedObjectAccessWriteV2,
  type ObjectAccessAuthorizationExpectationV2,
} from "../../src/object/authorized-write.ts";
import {
  wrapObjectDekForNamespaceV2,
} from "../../src/object/namespace-envelope.ts";
import {
  authorizeNamespaceBindingWriteV2,
} from "../../src/namespace/authorized-write.ts";
import {
  objectAccessStorageStateV2,
  type ObjectAccessStateCasStorageV2,
} from "../../src/object/storage-coordinator.ts";
import {
  assertObjectAccessAuthorizationExpectation,
} from "../../src/storage/v2-record-policy.ts";
import {
  InMemoryV2Store,
  type NamespaceBindingRecordV2,
  type NamespaceHeadV2,
} from "../../src/storage/v2-store.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import { opaqueBytes } from "../../src/v2-types/opaque.ts";
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
} from "../../src/v2-types/ids.ts";

function fixture(seed = 0x237_71) {
  const crypto = new LatticeCrypto(seededRng(seed));
  const runtime: AgentRuntimeGenerationV2 = {
    agentId: agentId("agent-object-writer"),
    keyClass: "runtime",
    generation: agentRuntimeGeneration(0),
    key: new Uint8Array(32).fill(0x71),
  };
  const manager = crypto.generateSigningKeyPair();
  const authorization = authorizationRevision(7);
  const signerPublication =
    createAgentRuntimeInitializationSignerPublicationV1({
      crypto,
      operationId: "operation-agent-object-runtime-init",
      publicState: {
        agentId: runtime.agentId,
        authorizationRevision: authorization,
        runtimeGeneration: runtime.generation,
        configInventory: {
          objectCount: 1,
          digest: new Uint8Array(32).fill(0x72),
        },
        domainEnvelopes: [],
      },
      runtime,
      manager: {
        managerHumanId: humanId("human-agent-manager"),
        managerAuthorizationRevision: authorizationRevision(4),
        managerDeviceId: cryptoDeviceId("device-agent-manager"),
      },
      managerSigningPrivateKey: manager.privateKey,
      resolveCurrentManagerAuthority: () => manager.publicKey,
    });
  const payloadBytes = encodeEncryptedPayloadV2({
    formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
    context: {
      objectId: objectId("object-agent-message"),
      keyClass: "ai",
      objectType: "conversation-message",
      createdAt: unixTimestamp(10),
    },
    ciphertext: new Uint8Array(64).fill(0x73),
  });
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespaceV2(
      crypto,
      new Uint8Array(32).fill(0x74),
      {
        objectId: objectId("object-agent-message"),
        namespaceId: namespaceId("namespace-agent-message"),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(2),
        bindingRevisionAtWrap: accessRevision(5),
      },
      new Uint8Array(32).fill(0x75),
    ),
  );
  const prepared = prepareAgentObjectAccessManifestGenesisV3(
    crypto,
    {
      objectId: "object-agent-message",
      payloadHash: crypto.hash(payloadBytes),
      envelopeBytes: [envelopeBytes],
      grant: {
        grantId: grantId("grant-agent-message"),
        grantHash: new Uint8Array(32).fill(0x76),
        useStatus: "reusable",
      },
      namespace: {
        namespaceId: "namespace-agent-message",
        accessRevision: 5,
        bindingHash: new Uint8Array(32).fill(0x77),
        domainId: cryptoDomainId("domain-agent-message"),
        domainEpoch: domainEpoch(3),
      },
      agentAuthorizationRevision: authorization,
      runtime,
      signerPublication,
    },
  );
  const decision = () => ({
    context: structuredClone(prepared.authority),
    grantAuthorized: true,
    namespaceAuthorized: true,
    domainAuthorized: true,
    agentAuthorized: true,
    hostAllowsOperation: true,
    currentRuntime: {
      agentId: runtime.agentId,
      authorizationRevision: authorization,
      runtimeGeneration: runtime.generation,
    },
    signerPublication: structuredClone(signerPublication),
    currentManagerSigningPublicKey: manager.publicKey.slice(),
  });
  return {
    crypto,
    runtime,
    manager,
    authorization,
    signerPublication,
    payloadBytes,
    envelopeBytes,
    prepared,
    decision,
  };
}

function durableNamespaceBinding(
  crypto: LatticeCrypto,
  revision: number,
  previousBindingHash: Uint8Array | null,
): NamespaceBindingRecordV2 {
  const namespace = namespaceId("namespace-agent-message");
  const domain = cryptoDomainId("domain-agent-message");
  const committerDevice = cryptoDeviceId("device-agent-manager");
  const envelope = (keyClass: "human" | "ai") =>
    serializeNamespaceKeyringEnvelope({
      formatVersion: NAMESPACE_KEYRING_FORMAT_VERSION,
      namespaceId: namespace,
      keyClass,
      domainId: domain,
      domainEpoch: domainEpoch(3),
      accessRevision: accessRevision(revision),
      currentGeneration: namespaceGeneration(revision),
      previousBindingHash,
      committerDeviceId: committerDevice,
      ciphertext: new Uint8Array(40).fill(
        0x30 + revision + (keyClass === "human" ? 1 : 2),
      ),
      signature: new Uint8Array(V2_LIMITS.signatureBytes).fill(
        0x40 + revision + (keyClass === "human" ? 1 : 2),
      ),
    });
  const humanEnvelope = envelope("human");
  const aiEnvelope = envelope("ai");
  const signedBindingBytes = serializeNamespaceBinding({
    formatVersion: NAMESPACE_BINDING_FORMAT_VERSION,
    namespaceId: namespace,
    domainId: domain,
    domainEpoch: domainEpoch(3),
    accessRevision: accessRevision(revision),
    humanCurrentGeneration: namespaceGeneration(revision),
    aiCurrentGeneration: namespaceGeneration(revision),
    previousBindingHash,
    humanKeyringEnvelopeHash: crypto.hash(humanEnvelope),
    aiKeyringEnvelopeHash: crypto.hash(aiEnvelope),
    committerDeviceId: committerDevice,
    signature: new Uint8Array(V2_LIMITS.signatureBytes).fill(
      0x50 + revision,
    ),
  });
  return {
    namespaceId: namespace,
    revision: accessRevision(revision),
    bindingHash: crypto.hash(signedBindingBytes),
    previousBindingHash,
    signedBindingBytes,
    humanKeyringEnvelope: opaqueBytes(
      "human-keyring-envelope",
      humanEnvelope,
    ),
    aiKeyringEnvelope: opaqueBytes(
      "ai-keyring-envelope",
      aiEnvelope,
    ),
  };
}

function durableNamespaceHead(
  binding: NamespaceBindingRecordV2,
): NamespaceHeadV2 {
  return {
    namespaceId: binding.namespaceId,
    accessRevision: binding.revision,
    bindingHash: binding.bindingHash,
    domainId: cryptoDomainId("domain-agent-message"),
    domainEpoch: domainEpoch(3),
  };
}

async function durableAgentGenesisFixture(
  seed = 0x237_81,
  options: Readonly<{
    consumeGrant?: boolean;
    grantCoveredAuthorizationRevision?: number;
    grantCoveredDomainEpoch?: number;
    grantCoveredDomainId?: string;
    grantSingleUse?: boolean;
    grantUseStatus?: "reusable" | "claimed-by-preflight";
    includeUnrelatedGrantDomain?: boolean;
    initializeRuntime?: boolean;
    includeUnrelatedRuntimeDomain?: boolean;
    runtimeEnvelopeAuthorizationRevision?: number;
    runtimeEnvelopeDomainEpoch?: number;
  }> = {},
) {
  const state = fixture(seed);
  const store = new InMemoryV2Store();
  const managerHuman = humanId("human-agent-manager");
  const managerDevice = cryptoDeviceId("device-agent-manager");
  const domain = cryptoDomainId("domain-agent-message");
  const namespace = namespaceId("namespace-agent-message");

  expect((await store.createDomainIfAbsent({
    id: domain,
    participantDigest: participantDigest([managerHuman]),
    participants: [managerHuman],
    epoch: domainEpoch(3),
    authorizationRevision: authorizationRevision(7),
    rosterBytes: new Uint8Array([1, 2, 3]),
  })).status).toBe("created");

  let previousHead: NamespaceHeadV2 | null = null;
  for (let revision = 0; revision <= 5; revision += 1) {
    const binding = durableNamespaceBinding(
      state.crypto,
      revision,
      previousHead?.bindingHash ?? null,
    );
    const next = durableNamespaceHead(binding);
    expect(await store.compareAndSwapNamespaceBindingAndHead(
      authorizeNamespaceBindingWriteV2({
        expected: previousHead,
        binding,
        next,
        authorization: {
          bindingCommitter: {
            purpose: "namespace-binding",
            namespaceId: namespace,
            domainId: domain,
            domainEpoch: domainEpoch(3),
            accessRevision: accessRevision(revision),
            committerDeviceId: managerDevice,
            previousBindingHash: previousHead?.bindingHash ?? null,
          },
          keyringCommitter: {
            purpose: "namespace-keyring-envelope",
            namespaceId: namespace,
            domainId: domain,
            domainEpoch: domainEpoch(3),
            accessRevision: accessRevision(revision),
            committerDeviceId: managerDevice,
            previousBindingHash: previousHead?.bindingHash ?? null,
          },
          committerSigningPublicKeyHash: state.crypto.hash(
            state.manager.publicKey,
          ),
        },
      }),
    )).toBe("applied");
    previousHead = next;
  }

  const runtimeEnvelope = sealAgentRuntimeToDomain({
    crypto: state.crypto,
    domainRoot: new Uint8Array(32).fill(0x61),
    runtime: state.runtime,
    context: {
      domainId: domain,
      domainEpoch: domainEpoch(options.runtimeEnvelopeDomainEpoch ?? 3),
      agentAuthorizationRevision: authorizationRevision(
        options.runtimeEnvelopeAuthorizationRevision
          ?? state.authorization,
      ),
      committerDeviceId: managerDevice,
    },
    committerSigningPrivateKey: state.manager.privateKey,
    currentCommitterAuthorized: () => true,
  });
  const runtimeEnvelopeBytes = serializeAgentRuntimeDomainEnvelope(
    runtimeEnvelope,
  );
  const runtimeDomainEnvelopes = [{
    agentId: runtimeEnvelope.agentId,
    domainId: runtimeEnvelope.domainId,
    domainEpoch: runtimeEnvelope.domainEpoch,
    agentAuthorizationRevision:
      runtimeEnvelope.agentAuthorizationRevision,
    runtimeGeneration: runtimeEnvelope.runtimeGeneration,
    committerDeviceId: runtimeEnvelope.committerDeviceId,
    envelopeHash: state.crypto.hash(runtimeEnvelopeBytes),
    envelopeBytes: opaqueBytes(
      "agent-runtime-domain-envelope",
      runtimeEnvelopeBytes,
    ),
  }];
  if (options.includeUnrelatedRuntimeDomain === true) {
    const unrelated = sealAgentRuntimeToDomain({
      crypto: state.crypto,
      domainRoot: new Uint8Array(32).fill(0x64),
      runtime: state.runtime,
      context: {
        domainId: cryptoDomainId("domain-agent-noise"),
        domainEpoch: domainEpoch(3),
        agentAuthorizationRevision: state.authorization,
        committerDeviceId: managerDevice,
      },
      committerSigningPrivateKey: state.manager.privateKey,
      currentCommitterAuthorized: () => true,
    });
    const unrelatedBytes = serializeAgentRuntimeDomainEnvelope(unrelated);
    runtimeDomainEnvelopes.push({
      agentId: unrelated.agentId,
      domainId: unrelated.domainId,
      domainEpoch: unrelated.domainEpoch,
      agentAuthorizationRevision: unrelated.agentAuthorizationRevision,
      runtimeGeneration: unrelated.runtimeGeneration,
      committerDeviceId: unrelated.committerDeviceId,
      envelopeHash: state.crypto.hash(unrelatedBytes),
      envelopeBytes: opaqueBytes(
        "agent-runtime-domain-envelope",
        unrelatedBytes,
      ),
    });
  }
  const runtimeState = {
    runtime: {
      agentId: state.runtime.agentId,
      authorizationRevision: state.authorization,
      runtimeGeneration: state.runtime.generation,
    },
    configInventory: agentRuntimeConfigInventoryCommitmentV2({
      crypto: state.crypto,
      agentId: state.runtime.agentId,
      runtimeGeneration: state.runtime.generation,
      activeConfigObjects: [],
    }),
    configObjects: [],
    domainEnvelopes: runtimeDomainEnvelopes,
    challengeConsumptions: [],
  } as const;
  if (options.initializeRuntime !== false) {
    expect(await store.putAgentRuntimeAtomicStateIfAbsent(
      authorizeAgentRuntimeInitializationWriteV2({
        state: runtimeState,
        authorization: {
          context: {
            purpose: "persist-agent-runtime-initialization",
            operationId: state.signerPublication.operationId,
            expectedState: runtimeState.runtime,
            expectedManager: {
              managerHumanId: state.signerPublication.managerHumanId,
              managerAuthorizationRevision:
                state.signerPublication.managerAuthorizationRevision,
              managerDeviceId: state.signerPublication.managerDeviceId,
            },
            configInventory: runtimeState.configInventory,
            expectedDomains: runtimeDomainEnvelopes.map((envelope) => ({
              domainId: envelope.domainId,
              domainEpoch: envelope.domainEpoch,
              agentAuthorizationRevision:
                envelope.agentAuthorizationRevision,
              committerDeviceId: envelope.committerDeviceId,
            })),
          },
          currentManager: {
            managerHumanId: state.signerPublication.managerHumanId,
            managerAuthorizationRevision:
              state.signerPublication.managerAuthorizationRevision,
            managerDeviceId: state.signerPublication.managerDeviceId,
          },
          currentManagerSigningPublicKey: state.manager.publicKey,
          authorizedDomains: runtimeDomainEnvelopes.map((envelope) => ({
            domainId: envelope.domainId,
            domainEpoch: envelope.domainEpoch,
            agentAuthorizationRevision:
              envelope.agentAuthorizationRevision,
            committerDeviceId: envelope.committerDeviceId,
            committerSigningPublicKey: state.manager.publicKey,
          })),
        },
        signerPublication: state.signerPublication,
      }),
    )).toBe("inserted");
  }

  const grantUseStatus = options.grantUseStatus ?? "reusable";
  const coveredDomains = [{
    domainId: cryptoDomainId(options.grantCoveredDomainId ?? domain),
    domainEpoch: domainEpoch(options.grantCoveredDomainEpoch ?? 3),
    agentAuthorizationRevision: authorizationRevision(
      options.grantCoveredAuthorizationRevision ?? state.authorization,
    ),
  }];
  if (options.includeUnrelatedGrantDomain === true) {
    coveredDomains.push({
      domainId: cryptoDomainId("domain-agent-noise"),
      domainEpoch: domainEpoch(3),
      agentAuthorizationRevision: state.authorization,
    });
  }
  const grantWire = serializeGrantV2({
    formatVersion: GRANT_V2_FORMAT_VERSION,
    id: grantId("grant-agent-message"),
    issuingDeviceId: managerDevice,
    recipientAgentId: state.runtime.agentId,
    recipientKeyId: "invocation-agent-object",
    scope: [managerHuman],
    operations: ["encrypt"],
    issuedAt: 1,
    expiresAt: 10,
    coveredDomains,
    encryptedSecret: new Uint8Array(40).fill(0x62),
    scheme: GRANT_V2_SCHEME,
    signature: new Uint8Array(V2_LIMITS.signatureBytes).fill(0x63),
    singleUse: options.grantSingleUse
      ?? (grantUseStatus === "claimed-by-preflight"),
    consumed: false,
  });
  await store.putGrant({
    grantId: "grant-agent-message",
    grantBytes: opaqueBytes("grant", grantWire),
    consumed: false,
  });
  if (
    options.consumeGrant
      ?? (grantUseStatus === "claimed-by-preflight")
  ) {
    expect(await store.consumeGrant("grant-agent-message")).not.toBeNull();
  }
  await store.putObject({
    objectId: "object-agent-message",
    payloadBytes: opaqueBytes("encrypted-payload", state.payloadBytes),
  });

  const prepared = prepareAgentObjectAccessManifestGenesisV3(
    state.crypto,
    {
      objectId: "object-agent-message",
      payloadHash: state.crypto.hash(state.payloadBytes),
      envelopeBytes: [state.envelopeBytes],
      grant: {
        grantId: "grant-agent-message",
        grantHash: state.crypto.hash(grantWire),
        useStatus: grantUseStatus,
      },
      namespace: {
        namespaceId: namespace,
        accessRevision: accessRevision(5),
        bindingHash: previousHead!.bindingHash,
        domainId: domain,
        domainEpoch: domainEpoch(3),
      },
      agentAuthorizationRevision: state.authorization,
      runtime: state.runtime,
      signerPublication: state.signerPublication,
    },
  );
  const decision = () => ({
    context: structuredClone(prepared.authority),
    grantAuthorized: true,
    namespaceAuthorized: true,
    domainAuthorized: true,
    agentAuthorized: true,
    hostAllowsOperation: true,
    currentRuntime: structuredClone(runtimeState.runtime),
    signerPublication: structuredClone(state.signerPublication),
    currentManagerSigningPublicKey: state.manager.publicKey.slice(),
  });
  return { ...state, store, prepared, decision };
}

type DurableAgentGenesisFixture = Awaited<
  ReturnType<typeof durableAgentGenesisFixture>
>;

function authorizeDurableAgentGenesis(
  state: DurableAgentGenesisFixture,
  input: Readonly<{
    context?: DurableAgentGenesisFixture["prepared"]["authority"];
    signerPublication?: AgentRuntimeSignerPublicationV1;
  }> = {},
) {
  const context = input.context
    ?? structuredClone(state.prepared.authority);
  const signerPublication = input.signerPublication
    ?? structuredClone(state.signerPublication);
  return authorizeObjectAccessWriteV2({
    expected: null,
    intended: objectAccessStorageStateV2(
      state.crypto,
      state.prepared.manifestBytes,
      state.prepared.envelopeBytes,
    ),
    authorization: {
      kind: "agent-genesis",
      context,
      signerPublication,
      signerPublicationHash: state.crypto.hash(
        encodeAgentRuntimeSignerPublicationV1(signerPublication),
      ),
      signerPublicKeyHash: state.crypto.hash(
        signerPublication.signerPublicKey,
      ),
      managerSigningPublicKeyHash: state.crypto.hash(
        state.manager.publicKey,
      ),
    },
  });
}

class CapturingStorage implements ObjectAccessStateCasStorageV2 {
  readonly writes: ReturnType<
    typeof consumeAuthorizedObjectAccessWriteV2
  >[] = [];
  status: "applied" | "duplicate" | "stale" = "applied";

  constructor(private readonly payloadBytes: Uint8Array) {}

  getObject(objectIdValue: string) {
    return Promise.resolve({
      objectId: objectIdValue,
      payloadBytes: this.payloadBytes.slice(),
    });
  }

  compareAndSwapObjectAccessState(
    authorized: AuthorizedObjectAccessWriteV2,
  ) {
    this.writes.push(consumeAuthorizedObjectAccessWriteV2(authorized));
    return Promise.resolve(this.status);
  }
}

describe("Agent v3 object access storage coordinator", () => {
  test("the reference store independently rechecks a complete durable Agent genesis", async () => {
    const state = await durableAgentGenesisFixture();

    expect(await persistPreparedAgentObjectAccessManifestGenesisV3({
      crypto: state.crypto,
      storage: state.store,
      prepared: state.prepared,
      resolveCurrentAuthorization: state.decision,
    })).toBe("applied");
    expect(await persistPreparedAgentObjectAccessManifestGenesisV3({
      crypto: state.crypto,
      storage: state.store,
      prepared: state.prepared,
      resolveCurrentAuthorization: state.decision,
    })).toBe("duplicate");
    const persisted = await state.store.getObjectAccessState(
      state.prepared.authority.objectId,
    );
    const expected = objectAccessStorageStateV2(
      state.crypto,
      state.prepared.manifestBytes,
      state.prepared.envelopeBytes,
    );
    expect(persisted?.head).toEqual(expected.head);
    expect(persisted?.namespaceEnvelopes).toEqual(
      expected.namespaceEnvelopes.map((envelope) => ({
        ...envelope,
        envelopeBytes: envelope.envelopeBytes.ciphertext,
      })),
    );
  });

  test("durable Agent genesis ignores unrelated Runtime Domain envelopes", async () => {
    const state = await durableAgentGenesisFixture(0x237_82, {
      includeUnrelatedRuntimeDomain: true,
    });

    expect(await state.store.compareAndSwapObjectAccessState(
      authorizeDurableAgentGenesis(state),
    )).toBe("applied");
    expect(await state.store.getObjectAccessState(
      state.prepared.authority.objectId,
    )).not.toBeNull();
  });

  test("durable Agent genesis reports a missing Runtime as stale", async () => {
    const state = await durableAgentGenesisFixture(0x237_83, {
      initializeRuntime: false,
    });

    expect(await state.store.compareAndSwapObjectAccessState(
      authorizeDurableAgentGenesis(state),
    )).toBe("stale");
    expect(await state.store.getObjectAccessState(
      state.prepared.authority.objectId,
    )).toBeNull();
  });

  test("durable Agent genesis accepts a Grant covering additional Domains", async () => {
    const state = await durableAgentGenesisFixture(0x237_84, {
      includeUnrelatedGrantDomain: true,
    });

    expect(await state.store.compareAndSwapObjectAccessState(
      authorizeDurableAgentGenesis(state),
    )).toBe("applied");
  });

  test("durable Agent genesis accepts an atomically claimed single-use Grant", async () => {
    const state = await durableAgentGenesisFixture(0x237_85, {
      grantUseStatus: "claimed-by-preflight",
    });

    expect(await state.store.compareAndSwapObjectAccessState(
      authorizeDurableAgentGenesis(state),
    )).toBe("applied");
  });

  test("durable Agent genesis rejects stale Runtime Domain coordinates", async () => {
    const cases = [
      { runtimeEnvelopeDomainEpoch: 2 },
      { runtimeEnvelopeAuthorizationRevision: 6 },
    ] as const;
    for (const [index, options] of cases.entries()) {
      const state = await durableAgentGenesisFixture(
        0x237_86 + index,
        options,
      );
      expect(await state.store.compareAndSwapObjectAccessState(
        authorizeDurableAgentGenesis(state),
      )).toBe("stale");
      expect(await state.store.getObjectAccessState(
        state.prepared.authority.objectId,
      )).toBeNull();
    }
  });

  test("durable Agent genesis rejects every wrong Grant Domain coordinate", async () => {
    const cases = [
      { grantCoveredDomainId: "domain-agent-other" },
      { grantCoveredDomainEpoch: 2 },
      { grantCoveredAuthorizationRevision: 6 },
    ] as const;
    for (const [index, options] of cases.entries()) {
      const state = await durableAgentGenesisFixture(
        0x237_88 + index,
        options,
      );
      expect(await state.store.compareAndSwapObjectAccessState(
        authorizeDurableAgentGenesis(state),
      )).toBe("stale");
    }
  });

  test("durable Agent genesis rejects mismatched Grant use lifecycle", async () => {
    const cases = [
      {
        grantUseStatus: "reusable" as const,
        grantSingleUse: true,
        consumeGrant: false,
      },
      {
        grantUseStatus: "claimed-by-preflight" as const,
        grantSingleUse: true,
        consumeGrant: false,
      },
      {
        grantUseStatus: "claimed-by-preflight" as const,
        grantSingleUse: false,
        consumeGrant: true,
      },
    ];
    for (const [index, options] of cases.entries()) {
      const state = await durableAgentGenesisFixture(
        0x237_8b + index,
        options,
      );
      expect(await state.store.compareAndSwapObjectAccessState(
        authorizeDurableAgentGenesis(state),
      )).toBe("stale");
    }
  });

  test("durable object CAS rejects Agent v3 manifests in Human genesis and update modes", async () => {
    const state = await durableAgentGenesisFixture(0x237_8e);
    const intended = objectAccessStorageStateV2(
      state.crypto,
      state.prepared.manifestBytes,
      state.prepared.envelopeBytes,
    );
    expect(await state.store.compareAndSwapObjectAccessState(
      authorizeObjectAccessWriteV2({
        expected: null,
        intended,
        authorization: {
          kind: "genesis",
          context: {
            purpose: "persist-object-access-genesis",
            objectId: intended.head.objectId,
            payloadHash: state.prepared.authority.payloadHash,
            envelopes: [],
            committerDeviceId: "device-wrong-mode",
            hostAuthorizationRevision:
              state.prepared.authority.agentAuthorizationRevision,
          },
          currentHostAuthorizationRevision:
            state.prepared.authority.agentAuthorizationRevision,
          committerSigningPublicKeyHash: new Uint8Array(32),
        },
      }),
    )).toBe("stale");
    expect(await state.store.compareAndSwapObjectAccessState(
      authorizeObjectAccessWriteV2({
        expected: intended.head,
        intended,
        authorization: authorizeDurableAgentGenesis(state).authorization,
      }),
    )).toBe("stale");
  });

  test("the reference store rejects every substituted Agent genesis authority axis", async () => {
    const changedHash = (value: Uint8Array): Uint8Array => {
      const changed = value.slice();
      changed[0] = (changed[0] ?? 0) ^ 0xff;
      return changed;
    };
    const cases = [
      {
        label: "object id",
        change: (context: DurableAgentGenesisFixture["prepared"]["authority"]): typeof context => ({
          ...context,
          objectId: objectId("object-agent-substituted"),
          envelope: {
            ...context.envelope,
            objectId: objectId("object-agent-substituted"),
          },
        }),
      },
      {
        label: "payload hash",
        change: (context: DurableAgentGenesisFixture["prepared"]["authority"]): typeof context => ({
          ...context,
          payloadHash: changedHash(context.payloadHash),
        }),
      },
      {
        label: "Grant id",
        change: (context: DurableAgentGenesisFixture["prepared"]["authority"]): typeof context => ({
          ...context,
          grantId: grantId("grant-agent-substituted"),
        }),
      },
      {
        label: "Grant hash",
        change: (context: DurableAgentGenesisFixture["prepared"]["authority"]): typeof context => ({
          ...context,
          grantHash: changedHash(context.grantHash),
        }),
      },
      {
        label: "Grant use status",
        change: (context: DurableAgentGenesisFixture["prepared"]["authority"]): typeof context => ({
          ...context,
          grantUseStatus: "claimed-by-preflight",
        }),
      },
      {
        label: "Namespace id",
        change: (context: DurableAgentGenesisFixture["prepared"]["authority"]): typeof context => ({
          ...context,
          namespaceId: namespaceId("namespace-agent-substituted"),
          envelope: {
            ...context.envelope,
            namespaceId: namespaceId("namespace-agent-substituted"),
          },
        }),
      },
      {
        label: "Namespace revision",
        change: (context: DurableAgentGenesisFixture["prepared"]["authority"]): typeof context => ({
          ...context,
          namespaceAccessRevision: accessRevision(4),
        }),
      },
      {
        label: "Namespace binding hash",
        change: (context: DurableAgentGenesisFixture["prepared"]["authority"]): typeof context => ({
          ...context,
          namespaceBindingHash: changedHash(context.namespaceBindingHash),
        }),
      },
      {
        label: "Domain id",
        change: (context: DurableAgentGenesisFixture["prepared"]["authority"]): typeof context => ({
          ...context,
          domainId: cryptoDomainId("domain-agent-substituted"),
        }),
      },
      {
        label: "Domain epoch",
        change: (context: DurableAgentGenesisFixture["prepared"]["authority"]): typeof context => ({
          ...context,
          domainEpoch: domainEpoch(4),
        }),
      },
      {
        label: "envelope binding revision",
        change: (context: DurableAgentGenesisFixture["prepared"]["authority"]): typeof context => ({
          ...context,
          envelope: {
            ...context.envelope,
            bindingRevisionAtWrap: accessRevision(4),
          },
        }),
      },
    ] as const;

    for (const [index, candidate] of cases.entries()) {
      const state = await durableAgentGenesisFixture(0x237_90 + index);
      const context = candidate.change(
        structuredClone(state.prepared.authority),
      );
      expect(
        await state.store.compareAndSwapObjectAccessState(
          authorizeDurableAgentGenesis(state, { context }),
        ),
        candidate.label,
      ).toBe("stale");
      expect(
        await state.store.getObjectAccessState(
          state.prepared.authority.objectId,
        ),
        candidate.label,
      ).toBeNull();
    }

    const publicationState = await durableAgentGenesisFixture(0x237_f0);
    const substitutedPublication = structuredClone(
      publicationState.signerPublication,
    );
    substitutedPublication.signature[0] =
      (substitutedPublication.signature[0] ?? 0) ^ 0xff;
    expect(await publicationState.store.compareAndSwapObjectAccessState(
      authorizeDurableAgentGenesis(publicationState, {
        signerPublication: substitutedPublication,
      }),
    )).toBe("stale");
  });

  test("prepares one canonical AI envelope and persists a branded Agent genesis", async () => {
    const state = fixture();
    const storage = new CapturingStorage(state.payloadBytes);

    expect(await persistPreparedAgentObjectAccessManifestGenesisV3({
      crypto: state.crypto,
      storage,
      prepared: state.prepared,
      resolveCurrentAuthorization: state.decision,
    })).toBe("applied");

    expect(decodeObjectAccessManifestV2OrV3(
      state.prepared.manifestBytes,
    ).formatVersion).toBe(3);
    expect(decodeObjectAccessManifestV3(
      state.prepared.manifestBytes,
    ).signer).toEqual({
      kind: "agent_runtime",
      agentId: state.runtime.agentId,
      runtimeGeneration: state.runtime.generation,
      signerKeyId: state.signerPublication.signerKeyId,
    });
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]?.authorization).toMatchObject({
      kind: "agent-genesis",
      context: state.prepared.authority,
      signerPublication: state.signerPublication,
    });
    expect(objectAccessStorageStateV2(
      state.crypto,
      state.prepared.manifestBytes,
      state.prepared.envelopeBytes,
    ).head.manifestBytes).toEqual(state.prepared.manifestBytes);
  });

  test("durable policy binds every Agent genesis authorization coordinate", async () => {
    const state = fixture(0x237_75);
    const storage = new CapturingStorage(state.payloadBytes);
    expect(await persistPreparedAgentObjectAccessManifestGenesisV3({
      crypto: state.crypto,
      storage,
      prepared: state.prepared,
      resolveCurrentAuthorization: state.decision,
    })).toBe("applied");
    const authorization = storage.writes[0]!.authorization;
    if (authorization.kind !== "agent-genesis") {
      throw new Error("expected Agent genesis authorization fixture");
    }
    const exact: AgentObjectAccessGenesisAuthorizationExpectationV3 =
      authorization;
    expect(() =>
      assertObjectAccessAuthorizationExpectation(exact)
    ).not.toThrow();
    expect(() =>
      assertObjectAccessAuthorizationExpectation({
        ...structuredClone(exact),
        context: {
          ...structuredClone(exact.context),
          grantUseStatus: "claimed-by-preflight",
        },
      })
    ).not.toThrow();

    const changedHash = (value: Uint8Array): Uint8Array => {
      const changed = value.slice();
      changed[0] = (changed[0] ?? 0) ^ 0xff;
      return changed;
    };
    const invalid: readonly [
      string | RegExp,
      (value: typeof exact) => unknown,
    ][] = [
      ["Agent object access genesis authorization expectation", (value) => ({
        ...value,
        unexpected: true,
      })],
      ["Agent object access genesis authorization context", (value) => ({
        ...value,
        context: { ...value.context, unexpected: true },
      })],
      ["Agent object access signer key id", (value) => ({
        ...value,
        context: { ...value.context, signerKeyId: "" },
      })],
      ["Agent object access payload hash", (value) => ({
        ...value,
        context: { ...value.context, payloadHash: new Uint8Array(31) },
      })],
      ["Agent object access Grant hash", (value) => ({
        ...value,
        context: { ...value.context, grantHash: new Uint8Array(31) },
      })],
      ["Agent object access Namespace binding hash", (value) => ({
        ...value,
        context: {
          ...value.context,
          namespaceBindingHash: new Uint8Array(31),
        },
      })],
      ["Agent object access genesis envelope context", (value) => ({
        ...value,
        context: {
          ...value.context,
          envelope: { ...value.context.envelope, unexpected: true },
        },
      })],
      ["Agent object access Namespace key generation", (value) => ({
        ...value,
        context: {
          ...value.context,
          envelope: { ...value.context.envelope, keyGeneration: -1 },
        },
      })],
      ["Agent object access Namespace envelope hash", (value) => ({
        ...value,
        context: {
          ...value.context,
          envelope: {
            ...value.context.envelope,
            envelopeHash: new Uint8Array(31),
          },
        },
      })],
      ["Agent object access signer publication hash", (value) => ({
        ...value,
        signerPublicationHash: new Uint8Array(31),
      })],
      ["Agent object access signer public key hash", (value) => ({
        ...value,
        signerPublicKeyHash: new Uint8Array(31),
      })],
      ["Agent object access manager signing public key hash", (value) => ({
        ...value,
        managerSigningPublicKeyHash: new Uint8Array(31),
      })],
      ["authorization context is invalid", (value) => ({
        ...value,
        context: { ...value.context, purpose: "wrong-purpose" as never },
      })],
      ["authorization context is invalid", (value) => ({
        ...value,
        context: { ...value.context, grantUseStatus: "unused" as never },
      })],
      ["envelope context is invalid", (value) => ({
        ...value,
        context: {
          ...value.context,
          envelope: { ...value.context.envelope, keyClass: "human" },
        },
      })],
      ["envelope context is invalid", (value) => ({
        ...value,
        context: {
          ...value.context,
          envelope: { ...value.context.envelope, objectId: objectId("wrong-object") },
        },
      })],
      ["envelope context is invalid", (value) => ({
        ...value,
        context: {
          ...value.context,
          envelope: {
            ...value.context.envelope,
            namespaceId: namespaceId("wrong-namespace"),
          },
        },
      })],
      [/Runtime generation|publication expectation is inconsistent/, (value) => ({
        ...value,
        context: { ...value.context, agentId: agentId("wrong-agent") },
      })],
      [/Runtime generation|publication expectation is inconsistent/, (value) => ({
        ...value,
        context: {
          ...value.context,
          agentAuthorizationRevision: authorizationRevision(
            value.context.agentAuthorizationRevision + 1,
          ),
        },
      })],
      [/Runtime generation|publication expectation is inconsistent/, (value) => ({
        ...value,
        context: {
          ...value.context,
          runtimeGeneration: agentRuntimeGeneration(
            value.context.runtimeGeneration + 1,
          ),
        },
      })],
      ["publication expectation is inconsistent", (value) => ({
        ...value,
        context: {
          ...value.context,
          signerKeyId: value.context.signerKeyId.slice(0, -1)
            + (value.context.signerKeyId.endsWith("0") ? "1" : "0"),
        },
      })],
      ["publication expectation is inconsistent", (value) => ({
        ...value,
        signerPublicationHash: changedHash(value.signerPublicationHash),
      })],
      ["publication expectation is inconsistent", (value) => ({
        ...value,
        signerPublicKeyHash: changedHash(value.signerPublicKeyHash),
      })],
      ["publication expectation is inconsistent", (value) => ({
        ...value,
        managerSigningPublicKeyHash:
          changedHash(value.managerSigningPublicKeyHash),
      })],
    ];
    for (const [message, mutate] of invalid) {
      expect(() =>
        assertObjectAccessAuthorizationExpectation(
          mutate(structuredClone(exact)) as ObjectAccessAuthorizationExpectationV2,
        )
      ).toThrow(message);
    }
  });

  test("rejects structural preparation forgery and every current-authority substitution before CAS", async () => {
    const state = fixture(0x237_72);
    const storage = new CapturingStorage(state.payloadBytes);
    expect(
      persistPreparedAgentObjectAccessManifestGenesisV3({
        crypto: state.crypto,
        storage,
        prepared: {
          ...state.prepared,
          manifestBytes: state.prepared.manifestBytes.slice(),
        } as PreparedAgentObjectAccessManifestGenesisV3,
        resolveCurrentAuthorization: state.decision,
      }),
    ).rejects.toThrow("authentic prepared genesis");

    const substitutions = [
      (decision: ReturnType<typeof state.decision>) => ({
        ...decision,
        grantAuthorized: false,
      }),
      (decision: ReturnType<typeof state.decision>) => ({
        ...decision,
        context: {
          ...decision.context,
          namespaceAccessRevision: decision.context.namespaceAccessRevision + 1,
        },
      }),
      (decision: ReturnType<typeof state.decision>) => ({
        ...decision,
        currentRuntime: {
          ...decision.currentRuntime,
          runtimeGeneration: agentRuntimeGeneration(
            decision.currentRuntime.runtimeGeneration + 1,
          ),
        },
      }),
      (decision: ReturnType<typeof state.decision>) => ({
        ...decision,
        signerPublication: {
          ...decision.signerPublication,
          signerPublicKey: new Uint8Array(32).fill(0xee),
        } as AgentRuntimeSignerPublicationV1,
      }),
      (decision: ReturnType<typeof state.decision>) => ({
        ...decision,
        currentManagerSigningPublicKey:
          state.crypto.generateSigningKeyPair().publicKey,
      }),
    ];
    for (const substitute of substitutions) {
      expect(await persistPreparedAgentObjectAccessManifestGenesisV3({
        crypto: state.crypto,
        storage,
        prepared: state.prepared,
        resolveCurrentAuthorization: () =>
          substitute(state.decision()),
      })).toBe("stale");
    }
    expect(storage.writes).toHaveLength(0);
  });

  test("rechecks every current authorization decision coordinate independently", async () => {
    const state = fixture(0x237_76);
    type Decision = ReturnType<typeof state.decision>;
    const changedHash = (value: Uint8Array): Uint8Array => {
      const changed = value.slice();
      changed[0] = changed[0]! ^ 0xff;
      return changed;
    };
    const changedContext = (
      change: (context: Decision["context"]) => Decision["context"],
    ) => (decision: Decision): Decision => ({
      ...decision,
      context: change(structuredClone(decision.context)),
    });
    const substitutions: Array<(decision: Decision) => Decision> = [
      (decision) => ({ ...decision, grantAuthorized: false }),
      (decision) => ({ ...decision, namespaceAuthorized: false }),
      (decision) => ({ ...decision, domainAuthorized: false }),
      (decision) => ({ ...decision, agentAuthorized: false }),
      (decision) => ({ ...decision, hostAllowsOperation: false }),
      changedContext((context) => ({ ...context, purpose: "wrong" as never })),
      changedContext((context) => ({ ...context, objectId: objectId("object-other") })),
      changedContext((context) => ({ ...context, payloadHash: changedHash(context.payloadHash) })),
      changedContext((context) => ({
        ...context,
        envelope: { ...context.envelope, objectId: objectId("object-other") },
      })),
      changedContext((context) => ({
        ...context,
        envelope: { ...context.envelope, namespaceId: namespaceId("namespace-other") },
      })),
      changedContext((context) => ({
        ...context,
        envelope: { ...context.envelope, keyClass: "human" as never },
      })),
      changedContext((context) => ({
        ...context,
        envelope: { ...context.envelope, keyGeneration: context.envelope.keyGeneration + 1 },
      })),
      changedContext((context) => ({
        ...context,
        envelope: {
          ...context.envelope,
          bindingRevisionAtWrap: context.envelope.bindingRevisionAtWrap + 1,
        },
      })),
      changedContext((context) => ({
        ...context,
        envelope: { ...context.envelope, envelopeHash: changedHash(context.envelope.envelopeHash) },
      })),
      changedContext((context) => ({ ...context, grantId: grantId("grant-other") })),
      changedContext((context) => ({ ...context, grantHash: changedHash(context.grantHash) })),
      changedContext((context) => ({ ...context, grantUseStatus: "claimed-by-preflight" })),
      changedContext((context) => ({ ...context, namespaceId: namespaceId("namespace-other") })),
      changedContext((context) => ({
        ...context,
        namespaceAccessRevision: context.namespaceAccessRevision + 1,
      })),
      changedContext((context) => ({
        ...context,
        namespaceBindingHash: changedHash(context.namespaceBindingHash),
      })),
      changedContext((context) => ({ ...context, domainId: cryptoDomainId("domain-other") })),
      changedContext((context) => ({ ...context, domainEpoch: context.domainEpoch + 1 })),
      changedContext((context) => ({
        ...context,
        agentAuthorizationRevision: context.agentAuthorizationRevision + 1,
      })),
      changedContext((context) => ({ ...context, agentId: agentId("agent-other") })),
      changedContext((context) => ({ ...context, runtimeGeneration: context.runtimeGeneration + 1 })),
      changedContext((context) => ({ ...context, signerKeyId: `${context.signerKeyId}-other` })),
      (decision) => ({
        ...decision,
        currentRuntime: { ...decision.currentRuntime, agentId: agentId("agent-other") },
      }),
      (decision) => ({
        ...decision,
        currentRuntime: {
          ...decision.currentRuntime,
          authorizationRevision: authorizationRevision(
            decision.currentRuntime.authorizationRevision + 1,
          ),
        },
      }),
      (decision) => ({
        ...decision,
        currentRuntime: {
          ...decision.currentRuntime,
          runtimeGeneration: agentRuntimeGeneration(
            decision.currentRuntime.runtimeGeneration + 1,
          ),
        },
      }),
      (decision) => ({
        ...decision,
        signerPublication: {
          ...decision.signerPublication,
          agentId: agentId("agent-other"),
        },
      }),
      (decision) => ({
        ...decision,
        signerPublication: {
          ...decision.signerPublication,
          authorizationRevision: authorizationRevision(
            decision.signerPublication.authorizationRevision + 1,
          ),
        },
      }),
      (decision) => ({
        ...decision,
        signerPublication: {
          ...decision.signerPublication,
          runtimeGeneration: agentRuntimeGeneration(
            decision.signerPublication.runtimeGeneration + 1,
          ),
        },
      }),
      (decision) => ({
        ...decision,
        signerPublication: {
          ...decision.signerPublication,
          signerKeyId: `${decision.signerPublication.signerKeyId}-other`,
        },
      }),
    ];

    for (const substitute of substitutions) {
      const storage = new CapturingStorage(state.payloadBytes);
      expect(await persistPreparedAgentObjectAccessManifestGenesisV3({
        crypto: state.crypto,
        storage,
        prepared: state.prepared,
        resolveCurrentAuthorization: () => substitute(state.decision()),
      })).toBe("stale");
      expect(storage.writes).toHaveLength(0);
    }
  });

  test("rejects malformed authorization decisions before storage", async () => {
    const state = fixture(0x237_77);
    const storage = new CapturingStorage(state.payloadBytes);
    const base = state.decision();
    const sameSizeWrongFields = { ...base } as Record<string, unknown>;
    delete sameSizeWrongFields["context"];
    sameSizeWrongFields["replacement"] = base.context;
    const malformed = [
      ["wrong decision fields", sameSizeWrongFields],
      ["null Runtime", { ...base, currentRuntime: null }],
      ["extra Runtime field", {
        ...base,
        currentRuntime: { ...base.currentRuntime, extra: true },
      }],
      ["short manager key", {
        ...base,
        currentManagerSigningPublicKey: new Uint8Array(31),
      }],
    ] as const;

    expect(await persistPreparedAgentObjectAccessManifestGenesisV3({
      crypto: state.crypto,
      storage,
      prepared: state.prepared,
      resolveCurrentAuthorization: () => null,
    })).toBe("stale");

    for (const [label, decision] of malformed) {
      expect(persistPreparedAgentObjectAccessManifestGenesisV3({
        crypto: state.crypto,
        storage,
        prepared: state.prepared,
        resolveCurrentAuthorization: () => decision as never,
      }), label).rejects.toThrow("authorization decision");
    }
    expect(storage.writes).toHaveLength(0);
  });

  test("fails closed on wrong key class, Namespace revision, publication generation, and partial payload state", async () => {
    const state = fixture(0x237_73);
    const humanEnvelope = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespaceV2(
        state.crypto,
        new Uint8Array(32).fill(0x78),
        {
          objectId: objectId(state.prepared.authority.objectId),
          namespaceId: namespaceId(state.prepared.authority.namespaceId),
          keyClass: "human",
          keyGeneration: namespaceGeneration(2),
          bindingRevisionAtWrap:
            accessRevision(state.prepared.authority.namespaceAccessRevision),
        },
        new Uint8Array(32).fill(0x79),
      ),
    );
    const preparationInput = {
      objectId: state.prepared.authority.objectId,
      payloadHash: state.prepared.authority.payloadHash,
      grant: {
        grantId: grantId(state.prepared.authority.grantId),
        grantHash: state.prepared.authority.grantHash,
        useStatus: "reusable" as const,
      },
      namespace: {
        namespaceId: namespaceId(state.prepared.authority.namespaceId),
        accessRevision:
          accessRevision(state.prepared.authority.namespaceAccessRevision),
        bindingHash: state.prepared.authority.namespaceBindingHash,
        domainId: cryptoDomainId(state.prepared.authority.domainId),
        domainEpoch: domainEpoch(state.prepared.authority.domainEpoch),
      },
      agentAuthorizationRevision: state.authorization,
      runtime: state.runtime,
      signerPublication: state.signerPublication,
    };
    expect(() =>
      prepareAgentObjectAccessManifestGenesisV3(state.crypto, {
        ...preparationInput,
        envelopeBytes: [humanEnvelope],
      })
    ).toThrow("Namespace envelope coordinates are invalid");
    expect(() =>
      prepareAgentObjectAccessManifestGenesisV3(state.crypto, {
        ...preparationInput,
        envelopeBytes: [state.envelopeBytes],
        namespace: {
          ...preparationInput.namespace,
          accessRevision: accessRevision(
            preparationInput.namespace.accessRevision + 1,
          ),
        },
      })
    ).toThrow("Namespace envelope coordinates are invalid");
    expect(() =>
      prepareAgentObjectAccessManifestGenesisV3(state.crypto, {
        ...preparationInput,
        envelopeBytes: [state.envelopeBytes],
        signerPublication: {
          ...state.signerPublication,
          runtimeGeneration: agentRuntimeGeneration(1),
        },
      })
    ).toThrow(/Runtime generation|prepared Runtime/);

    const missing = new CapturingStorage(
      new Uint8Array(state.payloadBytes.length).fill(0xff),
    );
    expect(await persistPreparedAgentObjectAccessManifestGenesisV3({
      crypto: state.crypto,
      storage: missing,
      prepared: state.prepared,
      resolveCurrentAuthorization: () => {
        throw new Error("partial state reached authority");
      },
    })).toBe("stale");
    expect(missing.writes).toHaveLength(0);
  });

  test("rejects every malformed Agent genesis preparation boundary", () => {
    const state = fixture(0x237_78);
    const input = {
      objectId: state.prepared.authority.objectId,
      payloadHash: state.prepared.authority.payloadHash,
      envelopeBytes: [state.envelopeBytes] as readonly [Uint8Array],
      grant: {
        grantId: state.prepared.authority.grantId,
        grantHash: state.prepared.authority.grantHash,
        useStatus: "reusable" as const,
      },
      namespace: {
        namespaceId: state.prepared.authority.namespaceId,
        accessRevision: state.prepared.authority.namespaceAccessRevision,
        bindingHash: state.prepared.authority.namespaceBindingHash,
        domainId: state.prepared.authority.domainId,
        domainEpoch: state.prepared.authority.domainEpoch,
      },
      agentAuthorizationRevision: state.authorization,
      runtime: state.runtime,
      signerPublication: state.signerPublication,
    };
    const decodedEnvelope = decodeNamespaceObjectEnvelopeV2(
      state.envelopeBytes,
    );
    const envelopeWith = (
      context: typeof decodedEnvelope.context,
    ): Uint8Array => encodeNamespaceObjectEnvelopeV2({
      ...decodedEnvelope,
      context,
    });
    const invalid: Array<Partial<typeof input>> = [
      { envelopeBytes: [] as never },
      { envelopeBytes: [state.envelopeBytes, state.envelopeBytes] as never },
      { envelopeBytes: "envelope" as never },
      {
        envelopeBytes: [envelopeWith({
          ...decodedEnvelope.context,
          objectId: objectId("object-other"),
        })],
      },
      {
        envelopeBytes: [envelopeWith({
          ...decodedEnvelope.context,
          namespaceId: namespaceId("namespace-other"),
        })],
      },
      {
        envelopeBytes: [envelopeWith({
          ...decodedEnvelope.context,
          keyClass: "human",
        })],
      },
      {
        envelopeBytes: [envelopeWith({
          ...decodedEnvelope.context,
          bindingRevisionAtWrap: accessRevision(
            decodedEnvelope.context.bindingRevisionAtWrap + 1,
          ),
        })],
      },
      { payloadHash: new Uint8Array(31) },
      { payloadHash: "hash" as never },
      { grant: { ...input.grant, grantHash: new Uint8Array(31) } },
      { grant: { ...input.grant, useStatus: "invalid" as never } },
      {
        namespace: {
          ...input.namespace,
          bindingHash: new Uint8Array(31),
        },
      },
      {
        signerPublication: {
          ...input.signerPublication,
          authorizationRevision: authorizationRevision(
            input.signerPublication.authorizationRevision + 1,
          ),
        },
      },
      {
        signerPublication: {
          ...input.signerPublication,
          agentId: agentId("agent-other"),
        },
      },
    ];

    for (const changes of invalid) {
      expect(() => prepareAgentObjectAccessManifestGenesisV3(state.crypto, {
        ...input,
        ...changes,
      })).toThrow();
    }
  });

  test("detects mutation of every caller-reachable prepared byte buffer", () => {
    const state = fixture(0x237_79);
    const mutableBuffers = [
      state.prepared.manifestBytes,
      state.prepared.manifestHash,
      state.prepared.envelopeBytes[0],
      state.prepared.authority.payloadHash,
      state.prepared.authority.envelope.envelopeHash,
      state.prepared.authority.grantHash,
      state.prepared.authority.namespaceBindingHash,
    ];

    for (const buffer of mutableBuffers) {
      const original = buffer[0]!;
      buffer[0] = original ^ 0xff;
      expect(() =>
        assertAuthenticPreparedAgentObjectAccessManifestGenesisV3(
          state.prepared,
        )
      ).toThrow("authentic prepared genesis");
      buffer[0] = original;
      expect(() =>
        assertAuthenticPreparedAgentObjectAccessManifestGenesisV3(
          state.prepared,
        )
      ).not.toThrow();
    }
  });

  test("surfaces ambiguous CAS once and does not retain caller-owned Runtime or envelope bytes", async () => {
    const state = fixture(0x237_74);
    const runtimeSnapshot = state.runtime.key.slice();
    const envelopeSnapshot = state.envelopeBytes.slice();
    const storage = new CapturingStorage(state.payloadBytes);
    storage.compareAndSwapObjectAccessState = async (authorized) => {
      consumeAuthorizedObjectAccessWriteV2(authorized);
      throw new Error("lost Agent object CAS response");
    };

    const error = await persistPreparedAgentObjectAccessManifestGenesisV3({
      crypto: state.crypto,
      storage,
      prepared: state.prepared,
      resolveCurrentAuthorization: state.decision,
    }).catch((cause: unknown) => cause);
    expect(error).toHaveProperty(
      "name",
      "ObjectAccessPersistenceOutcomeUnknownV2",
    );
    expect(state.runtime.key).toEqual(runtimeSnapshot);
    state.envelopeBytes.fill(0);
    expect(state.prepared.envelopeBytes[0]).toEqual(envelopeSnapshot);
  });
});
