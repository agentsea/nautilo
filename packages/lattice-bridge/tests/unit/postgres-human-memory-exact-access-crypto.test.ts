import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  createCommonAgentObjectAccessManifest,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  createCommonHumanObjectAccessManifest,
  deriveAgentRuntimeObjectSignerPublic,
  domainEpoch,
  namespaceBindingHash,
  prepareHumanObjectAccessManifestUpdateSet,
  prepareHumanMemoryExactAccessRequest,
  prepareHumanObjectAccessManifestGenesisSet,
  sealNamespaceKeyring,
  systemRng,
  type HumanObjectAccessNamespaceBinding,
  type PreparedHumanObjectAccessManifestUpdateSet,
} from "@nautilo/lattice-crypto";
import {
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  encodeNamespaceObjectEnvelopeV2,
  serializeNamespaceBindingV2,
} from "@nautilo/lattice-crypto/wire";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";

import {
  authenticateHumanMemoryExactAccessPrepared,
  PostgresHumanMemoryExactAccessCryptoCompletion,
} from "../../src/server/memory/postgres-human-memory-exact-access-crypto.ts";
import type { HumanMemoryExactAccessPlan } from "../../src/server/memory/postgres-human-memory-exact-access-product.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";

const OBJECT = "memory:v1:exact-set";

function envelope(
  crypto: LatticeCrypto,
  namespace: string,
  marker: number,
): Uint8Array {
  return encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
    crypto,
    new Uint8Array(32).fill(marker),
    {
      objectId: objectId(OBJECT),
      namespaceId: namespaceId(namespace),
      keyClass: "ai",
      keyGeneration: namespaceGeneration(0),
      bindingRevisionAtWrap: accessRevision(0),
    },
    new Uint8Array(32).fill(0x77),
  ));
}

function binding(
  namespace: string,
  domain: string,
  marker: number,
): HumanObjectAccessNamespaceBinding {
  return {
    namespaceId: namespace,
    domainId: domain,
    expectedAccessRevision: 0,
    expectedPolicyRevision: 3,
    bindingHash: new Uint8Array(32).fill(marker),
  };
}

function historicalBinding(
  crypto: LatticeCrypto,
  signer: ReturnType<LatticeCrypto["generateSigningKeyPair"]>,
  namespace: string,
  domain: string,
): Readonly<{ hash: Uint8Array; bytes: Uint8Array }> {
  const keyrings = createInitialNamespaceKeyrings(crypto, namespaceId(namespace));
  const metadata = {
    domainId: cryptoDomainId(domain),
    domainEpoch: domainEpoch(0),
    previousBindingHash: null,
    committerDeviceId: cryptoDeviceId("device-alice-1"),
  } as const;
  const seal = (keyClass: "human" | "ai") => sealNamespaceKeyring({
    crypto,
    domainRoot: new Uint8Array(32).fill(keyClass === "human" ? 0x61 : 0x62),
    keyring: keyrings[keyClass],
    metadata,
    committerSigningPrivateKey: signer.privateKey,
    resolveCurrentCommitter: () => signer.publicKey,
  });
  const created = createNamespaceBinding({
    crypto,
    humanEnvelope: seal("human"),
    aiEnvelope: seal("ai"),
    committerSigningPrivateKey: signer.privateKey,
    resolveCurrentCommitter: () => signer.publicKey,
  });
  return Object.freeze({
    hash: namespaceBindingHash(created),
    bytes: serializeNamespaceBindingV2(created),
  });
}

type Revision = {
  manifestHash: Uint8Array;
  payloadHash: Uint8Array;
  manifestBytes: Uint8Array;
  envelopes: Array<{
    namespaceId: string;
    envelopeHash: Uint8Array;
    envelopeBytes: Uint8Array;
  }>;
};

class CryptoConnection implements CryptoPostgresConnection {
  headRevision = 0;
  failOnProofQuery = false;
  signingPublicKey = new Uint8Array(32);
  readonly revisions = new Map<number, Revision>();
  readonly bindings = new Map<string, HumanObjectAccessNamespaceBinding>();
  readonly historicalBindings = new Map<string, Readonly<{
    hash: Uint8Array;
    bytes: Uint8Array;
  }>>();

