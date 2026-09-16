import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  fingerprintHumanArtifactAccessInventory,
  humanId,
  namespaceBindingHash,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareHumanArtifactExactAccessRequest,
  prepareHumanObjectAccessManifestUpdateSet,
  prepareHumanObjectAccessManifestGenesisSet,
  sealNamespaceKeyring,
  systemRng,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type HumanObjectAccessNamespaceBinding,
  type PreparedHumanObjectAccessManifestUpdateSet,
} from "@nautilo/lattice-crypto";
import {
  decodeObjectAccessManifestV5,
  encodeNamespaceObjectEnvelopeV2,
  serializeNamespaceBindingV2,
} from "@nautilo/lattice-crypto/wire";

import {
  PostgresHumanArtifactExactAccessCryptoCompletion,
} from "../../src/server/artifact/postgres-human-artifact-exact-access-crypto.ts";
import type {
  HumanArtifactExactAccessPlan,
} from "../../src/server/artifact/postgres-human-artifact-exact-access-product.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";

const ARTIFACT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BLOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NS_A = "11111111-1111-4111-8111-111111111111";
const NS_B = "22222222-2222-4222-8222-222222222222";
const NS_C = "33333333-3333-4333-8333-333333333333";
const OBJECT = `artifact:v1:${"a".repeat(64)}`;

type StoredRevision = Readonly<{
  manifestHash: Uint8Array;
  payloadHash: Uint8Array;
  manifestBytes: Uint8Array;
  envelopes: Array<Readonly<{
    namespaceId: string;
    envelopeHash: Uint8Array;
    envelopeBytes: Uint8Array;
  }>>;
}>;

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

function signedBinding(
  crypto: LatticeCrypto,
  signer: ReturnType<LatticeCrypto["generateSigningKeyPair"]>,
  namespace: string,
  domain: string,
): Readonly<{ fact: HumanObjectAccessNamespaceBinding; bytes: Uint8Array }> {
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
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope: seal("human"),
    aiEnvelope: seal("ai"),
    committerSigningPrivateKey: signer.privateKey,
    resolveCurrentCommitter: () => signer.publicKey,
  });
  const bytes = serializeNamespaceBindingV2(binding);
  return Object.freeze({
    fact: Object.freeze({
      namespaceId: namespace,
      domainId: domain,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 3,
      bindingHash: namespaceBindingHash(binding),
    }),
    bytes,
  });
}

class CryptoConnection implements CryptoPostgresConnection {
  headRevision = 0;
  signingPublicKey = new Uint8Array(32);
  readonly revisions = new Map<number, StoredRevision>();
  readonly bindings = new Map<string, HumanObjectAccessNamespaceBinding>();
  readonly signedBindings = new Map<string, Uint8Array>();

  async query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> {
    const normalized = statement.toLowerCase();
    if (normalized.includes("current_user::text")) {
      const rows: unknown = [{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }];
      return rows as Row[];
    }
    if (normalized.includes("from object_crypto_access_heads h")) {
      const value = this.revisions.get(this.headRevision);
      return value === undefined ? [] : [{
        object_id: OBJECT,
        access_revision: this.headRevision,
        manifest_hash: value.manifestHash.slice(),
        payload_hash: value.payloadHash.slice(),
        manifest_bytes: value.manifestBytes.slice(),
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
        human_id: "human-alice",
        signing_public_key: this.signingPublicKey.slice(),
        state: "active",
        revision: 1_000,
      }] as unknown as Row[];
    }
    if (
      normalized.includes("from")
      && normalized.includes("object_crypto_namespace_envelopes")
    ) {
      const value = this.revisions.get(Number(parameters[1]));
      return (value?.envelopes ?? []).map((entry, ordinal) => ({
        namespace_id: entry.namespaceId,
        ordinal,
        envelope_hash: entry.envelopeHash.slice(),
        envelope_bytes: entry.envelopeBytes.slice(),
      })) as unknown as Row[];
    }
    if (normalized.includes("namespace_crypto_heads")) {
      const value = this.bindings.get(String(parameters[0]));
      return value === undefined ? [] : [{
        namespace_id: value.namespaceId,
        access_revision: value.expectedAccessRevision,
        binding_hash: value.bindingHash.slice(),
        domain_id: value.domainId,
        writes_paused: false,
      }] as unknown as Row[];
    }
    if (normalized.includes("namespace_crypto_bindings")) {
      const namespace = String(parameters[0]);
      const bytes = Number(parameters[1]) === 0
        ? this.signedBindings.get(namespace)
        : undefined;
      return bytes === undefined ? [] : [{
        namespace_id: namespace,
        revision: 0,
        binding_hash: new LatticeCrypto(systemRng).hash(bytes),
        signed_binding_bytes: bytes.slice(),
      }] as unknown as Row[];
    }
    if (normalized.startsWith('insert into "object_crypto_access_manifests"')) {
      this.revisions.set(Number(parameters[1]), {
        manifestHash: (parameters[2] as Uint8Array).slice(),
        payloadHash: (parameters[4] as Uint8Array).slice(),
        manifestBytes: (parameters[5] as Uint8Array).slice(),
        envelopes: [],
      });
      return [];
    }
    if (normalized.startsWith('insert into "object_crypto_namespace_envelopes"')) {
      this.revisions.get(Number(parameters[1]))!.envelopes.push({
        namespaceId: String(parameters[2]),
        envelopeHash: (parameters[4] as Uint8Array).slice(),
        envelopeBytes: (parameters[5] as Uint8Array).slice(),
      });
      return [];
    }
    if (normalized.startsWith('update "object_crypto_access_heads"')) {
      if (this.headRevision !== Number(parameters[3])) return [];
      this.headRevision = Number(parameters[0]);
      return [{ object_id: OBJECT }] as unknown as Row[];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }

  transaction<Result>(callback: (transaction: this) => Promise<Result>): Promise<Result> {
    return callback(this);
  }
}

function inventory(
  prepared: PreparedHumanObjectAccessManifestUpdateSet,
  target: boolean,
) {
  const bindings = target
    ? prepared.authority.targetNamespaceBindings
    : prepared.authority.currentNamespaceBindings;
  const envelopes = target
    ? prepared.authority.targetEnvelopes
    : prepared.authority.currentEnvelopes;
  return bindings.map((binding, index) => ({
    namespaceId: namespaceId(binding.namespaceId),
    domainId: cryptoDomainId(binding.domainId),
    expectedNamespaceAccessRevision: binding.expectedAccessRevision,
    expectedPolicyRevision: binding.expectedPolicyRevision,
    bindingHash: binding.bindingHash,
    keyGeneration: envelopes[index]!.keyGeneration,
    bindingRevisionAtWrap: envelopes[index]!.bindingRevisionAtWrap,
    envelopeHash: envelopes[index]!.envelopeHash,
  }));
}

function fixture() {
  const crypto = new LatticeCrypto(systemRng);
  const signer = crypto.generateSigningKeyPair();
  const bindings = [
    signedBinding(crypto, signer, NS_A, "domain-ab"),
    signedBinding(crypto, signer, NS_B, "domain-ab"),
    signedBinding(crypto, signer, NS_C, "domain-c"),
  ];
  const a = envelope(crypto, NS_A, 0x11);
  const b = envelope(crypto, NS_B, 0x21);
  const c = envelope(crypto, NS_C, 0x31);
  const genesis = prepareHumanObjectAccessManifestGenesisSet(crypto, {
    objectId: objectId(OBJECT),
    payloadHash: new Uint8Array(32).fill(0x51),
    envelopeBytes: [a, b],
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: humanId("human-alice"),
    committerDeviceId: cryptoDeviceId("device-alice-1"),
    hostAuthorizationRevision: authorizationRevision(7),
    committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  });
  const prepared = prepareHumanObjectAccessManifestUpdateSet(crypto, {
    operationId: "artifact-access-operation-1",
    expectedContentRevision: 4,
    subjectHumanId: humanId("human-alice"),
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
    currentNamespaceBindings: bindings.slice(0, 2).map((value) => value.fact),
    targetNamespaceBindings: bindings.slice(1).map((value) => value.fact),
    sourceAuthorized: true,
    targetAuthorized: true,
    committerDeviceId: cryptoDeviceId("device-alice-1"),
    hostAuthorizationRevision: authorizationRevision(8),
    committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  });
  const connection = new CryptoConnection();
  connection.signingPublicKey = signer.publicKey.slice();
  connection.revisions.set(0, {
    manifestHash: genesis.manifestHash.slice(),
    payloadHash: genesis.manifest.payloadHash.slice(),
    manifestBytes: genesis.manifestBytes.slice(),
    // Genesis storage is canonical by envelope hash, not Namespace ID.
    envelopes: [a, b].map((raw, index) => ({
      namespaceId: [NS_A, NS_B][index]!,
      envelopeHash: crypto.hash(raw),
      envelopeBytes: raw.slice(),
    })).reverse(),
  });
  for (const value of bindings) {
    connection.bindings.set(value.fact.namespaceId, value.fact);
    connection.signedBindings.set(value.fact.namespaceId, value.bytes);
  }
  const plan: HumanArtifactExactAccessPlan = {
    status: "prepared",
    operationId: prepared.authority.operationId,
    subjectHumanId: "human-alice",
    anchorNamespaceId: NS_A,
    artifactRowId: ROW_ID,
    artifactId: ARTIFACT_ID,
    artifactRevision: 4,
    cryptoObjectId: OBJECT,
    expectedCryptoAccessRevision: 0,
    nextCryptoAccessRevision: 1,
    blobId: BLOB_ID,
    blobGeneration: 3,
    currentNamespaceIds: [NS_A, NS_B],
    targetNamespaceIds: [NS_B, NS_C],
    addedNamespaceIds: [NS_C],
    removedNamespaceIds: [NS_A],
    currentRequiredNamespaceFingerprint: new Uint8Array(32).fill(1),
    targetRequiredNamespaceFingerprint: new Uint8Array(32).fill(2),
    currentBindings: prepared.authority.currentNamespaceBindings,
    targetBindings: prepared.authority.targetNamespaceBindings,
    sourceAuthorized: true,
    targetAuthorized: true,
  };
  const signed = prepareHumanArtifactExactAccessRequest(crypto, {
    subjectHumanId: humanId("human-alice"),
    operationId: plan.operationId,
    artifactId: ARTIFACT_ID,
    artifactRevision: 4,
    cryptoObjectId: objectId(OBJECT),
    blobId: BLOB_ID,
    blobGeneration: 3,
    payloadHash: genesis.manifest.payloadHash,
    expectedAccessRevision: 0,
    nextAccessRevision: 1,
    currentManifestHash: genesis.manifestHash,
    nextManifestHash: prepared.manifestHash,
    currentInventoryHash: fingerprintHumanArtifactAccessInventory(
      inventory(prepared, false),
    ),
    targetInventoryHash: fingerprintHumanArtifactAccessInventory(
      inventory(prepared, true),
    ),
    issuedAt: unixTimestamp(100),
    deadlineAt: unixTimestamp(200),
    committerDeviceId: cryptoDeviceId("device-alice-1"),
    hostAuthorizationRevision: authorizationRevision(8),
    committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  });
  const request = {
    requestVersion: 1 as const,
    operationId: plan.operationId,
    artifactId: ARTIFACT_ID,
    artifactRevision: 4,
    expectedCryptoAccessRevision: 0,
    nextCryptoAccessRevision: 1,
    cryptoObjectId: OBJECT,
    blobId: BLOB_ID,
    blobGeneration: 3,
    currentNamespaceIds: [NS_A, NS_B],
    targetNamespaceIds: [NS_B, NS_C],
    accessManifestBytesBase64url: Buffer.from(prepared.manifestBytes).toString("base64url"),
    signedAccessRequestBytesBase64url: Buffer.from(signed.bytes).toString("base64url"),
    namespaceEnvelopes: [NS_B, NS_C].map((id, index) => ({
      namespaceId: id,
      envelopeBytesBase64url: Buffer.from(prepared.envelopeBytes[index]!)
        .toString("base64url"),
    })),
  };
  return { crypto, signer, prepared, connection, plan, request };
}

async function port(state: ReturnType<typeof fixture>) {
  return new PostgresHumanArtifactExactAccessCryptoCompletion({
    handle: await verifyCryptoPostgresHandle(state.connection),
    crypto: state.crypto,
    resolveSigningPublicKey: () => state.signer.publicKey,
    resolveHistoricalBindingCommitter: () => state.signer.publicKey,
    resolvePolicyRevision: async () => 3,
    resolveCurrentAuthority: () => state.signer.publicKey,
  });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError("Expected Error rejection");
  }
  throw new Error("Expected rejection");
}