  constructor(genesis: Readonly<{
    manifestHash: Uint8Array;
    manifestBytes: Uint8Array;
    payloadHash: Uint8Array;
    envelopeBytes: readonly Uint8Array[];
  }>, bindings: readonly HumanObjectAccessNamespaceBinding[]) {
    this.revisions.set(0, {
      manifestHash: genesis.manifestHash.slice(),
      manifestBytes: genesis.manifestBytes.slice(),
      payloadHash: genesis.payloadHash.slice(),
      // Genesis storage is canonical by envelope hash, not Namespace ID.
      envelopes: bindings.map((entry, index) => ({
        namespaceId: entry.namespaceId,
        envelopeHash: new LatticeCrypto(systemRng).hash(genesis.envelopeBytes[index]!),
        envelopeBytes: genesis.envelopeBytes[index]!.slice(),
      })).reverse(),
    });
    bindings.forEach((entry) => this.bindings.set(entry.namespaceId, entry));
  }

  async query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> {
    const normalized = statement.toLowerCase();
    if (normalized.includes("current_user::text")) {
      return [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }] as unknown as Row[];
    }
    if (statement.includes("exact-access-crypto:head")) {
      const revision = this.revisions.get(this.headRevision)!;
      return [{
        object_id: OBJECT,
        access_revision: this.headRevision,
        manifest_hash: revision.manifestHash.slice(),
        payload_hash: revision.payloadHash.slice(),
        manifest_bytes: revision.manifestBytes.slice(),
      }] as unknown as Row[];
    }
    if (
      normalized.includes("object_crypto_access_manifests")
      && normalized.includes(">= $2")
      && normalized.includes("<= $3")
    ) {
      return Array.from(this.revisions.entries())
        .filter(([revision]) =>
          revision >= Number(parameters[1])
          && revision <= Number(parameters[2])
        )
        .sort(([left], [right]) => left - right)
        .slice(0, Number(parameters[3]))
        .map(([revision, value]) => {
          const manifest = decodeObjectAccessManifestV5(value.manifestBytes);
          return {
            object_id: OBJECT,
            access_revision: revision,
            manifest_hash: value.manifestHash.slice(),
            previous_manifest_hash:
              manifest.previousManifestHash?.slice() ?? null,
            payload_hash: value.payloadHash.slice(),
            manifest_bytes: value.manifestBytes.slice(),
          };
        }) as unknown as Row[];
    }
    if (normalized.includes("human_crypto_devices")) {
      return [{
        device_id: "device-alice-1",
        human_id: "human-1",
        signing_public_key: this.signingPublicKey.slice(),
        state: "active",
        revision: 1_000,
      }] as unknown as Row[];
    }
    if (
      normalized.includes("exact-access-crypto:envelopes")
      || normalized.includes('from "object_crypto_namespace_envelopes"')
    ) {
      const revision = this.revisions.get(parameters[1] as number)!;
      return revision.envelopes.map((entry, ordinal) => ({
        namespace_id: entry.namespaceId,
        ordinal,
        envelope_hash: entry.envelopeHash.slice(),
        envelope_bytes: entry.envelopeBytes.slice(),
      })) as unknown as Row[];
    }
    if (
      normalized.includes("exact-access-crypto:binding")
      || normalized.includes('from "namespace_crypto_heads"')
    ) {
      const entry = this.bindings.get(parameters[0] as string);
      return entry === undefined ? [] : [{
        namespace_id: entry.namespaceId,
        access_revision: entry.expectedAccessRevision,
        binding_hash: entry.bindingHash.slice(),
        domain_id: entry.domainId,
        writes_paused: false,
      }] as unknown as Row[];
    }
    if (normalized.includes('from "namespace_domain_key_bindings"')) {
      const entry = this.bindings.get(parameters[0] as string);
      return entry === undefined ? [] : [{
        namespace_id: entry.namespaceId,
        namespace_access_revision: entry.expectedAccessRevision,
        namespace_current_generation: 0,
        retained_authority_set_digest: entry.bindingHash.slice(),
      }] as unknown as Row[];
    }
    if (normalized.includes('from "namespace_domain_key_heads"')) {
      const entry = this.bindings.get(parameters[0] as string);
      return entry === undefined ? [] : [{
        namespace_id: entry.namespaceId,
        namespace_access_revision: entry.expectedAccessRevision,
        namespace_current_generation: 0,
        retained_authority_set_digest: entry.bindingHash.slice(),
      }] as unknown as Row[];
    }
    if (
      normalized.includes("exact-access-crypto:historical-binding")
      || normalized.includes('from "namespace_crypto_bindings"')
    ) {
      const namespace = parameters[0] as string;
      const revision = parameters[1] as number;
      const stored = revision === 0 ? this.historicalBindings.get(namespace) : undefined;
      return stored === undefined ? [] : [{
        namespace_id: namespace,
        revision,
        binding_hash: stored.hash.slice(),
        signed_binding_bytes: stored.bytes.slice(),
      }] as unknown as Row[];
    }
    if (statement.includes("exact-access-crypto:proof")) {
      if (this.failOnProofQuery) {
        throw new Error("unbounded history proof query must not run");
      }
      return Array.from(this.revisions.entries())
        .filter(([revision]) => revision <= (parameters[1] as number))
        .sort(([left], [right]) => left - right)
        .map(([revision, value]) => ({
          access_revision: revision,
          manifest_hash: value.manifestHash.slice(),
          payload_hash: value.payloadHash.slice(),
          manifest_bytes: value.manifestBytes.slice(),
        })) as unknown as Row[];
    }
    if (
      statement.startsWith("INSERT INTO object_crypto_access_manifests")
      || normalized.startsWith('insert into "object_crypto_access_manifests"')
    ) {
      this.revisions.set(parameters[1] as number, {
        manifestHash: (parameters[2] as Uint8Array).slice(),
        payloadHash: (parameters[4] as Uint8Array).slice(),
        manifestBytes: (parameters[5] as Uint8Array).slice(),
        envelopes: [],
      });
      return [];
    }
    if (
      statement.startsWith("INSERT INTO object_crypto_namespace_envelopes")
      || normalized.startsWith('insert into "object_crypto_namespace_envelopes"')
    ) {
      this.revisions.get(parameters[1] as number)!.envelopes.push({
        namespaceId: parameters[2] as string,
        envelopeHash: (parameters[4] as Uint8Array).slice(),
        envelopeBytes: (parameters[5] as Uint8Array).slice(),
      });
      return [];
    }
    if (normalized.startsWith('update "object_crypto_access_heads"')) {
      if (this.headRevision !== parameters[3]) return [];
      this.headRevision = parameters[0] as number;
      return [{ object_id: OBJECT }] as unknown as Row[];
    }
    if (statement.startsWith("UPDATE object_crypto_access_heads")) {
      if (this.headRevision !== parameters[3]) return [];
      this.headRevision = parameters[1] as number;
      return [{ object_id: OBJECT }] as unknown as Row[];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }

  transaction<Result>(callback: (transaction: this) => Promise<Result>): Promise<Result> {
    return callback(this);
  }
}

function plan(
  prepared: PreparedHumanObjectAccessManifestUpdateSet,
  current: readonly string[],
  target: readonly string[],
): HumanMemoryExactAccessPlan {
  return {
    status: "prepared",
    operationId: prepared.authority.operationId,
    subjectHumanId: "human-1",
    anchorNamespaceId: current[0]!,
    memoryId: "22000000-0000-4000-8000-000000000001",
    cryptoObjectId: OBJECT,
    expectedContentRevision: prepared.authority.expectedContentRevision,
    expectedCryptoAccessRevision: prepared.authority.currentAccessRevision,
    nextCryptoAccessRevision: prepared.authority.nextAccessRevision,
    currentNamespaceIds: current,
    targetNamespaceIds: target,
    addedNamespaceIds: prepared.authority.addedNamespaceIds,
    removedNamespaceIds: prepared.authority.removedNamespaceIds,
    currentRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
    targetRequiredNamespaceFingerprint: new Uint8Array(32).fill(2),
  };
}

function signedRequest(
  state: Pick<ReturnType<typeof fixture>, "crypto" | "signer">,
  prepared: PreparedHumanObjectAccessManifestUpdateSet,
) {
  const entries = (
    bindings: typeof prepared.authority.currentNamespaceBindings,
    envelopes: typeof prepared.authority.currentEnvelopes,
  ) => bindings.map((binding, index) => {
    const envelope = envelopes[index]!;
    return {
      namespaceId: namespaceId(binding.namespaceId),
      keyGeneration: envelope.keyGeneration,
      namespaceAccessRevision: envelope.bindingRevisionAtWrap,
      headDigest: binding.bindingHash,
      publicationDigest: binding.bindingHash,
      publicationSetDigest: binding.bindingHash,
      audienceFingerprint: binding.bindingHash,
      envelopeHash: envelope.envelopeHash,
    };
  });
  const currentEntries = entries(
    prepared.authority.currentNamespaceBindings,
    prepared.authority.currentEnvelopes,
  );
  const targetEntries = entries(
    prepared.authority.targetNamespaceBindings,
    prepared.authority.targetEnvelopes,
  );
  const authorityEntries = (values: typeof currentEntries) =>
    values.map(({ envelopeHash: _envelopeHash, ...entry }) => entry);
  return prepareHumanMemoryExactAccessRequest(state.crypto, {
    subjectHumanId: humanId("human-1"),
    operationId: prepared.authority.operationId,
    memoryId: "22000000-0000-4000-8000-000000000001",
    cryptoObjectId: objectId(prepared.authority.objectId),
    payloadHash: prepared.authority.payloadHash,
    expectedContentRevision: prepared.authority.expectedContentRevision,
    expectedAccessRevision: prepared.authority.currentAccessRevision,
    nextAccessRevision: prepared.authority.nextAccessRevision,
    currentManifestHash: prepared.authority.currentManifestHash,
    nextManifestHash: prepared.authority.nextManifestHash,
    currentEntries, targetEntries,
    currentAuthorityEntries: authorityEntries(currentEntries),
    targetAuthorityEntries: authorityEntries(targetEntries),
    issuedAt: unixTimestamp(100),
    deadlineAt: unixTimestamp(200),
    committerDeviceId: cryptoDeviceId(prepared.authority.committerDeviceId),
    hostAuthorizationRevision: authorizationRevision(
      prepared.authority.hostAuthorizationRevision,
    ),
    committerSigningPublicKey: state.signer.publicKey,
    committerSigningPrivateKey: state.signer.privateKey,
  });
}

function authenticate(
  state: ReturnType<typeof fixture>,
  prepared: PreparedHumanObjectAccessManifestUpdateSet,
  productPlan: HumanMemoryExactAccessPlan,
) {
  const signed = signedRequest(state, prepared);
  return authenticateHumanMemoryExactAccessPrepared({
    crypto: state.crypto,
    plan: productPlan,
    signedRequestBytes: signed.bytes,
    manifestBytes: prepared.manifestBytes,
    envelopeBytes: prepared.envelopeBytes,
    now: unixTimestamp(150),
    resolveCurrentAuthority: () => state.signer.publicKey,
  });
}

function fixture() {
  const crypto = new LatticeCrypto(systemRng);
  const signer = crypto.generateSigningKeyPair();
  const a = envelope(crypto, "namespace-a", 0x11);
  const b = envelope(crypto, "namespace-b", 0x21);
  const bindings = [
    binding("namespace-a", "domain-ab", 0x31),
    binding("namespace-b", "domain-ab", 0x41),
  ];
  const genesis = prepareHumanObjectAccessManifestGenesisSet(crypto, {
    objectId: objectId(OBJECT),
    payloadHash: new Uint8Array(32).fill(0x51),
    envelopeBytes: [a, b],
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: humanId("human-1"),
    committerDeviceId: cryptoDeviceId("device-alice-1"),
    hostAuthorizationRevision: authorizationRevision(7),
    committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  });
  const c = envelope(crypto, "namespace-c", 0x32);
  const targetBindings = [
    binding("namespace-b", "domain-ab", 0x41),
    binding("namespace-c", "domain-c", 0x61),
  ];
  const prepared = prepareHumanObjectAccessManifestUpdateSet(crypto, {
    operationId: "operation-m250-crypto-1",
    expectedContentRevision: 12,
    subjectHumanId: humanId("human-1"),
    currentManifestBytes: genesis.manifestBytes,
    currentEnvelopeBytes: [a, b],
    targetEnvelopeBytes: [b, c],
    trustedMinimumHead: {
      objectId: genesis.manifest.objectId,
      payloadHash: genesis.manifest.payloadHash,
      accessRevision: genesis.manifest.accessRevision,
      manifestHash: genesis.manifestHash,
    },
    proof: [],
    resolveSigningPublicKey: () => signer.publicKey,
    currentNamespaceBindings: bindings,
    targetNamespaceBindings: targetBindings,
    sourceAuthorized: true,
    targetAuthorized: true,
    committerDeviceId: cryptoDeviceId("device-alice-1"),
    hostAuthorizationRevision: authorizationRevision(8),
    committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  });
  const connection = new CryptoConnection({
    manifestHash: genesis.manifestHash,
    manifestBytes: genesis.manifestBytes,
    payloadHash: genesis.manifest.payloadHash,
    envelopeBytes: [a, b],
  }, bindings);
  connection.signingPublicKey = signer.publicKey.slice();
  connection.bindings.set(
    targetBindings[1]!.namespaceId,
    targetBindings[1]!,
  );
  [...bindings, targetBindings[1]!].forEach((entry) => {
    connection.historicalBindings.set(
      entry.namespaceId,
      historicalBinding(crypto, signer, entry.namespaceId, entry.domainId),
    );
  });
  return { crypto, signer, genesis, prepared, connection };
}