describe("restricted Postgres Human Artifact exact-access completion", () => {
  test("authenticates structural bytes, snapshots the plan, appends N+1, and replays", async () => {
    const state = fixture();
    const completion = await port(state);
    const first = await completion.authenticate({
      plan: state.plan,
      prepared: state.request,
      now: 150,
    });
    const concurrentReplay = await completion.authenticate({
      plan: state.plan,
      prepared: state.request,
      now: 150,
    });
    (state.plan.targetNamespaceIds as string[])[0] = NS_A;
    state.plan.targetBindings[0]!.bindingHash.fill(0xff);
    state.plan.targetRequiredNamespaceFingerprint.fill(0xff);
    expect(await completion.complete(first.handle)).toMatchObject({
      status: "applied",
      artifactId: ARTIFACT_ID,
      resultAccessRevision: 1,
      currentNamespaceIds: [NS_A, NS_B],
      targetNamespaceIds: [NS_B, NS_C],
    });
    expect(state.connection.headRevision).toBe(1);
    expect(state.connection.revisions.get(1)?.envelopes.map((entry) =>
      entry.namespaceId)).toEqual([NS_B, NS_C]);

    expect(await completion.complete(concurrentReplay.handle)).toMatchObject({
      status: "duplicate",
      resultAccessRevision: 1,
    });
  });

  test("rejects substituted product and signed Artifact coordinates", async () => {
    const state = fixture();
    const completion = await port(state);
    expect(await rejection(completion.authenticate({
      plan: { ...state.plan, blobId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      prepared: state.request,
      now: 150,
    }))).toHaveProperty("message", expect.stringMatching(/conflict.*plan/u));
    const substituted = {
      ...state.request,
      targetNamespaceIds: [NS_A, NS_C],
    };
    expect(await rejection(completion.authenticate({
      plan: state.plan,
      prepared: substituted,
      now: 150,
    }))).toHaveProperty("message", expect.stringMatching(/conflict.*plan/u));
    expect(state.connection.headRevision).toBe(0);
  });
});