async function completion(state: ReturnType<typeof fixture>) {
  const handle = await verifyCryptoPostgresHandle(state.connection);
  return new PostgresHumanMemoryExactAccessCryptoCompletion({
    handle,
    crypto: state.crypto,
  });
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError("Expected an Error rejection");
  }
  throw new Error("Expected a rejected promise");
}

describe("restricted Postgres Human Memory exact-access completion", () => {
  test("authenticates a foreground Agent genesis through Human sharing and observation", async () => {
    const state = fixture();
    const original = state.connection.revisions.get(0)!;
    const runtime = Object.freeze({
      agentId: agentId("agent-foreground-memory"),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(3),
      key: new Uint8Array(32).fill(0x71),
    });
    const agentSigner = deriveAgentRuntimeObjectSignerPublic(state.crypto, runtime);
    expect(agentSigner.publicKey).toHaveLength(32);
    const agentGenesis = createCommonAgentObjectAccessManifest(state.crypto, {
      objectId: objectId(OBJECT),
      payloadHash: original.payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: state.genesis.manifest.envelopeHashes,
      signer: agentSigner.principal,
      signerAuthorizationHash: null,
      hostAuthorizationRevision: authorizationRevision(9),
    }, runtime);
    state.connection.revisions.set(0, {
      ...original,
      manifestHash: agentGenesis.hash.slice(),
      manifestBytes: agentGenesis.bytes.slice(),
    });
    const currentEnvelopeBytes = original.envelopes.map((entry) =>
      entry.envelopeBytes.slice()
    ).sort((left, right) => decodeNamespaceObjectEnvelopeV2(left).context.namespaceId
      .localeCompare(decodeNamespaceObjectEnvelopeV2(right).context.namespaceId));
    const update = prepareHumanObjectAccessManifestUpdateSet(state.crypto, {
      operationId: "operation-agent-genesis-human-share",
      expectedContentRevision: 12,
      subjectHumanId: humanId("human-1"),
      currentManifestBytes: agentGenesis.bytes,
      currentEnvelopeBytes,
      targetEnvelopeBytes: state.prepared.envelopeBytes,
      trustedMinimumHead: {
        objectId: objectId(OBJECT), payloadHash: original.payloadHash,
        accessRevision: accessRevision(0), manifestHash: agentGenesis.hash,
      },
      proof: [],
      resolveAgentRuntimeSignerPublicKey: () => agentSigner.publicKey,
      currentNamespaceBindings: state.prepared.authority.currentNamespaceBindings,
      targetNamespaceBindings: state.prepared.authority.targetNamespaceBindings,
      sourceAuthorized: true, targetAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(10),
      committerSigningPublicKey: state.signer.publicKey,
      committerSigningPrivateKey: state.signer.privateKey,
    });
    const productPlan = plan(update, ["namespace-a", "namespace-b"],
      ["namespace-b", "namespace-c"]);
    let resolutions = 0;
    const handle = await verifyCryptoPostgresHandle(state.connection);
    const port = new PostgresHumanMemoryExactAccessCryptoCompletion({
      handle, crypto: state.crypto,
      resolveLiveShadowAgentSigner: async (principal) => {
        resolutions += 1;
        expect(principal).toEqual({
          agentId: agentSigner.principal.agentId,
          runtimeGeneration: agentSigner.principal.runtimeGeneration,
          signerKeyId: agentSigner.principal.signerKeyId,
        });
        return agentSigner.publicKey.slice();
      },
    });
    expect(await port.complete(authenticate(state, update, productPlan)))
      .toMatchObject({ status: "applied", resultAccessRevision: 1 });
    expect(await port.observe(OBJECT)).toMatchObject({
      status: "target", accessRevision: 1,
      namespaceIds: ["namespace-b", "namespace-c"],
    });
    expect(resolutions).toBe(2);

    for (const resolveLiveShadowAgentSigner of [
      async () => null,
      async () => new Uint8Array(agentSigner.publicKey.length).fill(0xff),
    ]) {
      const deniedState = fixture();
      const deniedOriginal = deniedState.connection.revisions.get(0)!;
      deniedState.connection.revisions.set(0, {
        ...deniedOriginal,
        manifestHash: agentGenesis.hash.slice(),
        manifestBytes: agentGenesis.bytes.slice(),
      });
      const deniedHandle = await verifyCryptoPostgresHandle(deniedState.connection);
      const denied = new PostgresHumanMemoryExactAccessCryptoCompletion({
        handle: deniedHandle, crypto: deniedState.crypto,
        resolveLiveShadowAgentSigner,
      });
      expect(await rejectedError(denied.observe(OBJECT))).toHaveProperty(
        "message", expect.stringContaining("signer"),
      );
    }
    runtime.key.fill(0);
    agentSigner.publicKey.fill(0);
  });

  test("appends N+1, retains historical envelopes, CASes head, and replays", async () => {
    const state = fixture();
    const productPlan = plan(state.prepared, ["namespace-a", "namespace-b"], ["namespace-b", "namespace-c"]);
    const handle = authenticate(state, state.prepared, productPlan);
    const port = await completion(state);
    expect(await port.complete(handle)).toMatchObject({
      status: "applied",
      expectedAccessRevision: 0,
      resultAccessRevision: 1,
      currentNamespaceIds: ["namespace-a", "namespace-b"],
      targetNamespaceIds: ["namespace-b", "namespace-c"],
    });
    expect(state.connection.headRevision).toBe(1);
    expect(state.connection.revisions.get(0)?.envelopes.map((entry) => entry.namespaceId))
      .toEqual(["namespace-b", "namespace-a"]);
    expect(state.connection.revisions.get(1)?.envelopes.map((entry) => entry.namespaceId))
      .toEqual(["namespace-b", "namespace-c"]);
    expect(await port.observe(OBJECT)).toMatchObject({
      status: "target",
      namespaceEnvelopeCoordinates: [
        { namespaceId: "namespace-b", generation: 0, accessRevision: 0 },
        { namespaceId: "namespace-c", generation: 0, accessRevision: 0 },
      ],
    });
    expect(await port.complete(handle)).toMatchObject({ status: "duplicate" });
  });

  test("supports arbitrary N and a genuine empty exact target", async () => {
    const state = fixture();
    const firstPlan = plan(state.prepared, ["namespace-a", "namespace-b"], ["namespace-b", "namespace-c"]);
    const port = await completion(state);
    await port.complete(authenticate(state, state.prepared, firstPlan));
    const empty = prepareHumanObjectAccessManifestUpdateSet(state.crypto, {
      operationId: "operation-m250-crypto-2",
      expectedContentRevision: 12,
      subjectHumanId: humanId("human-1"),
      currentManifestBytes: state.prepared.manifestBytes,
      currentEnvelopeBytes: state.prepared.envelopeBytes,
      targetEnvelopeBytes: [],
      trustedMinimumHead: {
        objectId: state.genesis.manifest.objectId,
        payloadHash: state.genesis.manifest.payloadHash,
        accessRevision: state.genesis.manifest.accessRevision,
        manifestHash: state.genesis.manifestHash,
      },
      proof: [],
      resolveSigningPublicKey: () => state.signer.publicKey,
      currentNamespaceBindings: state.prepared.authority.targetNamespaceBindings,
      targetNamespaceBindings: [],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(9),
      committerSigningPublicKey: state.signer.publicKey,
      committerSigningPrivateKey: state.signer.privateKey,
    });
    const emptyPlan = plan(empty, ["namespace-b", "namespace-c"], []);
    expect(await port.complete(authenticate(state, empty, emptyPlan)))
      .toMatchObject({ status: "applied", resultAccessRevision: 2, targetNamespaceIds: [] });
    expect(state.connection.headRevision).toBe(2);
    expect(state.connection.revisions.get(2)?.envelopes).toEqual([]);
    expect(await port.observe(OBJECT)).toMatchObject({
      status: "target",
      accessRevision: 2,
      namespaceIds: [],
    });
  });

  test("appends beyond revision 256 from the exact authenticated durable head", async () => {
    const state = fixture();
    const genesis = state.connection.revisions.get(0)!;
    state.connection.revisions.clear();
    state.connection.revisions.set(0, genesis);
    let previousHash = genesis.manifestHash.slice();
    let current: ReturnType<typeof createCommonHumanObjectAccessManifest>
      | undefined;
    for (let revision = 1; revision <= 257; revision += 1) {
      const created = createCommonHumanObjectAccessManifest(state.crypto, {
        objectId: state.prepared.manifest.objectId,
        payloadHash: state.prepared.manifest.payloadHash,
        accessRevision: accessRevision(revision),
        previousManifestHash: previousHash,
        envelopeHashes: state.prepared.manifest.envelopeHashes,
        signer: {
          kind: "human_device",
          subjectHumanId: humanId("human-1"),
          committerDeviceId: cryptoDeviceId("device-alice-1"),
        },
        signerAuthorizationHash: null,
        hostAuthorizationRevision: authorizationRevision(20),
      }, state.signer.privateKey);
      state.connection.revisions.set(revision, {
        manifestHash: created.hash.slice(),
        manifestBytes: created.bytes.slice(),
        payloadHash: created.manifest.payloadHash.slice(),
        envelopes: revision === 257
          ? state.prepared.authority.targetNamespaceBindings.map(
            (entry, index) => ({
              namespaceId: entry.namespaceId,
              envelopeHash: state.crypto.hash(
                state.prepared.envelopeBytes[index]!,
              ),
              envelopeBytes: state.prepared.envelopeBytes[index]!.slice(),
            }),
          )
          : [],
      });
      previousHash.fill(0);
      previousHash = created.hash.slice();
      if (revision === 257) current = created;
    }
    previousHash.fill(0);
    if (current === undefined) throw new Error("Missing revision 257 fixture");
    state.connection.headRevision = 257;
    state.connection.bindings.clear();
    state.prepared.authority.targetNamespaceBindings.forEach((entry) =>
      state.connection.bindings.set(entry.namespaceId, entry)
    );
    state.connection.failOnProofQuery = true;
    const next = prepareHumanObjectAccessManifestUpdateSet(state.crypto, {
      operationId: "operation-m250-high-revision",
      expectedContentRevision: 12,
      subjectHumanId: humanId("human-1"),
      currentManifestBytes: current.bytes,
      currentEnvelopeBytes: state.prepared.envelopeBytes,
      targetEnvelopeBytes: [state.prepared.envelopeBytes[1]!],
      trustedMinimumHead: {
        objectId: current.manifest.objectId,
        payloadHash: current.manifest.payloadHash,
        accessRevision: current.manifest.accessRevision,
        manifestHash: current.hash,
      },
      proof: [],
      resolveSigningPublicKey: () => state.signer.publicKey,
      currentNamespaceBindings: state.prepared.authority.targetNamespaceBindings,
      targetNamespaceBindings: [state.prepared.authority.targetNamespaceBindings[1]!],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(21),
      committerSigningPublicKey: state.signer.publicKey,
      committerSigningPrivateKey: state.signer.privateKey,
    });
    const port = await completion(state);
    expect(await port.complete(authenticate(
      state,
      next,
      plan(next, ["namespace-b", "namespace-c"], ["namespace-c"]),
    ))).toMatchObject({ status: "applied", resultAccessRevision: 258 });
    expect(state.connection.headRevision).toBe(258);
  });

  test("admits exact HTTP structural bytes but rejects substitution and stale binding facts", async () => {
    const state = fixture();
    const productPlan = plan(state.prepared, ["namespace-a", "namespace-b"], ["namespace-b", "namespace-c"]);
    const signed = signedRequest(state, state.prepared);
    expect(() => authenticateHumanMemoryExactAccessPrepared({
      crypto: state.crypto,
      plan: productPlan,
      signedRequestBytes: signed.bytes,
      manifestBytes: new Uint8Array(state.prepared.manifestBytes.length),
      envelopeBytes: state.prepared.envelopeBytes,
      now: unixTimestamp(150),
      resolveCurrentAuthority: () => state.signer.publicKey,
    })).toThrow();
    expect(() => authenticateHumanMemoryExactAccessPrepared({
      crypto: state.crypto,
      plan: productPlan,
      signedRequestBytes: signed.bytes,
      manifestBytes: state.prepared.manifestBytes.slice(),
      envelopeBytes: state.prepared.envelopeBytes.map((bytes) => bytes.slice()),
      now: unixTimestamp(150),
      resolveCurrentAuthority: () => state.signer.publicKey,
    })).not.toThrow();
    const handle = authenticate(state, state.prepared, productPlan);
    state.connection.bindings.get("namespace-c")!.bindingHash.fill(0xff);
    const port = await completion(state);
    expect(await rejectedError(port.complete(handle))).toHaveProperty(
      "message",
      expect.stringContaining("binding authority is stale"),
    );
    expect(state.connection.headRevision).toBe(0);
  });

  test("authenticates the exact locked durable head before appending", async () => {
    const state = fixture();
    const port = await completion(state);
    await port.complete(authenticate(
      state,
      state.prepared,
      plan(state.prepared, ["namespace-a", "namespace-b"], ["namespace-b", "namespace-c"]),
    ));
    const second = prepareHumanObjectAccessManifestUpdateSet(state.crypto, {
      operationId: "operation-m250-chain-2",
      expectedContentRevision: 12,
      subjectHumanId: humanId("human-1"),
      currentManifestBytes: state.prepared.manifestBytes,
      currentEnvelopeBytes: state.prepared.envelopeBytes,
      targetEnvelopeBytes: [state.prepared.envelopeBytes[1]!],
      trustedMinimumHead: {
        objectId: state.prepared.manifest.objectId,
        payloadHash: state.prepared.manifest.payloadHash,
        accessRevision: state.prepared.manifest.accessRevision,
        manifestHash: state.prepared.manifestHash,
      },
      proof: [],
      resolveSigningPublicKey: () => state.signer.publicKey,
      currentNamespaceBindings: state.prepared.authority.targetNamespaceBindings,
      targetNamespaceBindings: [state.prepared.authority.targetNamespaceBindings[1]!],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(9),
      committerSigningPublicKey: state.signer.publicKey,
      committerSigningPrivateKey: state.signer.privateKey,
    });
    await port.complete(authenticate(
      state,
      second,
      plan(second, ["namespace-b", "namespace-c"], ["namespace-c"]),
    ));
    const third = prepareHumanObjectAccessManifestUpdateSet(state.crypto, {
      operationId: "operation-m250-chain-3",
      expectedContentRevision: 12,
      subjectHumanId: humanId("human-1"),
      currentManifestBytes: second.manifestBytes,
      currentEnvelopeBytes: second.envelopeBytes,
      targetEnvelopeBytes: state.prepared.envelopeBytes,
      trustedMinimumHead: {
        objectId: second.manifest.objectId,
        payloadHash: second.manifest.payloadHash,
        accessRevision: second.manifest.accessRevision,
        manifestHash: second.manifestHash,
      },
      proof: [],
      resolveSigningPublicKey: () => state.signer.publicKey,
      currentNamespaceBindings: second.authority.targetNamespaceBindings,
      targetNamespaceBindings: state.prepared.authority.targetNamespaceBindings,
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(10),
      committerSigningPublicKey: state.signer.publicKey,
      committerSigningPrivateKey: state.signer.privateKey,
    });
    const durableHead = state.connection.revisions.get(2)!.manifestBytes;
    durableHead[0] = durableHead[0]! ^ 1;
    expect(await rejectedError(port.complete(authenticate(
      state,
      third,
      plan(third, ["namespace-c"], ["namespace-b", "namespace-c"]),
    )))).toBeInstanceOf(Error);
    expect(state.connection.headRevision).toBe(2);
  });

  test("fails closed when an envelope's native authority is missing or substituted", async () => {
    const missing = fixture();
    missing.connection.bindings.delete("namespace-b");
    const missingPort = await completion(missing);
    expect(await rejectedError(missingPort.complete(authenticate(
      missing,
      missing.prepared,
      plan(missing.prepared, ["namespace-a", "namespace-b"], ["namespace-b", "namespace-c"]),
    )))).toHaveProperty("message", expect.stringContaining("binding authority is stale"));
    expect(missing.connection.headRevision).toBe(0);

    const substituted = fixture();
    const substitutedDigest = substituted.connection.bindings
      .get("namespace-b")!.bindingHash;
    substitutedDigest[0] = substitutedDigest[0]! ^ 1;
    const substitutedPort = await completion(substituted);
    expect(await rejectedError(substitutedPort.complete(authenticate(
      substituted,
      substituted.prepared,
      plan(substituted.prepared, ["namespace-a", "namespace-b"], ["namespace-b", "namespace-c"]),
    )))).toHaveProperty("message", expect.stringContaining("binding authority is stale"));
    expect(substituted.connection.headRevision).toBe(0);
  });
});
