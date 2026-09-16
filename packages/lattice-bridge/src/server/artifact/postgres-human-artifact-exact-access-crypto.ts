import {
  and,
  asc,
  cryptoDomains,
  eq,
  namespaceCryptoBindings,
  namespaceCryptoHeads,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
} from "@nautilo/db";
import {
  accessRevision,
  cryptoDomainId,
  fingerprintHumanArtifactAccessInventory,
  objectId,
  verifyHumanArtifactExactAccessRequest,
  verifyNamespaceBinding,
  verifyCommonObjectAccessManifestChain,
  type HistoricalCommitterResolver,
  type HumanArtifactAccessInventoryEntry,
  type LatticeCrypto,
  type ResolveCurrentHumanArtifactExactAccessAuthority,
  type ResolveDeviceSigningPublicKey,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  parseNamespaceBindingV2,
} from "@nautilo/lattice-crypto/wire";
import type { ProtectedArtifactPreparedAccessRequestV1 } from "@nautilo/api-client";

import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";
import type {
  ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "../storage/agent-runtime-signer-history.ts";
import {
  destroyVerifiedStoredObjectAccessManifestChainV5,
  verifyStoredObjectAccessManifestChainV5,
} from "../storage/postgres-object-access-manifest-v5.ts";

async function assertStoredChainAuthentic(input: Parameters<
  typeof verifyStoredObjectAccessManifestChainV5
>[0]): Promise<void> {
  const verified = await verifyStoredObjectAccessManifestChainV5(input);
  destroyVerifiedStoredObjectAccessManifestChainV5(verified);
}
import type {
  HumanArtifactExactAccessBindingFact,
  HumanArtifactExactAccessCryptoObservation,
  HumanArtifactExactAccessCryptoReceipt,
  HumanArtifactExactAccessPlan,
} from "./postgres-human-artifact-exact-access-product.ts";

type EnvelopeFact = Readonly<{
  namespaceId: string;
  keyGeneration: number;
  bindingRevisionAtWrap: number;
  envelopeHash: Uint8Array;
}>;

type PreparedSnapshot = Readonly<{
  plan: HumanArtifactExactAccessPlan;
  currentEnvelopes: readonly EnvelopeFact[];
  targetEnvelopes: readonly EnvelopeFact[];
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly Uint8Array[];
  signedRequestDigest: Uint8Array;
}>;

declare const authenticatedBrand: unique symbol;
export type AuthenticatedHumanArtifactExactAccessPrepared = Readonly<{
  [authenticatedBrand]: true;
}>;
const authenticated = new WeakMap<object, PreparedSnapshot>();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function exactManifestEnvelopeHashes(
  expected: readonly Uint8Array[],
  actual: readonly Uint8Array[],
): boolean {
  const canonicalActual = [...actual].sort(compareBytes);
  return expected.length === canonicalActual.length
    && expected.every((hash, index) => equalBytes(hash, canonicalActual[index]!));
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function cloneBinding(
  binding: HumanArtifactExactAccessBindingFact,
): HumanArtifactExactAccessBindingFact {
  return Object.freeze({
    ...binding,
    bindingHash: binding.bindingHash.slice(),
  });
}

function clonePlan(
  plan: HumanArtifactExactAccessPlan,
): HumanArtifactExactAccessPlan {
  return Object.freeze({
    ...plan,
    currentNamespaceIds: Object.freeze([...plan.currentNamespaceIds]),
    targetNamespaceIds: Object.freeze([...plan.targetNamespaceIds]),
    addedNamespaceIds: Object.freeze([...plan.addedNamespaceIds]),
    removedNamespaceIds: Object.freeze([...plan.removedNamespaceIds]),
    currentRequiredNamespaceFingerprint:
      plan.currentRequiredNamespaceFingerprint.slice(),
    targetRequiredNamespaceFingerprint:
      plan.targetRequiredNamespaceFingerprint.slice(),
    currentBindings: Object.freeze(plan.currentBindings.map(cloneBinding)),
    targetBindings: Object.freeze(plan.targetBindings.map(cloneBinding)),
  });
}

function text(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function counter(row: DatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw)
    : typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a safe counter`);
  }
  return value as number;
}

function bytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be bytea`);
  return Uint8Array.from(value);
}

type DurableHead = Readonly<{
  objectId: string;
  payloadHash: Uint8Array;
  accessRevision: number;
  manifestHash: Uint8Array;
  manifestBytes: Uint8Array;
  namespaceIds: readonly string[];
  envelopeHashes: readonly Uint8Array[];
  envelopeBytes: readonly Uint8Array[];
}>;

async function readHead(
  executor: CryptoPostgresExecutor,
  cryptoObjectId: string,
): Promise<DurableHead | null> {
  const heads = await executor.query(
    `SELECT h.object_id, h.access_revision, h.manifest_hash,
            m.payload_hash, m.manifest_bytes
       FROM object_crypto_access_heads h
       JOIN object_crypto_access_manifests m
         ON m.object_id=h.object_id AND m.access_revision=h.access_revision
        AND m.manifest_hash=h.manifest_hash
      WHERE h.object_id=$1 LIMIT 2 FOR UPDATE OF h`, [cryptoObjectId],
  );
  if (heads.length === 0) return null;
  if (heads.length !== 1) throw new Error("Artifact crypto head is not unique");
  const head = heads[0]!;
  const revision = counter(head, "access_revision");
  const envelopes = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
      ordinal: objectCryptoNamespaceEnvelopes.ordinal,
      envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
      envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
    }).from(objectCryptoNamespaceEnvelopes)
      .where(and(
        eq(objectCryptoNamespaceEnvelopes.objectId, cryptoObjectId),
        eq(objectCryptoNamespaceEnvelopes.accessRevision, revision),
      ))
      .orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal))
      .limit(257),
  );
  if (envelopes.length > 256) throw new Error("Artifact envelope set is oversized");
  const canonicalEnvelopes = envelopes.map((row, ordinal) => {
    if (counter(row, "ordinal") !== ordinal) {
      throw new Error("Artifact envelope ordering is invalid");
    }
    return Object.freeze({
      namespaceId: text(row, "namespace_id"),
      envelopeHash: bytes(row, "envelope_hash"),
      envelopeBytes: bytes(row, "envelope_bytes"),
    });
  }).sort((left, right) => left.namespaceId < right.namespaceId ? -1 : 1);
  if (canonicalEnvelopes.some((entry, index) =>
    index > 0 && canonicalEnvelopes[index - 1]!.namespaceId === entry.namespaceId
  )) throw new Error("Artifact envelope Namespace inventory is duplicated");
  return Object.freeze({
    objectId: text(head, "object_id"),
    payloadHash: bytes(head, "payload_hash"),
    accessRevision: revision,
    manifestHash: bytes(head, "manifest_hash"),
    manifestBytes: bytes(head, "manifest_bytes"),
    namespaceIds: Object.freeze(canonicalEnvelopes.map((entry) => entry.namespaceId)),
    envelopeHashes: Object.freeze(canonicalEnvelopes.map((entry) => entry.envelopeHash)),
    envelopeBytes: Object.freeze(canonicalEnvelopes.map((entry) => entry.envelopeBytes)),
  });
}

function envelopeFacts(input: Readonly<{
  crypto: LatticeCrypto;
  objectId: string;
  bindings: readonly HumanArtifactExactAccessBindingFact[];
  envelopeBytes: readonly Uint8Array[];
}>): readonly EnvelopeFact[] {
  if (input.bindings.length !== input.envelopeBytes.length) {
    throw new TypeError("Artifact binding and envelope inventories disagree");
  }
  return Object.freeze(input.envelopeBytes.map((raw, index) => {
    const binding = input.bindings[index]!;
    const envelope = decodeNamespaceObjectEnvelopeV2(raw);
    if (envelope.context.objectId !== input.objectId
      || envelope.context.namespaceId !== binding.namespaceId
      || envelope.context.keyClass !== "ai"
      || envelope.context.bindingRevisionAtWrap > binding.expectedAccessRevision) {
      throw new TypeError("Artifact envelope conflicts with its binding");
    }
    return Object.freeze({
      namespaceId: binding.namespaceId,
      keyGeneration: envelope.context.keyGeneration,
      bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
      envelopeHash: input.crypto.hash(raw),
    });
  }));
}

function inventoryEntries(
  bindings: readonly HumanArtifactExactAccessBindingFact[],
  envelopes: readonly EnvelopeFact[],
): readonly HumanArtifactAccessInventoryEntry[] {
  return Object.freeze(bindings.map((binding, index) => {
    const envelope = envelopes[index]!;
    return Object.freeze({
      namespaceId: binding.namespaceId as HumanArtifactAccessInventoryEntry["namespaceId"],
      domainId: cryptoDomainId(binding.domainId),
      expectedNamespaceAccessRevision: binding.expectedAccessRevision,
      expectedPolicyRevision: binding.expectedPolicyRevision,
      bindingHash: binding.bindingHash,
      keyGeneration: envelope.keyGeneration,
      bindingRevisionAtWrap: envelope.bindingRevisionAtWrap,
      envelopeHash: envelope.envelopeHash,
    });
  }));
}

function targetIsExact(durable: DurableHead, snapshot: PreparedSnapshot): boolean {
  return durable.accessRevision === snapshot.plan.nextCryptoAccessRevision
    && equalBytes(durable.manifestHash, snapshot.manifestHash)
    && equalBytes(durable.manifestBytes, snapshot.manifestBytes)
    && exactIds(durable.namespaceIds, snapshot.plan.targetNamespaceIds)
    && durable.envelopeBytes.length === snapshot.envelopeBytes.length
    && durable.envelopeBytes.every((value, index) =>
      equalBytes(value, snapshot.envelopeBytes[index]!));
}

export type ResolveHumanArtifactExactAccessPolicyRevision = (
  binding: HumanArtifactExactAccessBindingFact,
) => Promise<number | null>;

async function bindingsCurrent(input: Readonly<{
  executor: CryptoPostgresExecutor;
  bindings: readonly HumanArtifactExactAccessBindingFact[];
  resolvePolicyRevision: ResolveHumanArtifactExactAccessPolicyRevision;
}>): Promise<boolean> {
  for (const binding of input.bindings) {
    const rows = await executeTypedCryptoQuery(
      input.executor,
      cryptoTypedDb.select({
        namespace_id: namespaceCryptoHeads.namespaceId,
        access_revision: namespaceCryptoHeads.accessRevision,
        binding_hash: namespaceCryptoHeads.bindingHash,
        domain_id: namespaceCryptoHeads.domainId,
        writes_paused: cryptoDomains.writesPaused,
      }).from(namespaceCryptoHeads)
        .innerJoin(
          cryptoDomains,
          eq(cryptoDomains.id, namespaceCryptoHeads.domainId),
        )
        .where(eq(namespaceCryptoHeads.namespaceId, binding.namespaceId))
        .limit(2),
    );
    if (rows.length !== 1) return false;
    const row = rows[0]!;
    if (text(row, "namespace_id") !== binding.namespaceId
      || counter(row, "access_revision") !== binding.expectedAccessRevision
      || text(row, "domain_id") !== binding.domainId
      || !equalBytes(bytes(row, "binding_hash"), binding.bindingHash)
      || row["writes_paused"] !== false
      || await input.resolvePolicyRevision(binding) !== binding.expectedPolicyRevision) {
      return false;
    }
  }
  return true;
}

async function historicalWrapsAuthentic(input: Readonly<{
  executor: CryptoPostgresExecutor;
  crypto: LatticeCrypto;
  bindings: readonly HumanArtifactExactAccessBindingFact[];
  envelopes: readonly EnvelopeFact[];
  requireCurrent: ReadonlySet<string>;
  resolveHistoricalCommitter: HistoricalCommitterResolver;
}>): Promise<boolean> {
  for (let index = 0; index < input.bindings.length; index += 1) {
    const binding = input.bindings[index]!;
    const envelope = input.envelopes[index]!;
    if (envelope.namespaceId !== binding.namespaceId
      || envelope.bindingRevisionAtWrap > binding.expectedAccessRevision
      || (input.requireCurrent.has(binding.namespaceId)
        && envelope.bindingRevisionAtWrap !== binding.expectedAccessRevision)) return false;
    const rows = await executeTypedCryptoQuery(
      input.executor,
      cryptoTypedDb.select({
        namespace_id: namespaceCryptoBindings.namespaceId,
        revision: namespaceCryptoBindings.revision,
        binding_hash: namespaceCryptoBindings.bindingHash,
        signed_binding_bytes: namespaceCryptoBindings.signedBindingBytes,
      }).from(namespaceCryptoBindings)
        .where(and(
          eq(namespaceCryptoBindings.namespaceId, binding.namespaceId),
          eq(
            namespaceCryptoBindings.revision,
            envelope.bindingRevisionAtWrap,
          ),
        ))
        .limit(2),
    );
    if (rows.length !== 1) return false;
    const row = rows[0]!;
    const signed = bytes(row, "signed_binding_bytes");
    try {
      const parsed = parseNamespaceBindingV2(signed);
      if (text(row, "namespace_id") !== binding.namespaceId
        || counter(row, "revision") !== envelope.bindingRevisionAtWrap
        || !equalBytes(bytes(row, "binding_hash"), input.crypto.hash(signed))
        || parsed.namespaceId !== binding.namespaceId
        || parsed.domainId !== binding.domainId
        || parsed.accessRevision !== envelope.bindingRevisionAtWrap
        || parsed.aiCurrentGeneration !== envelope.keyGeneration) return false;
      verifyNamespaceBinding({ crypto: input.crypto, binding: parsed,
        resolveHistoricalCommitter: input.resolveHistoricalCommitter });
    } catch {
      return false;
    } finally {
      signed.fill(0);
    }
  }
  return true;
}

export class PostgresHumanArtifactExactAccessCryptoCompletion {
  readonly #handle: CryptoPostgresHandle;
  readonly #crypto: LatticeCrypto;
  readonly #resolveHistoricalBindingCommitter: HistoricalCommitterResolver;
  readonly #resolvePolicyRevision: ResolveHumanArtifactExactAccessPolicyRevision;
  readonly #resolveCurrentAuthority: ResolveCurrentHumanArtifactExactAccessAuthority;
  readonly #resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;

  constructor(input: Readonly<{
    handle: CryptoPostgresHandle;
    crypto: LatticeCrypto;
    resolveSigningPublicKey: ResolveDeviceSigningPublicKey;
    resolveHistoricalBindingCommitter: HistoricalCommitterResolver;
    resolvePolicyRevision: ResolveHumanArtifactExactAccessPolicyRevision;
    resolveCurrentAuthority: ResolveCurrentHumanArtifactExactAccessAuthority;
    resolveHistoricalAgentSignerAuthority?:
      ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  }>) {
    assertVerifiedCryptoPostgresHandle(input.handle);
    this.#handle = input.handle;
    this.#crypto = input.crypto;
    this.#resolveHistoricalBindingCommitter = input.resolveHistoricalBindingCommitter;
    this.#resolvePolicyRevision = input.resolvePolicyRevision;
    this.#resolveCurrentAuthority = input.resolveCurrentAuthority;
    this.#resolveHistoricalAgentSignerAuthority =
      input.resolveHistoricalAgentSignerAuthority
      ?? (() => Promise.resolve(null));
  }

  digestSignedRequest(prepared: ProtectedArtifactPreparedAccessRequestV1): Uint8Array {
    return this.#crypto.hash(Buffer.from(
      prepared.signedAccessRequestBytesBase64url,
      "base64url",
    ));
  }

  async authenticate(input: Readonly<{
    plan: HumanArtifactExactAccessPlan;
    prepared: ProtectedArtifactPreparedAccessRequestV1;
    now: number;
  }>): Promise<Readonly<{
    handle: AuthenticatedHumanArtifactExactAccessPrepared;
    signedRequestDigest: Uint8Array;
  }>> {
    const signedBytes = new Uint8Array(Buffer.from(
      input.prepared.signedAccessRequestBytesBase64url, "base64url"));
    const manifestBytes = new Uint8Array(Buffer.from(
      input.prepared.accessManifestBytesBase64url, "base64url"));
    const targetEnvelopeBytes = input.prepared.namespaceEnvelopes.map((entry) =>
      new Uint8Array(Buffer.from(entry.envelopeBytesBase64url, "base64url"))
    );
    let signerKey: Uint8Array | undefined;
    try {
      const current = await withVerifiedCryptoPostgresTransaction(
        this.#handle,
        (executor) => readHead(executor, input.plan.cryptoObjectId),
      );
      if (current === null
        || current.accessRevision !== input.plan.expectedCryptoAccessRevision
        || !exactIds(current.namespaceIds, input.plan.currentNamespaceIds)) {
        throw new TypeError("Human Artifact exact-access current head is stale");
      }
      const signed = verifyHumanArtifactExactAccessRequest(this.#crypto, {
        requestBytes: signedBytes,
        now: unixTimestamp(input.now),
        resolveCurrentAuthority: (context) => {
          const resolved = this.#resolveCurrentAuthority(context);
          signerKey = resolved?.slice();
          return resolved;
        },
      });
      if (signerKey === undefined) throw new TypeError(
        "Human Artifact exact-access signer is unavailable",
      );
      const currentEnvelopes = envelopeFacts({ crypto: this.#crypto,
        objectId: input.plan.cryptoObjectId, bindings: input.plan.currentBindings,
        envelopeBytes: current.envelopeBytes });
      const targetEnvelopes = envelopeFacts({ crypto: this.#crypto,
        objectId: input.plan.cryptoObjectId, bindings: input.plan.targetBindings,
        envelopeBytes: targetEnvelopeBytes });
      const currentInventory = fingerprintHumanArtifactAccessInventory(
        inventoryEntries(input.plan.currentBindings, currentEnvelopes),
      );
      const targetInventory = fingerprintHumanArtifactAccessInventory(
        inventoryEntries(input.plan.targetBindings, targetEnvelopes),
      );
      const verified = verifyCommonObjectAccessManifestChain(this.#crypto, {
        manifestBytes,
        proof: [],
        trustedMinimumHead: Object.freeze({
          objectId: objectId(current.objectId), payloadHash: current.payloadHash,
          accessRevision: accessRevision(current.accessRevision),
          manifestHash: current.manifestHash,
        }),
        resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
          context.committerDeviceId === signed.committerDeviceId
              && context.subjectHumanId === signed.subjectHumanId
            ? signerKey ?? null : null,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
      });
      const targetHashes = targetEnvelopeBytes.map((value) => this.#crypto.hash(value));
      const currentManifest = decodeObjectAccessManifestV5(current.manifestBytes);
      if (!exactManifestEnvelopeHashes(
        currentManifest.envelopeHashes,
        current.envelopeBytes.map((value) => this.#crypto.hash(value)),
      )) throw new TypeError(
        "Human Artifact current manifest envelope inventory is inexact",
      );
      if (signed.subjectHumanId !== input.plan.subjectHumanId
        || signed.operationId !== input.plan.operationId
        || signed.artifactId !== input.plan.artifactId
        || signed.artifactRevision !== input.plan.artifactRevision
        || signed.cryptoObjectId !== input.plan.cryptoObjectId
        || signed.blobId !== input.plan.blobId
        || signed.blobGeneration !== input.plan.blobGeneration
        || signed.expectedAccessRevision !== input.plan.expectedCryptoAccessRevision
        || signed.nextAccessRevision !== input.plan.nextCryptoAccessRevision) {
        throw new TypeError("Human Artifact signed access coordinates conflict with plan");
      }
      if (!equalBytes(signed.payloadHash, current.payloadHash)
        || !equalBytes(signed.currentManifestHash, current.manifestHash)
        || !equalBytes(signed.nextManifestHash, verified.manifestHash)
        || !equalBytes(signed.currentInventoryHash, currentInventory)
        || !equalBytes(signed.targetInventoryHash, targetInventory)) {
        throw new TypeError("Human Artifact signed access hashes conflict with plan");
      }
      if (verified.manifest.accessRevision !== input.plan.nextCryptoAccessRevision) {
        throw new TypeError("Human Artifact access manifest revision conflicts with plan");
      }
      if (verified.manifest.previousManifestHash === null
        || !equalBytes(verified.manifest.previousManifestHash, current.manifestHash)) {
        throw new TypeError("Human Artifact access manifest chain conflicts with plan");
      }
      if (!exactManifestEnvelopeHashes(
        verified.manifest.envelopeHashes,
        targetHashes,
      )) {
        throw new TypeError("Human Artifact access manifest envelopes conflict with plan");
      }
      if (input.prepared.artifactId !== input.plan.artifactId
        || input.prepared.artifactRevision !== input.plan.artifactRevision
        || input.prepared.cryptoObjectId !== input.plan.cryptoObjectId
        || input.prepared.blobId !== input.plan.blobId
        || input.prepared.blobGeneration !== input.plan.blobGeneration
        || !exactIds(input.prepared.currentNamespaceIds,
          input.plan.currentNamespaceIds)
        || !exactIds(input.prepared.targetNamespaceIds,
          input.plan.targetNamespaceIds)) {
        throw new TypeError("Human Artifact prepared access transport conflicts with plan");
      }
      const handle = Object.freeze({}) as AuthenticatedHumanArtifactExactAccessPrepared;
      const ownedPlan = clonePlan(input.plan);
      const signedRequestDigest = this.#crypto.hash(signedBytes);
      authenticated.set(handle, Object.freeze({
        plan: ownedPlan,
        currentEnvelopes: currentEnvelopes.map((entry) => Object.freeze({
          ...entry, envelopeHash: entry.envelopeHash.slice(),
        })),
        targetEnvelopes: targetEnvelopes.map((entry) => Object.freeze({
          ...entry, envelopeHash: entry.envelopeHash.slice(),
        })),
        manifestBytes: manifestBytes.slice(),
        manifestHash: verified.manifestHash.slice(),
        envelopeBytes: Object.freeze(targetEnvelopeBytes.map((value) => value.slice())),
        signedRequestDigest: signedRequestDigest.slice(),
      }));
      return Object.freeze({ handle,
        signedRequestDigest });
    } finally {
      signedBytes.fill(0);
      manifestBytes.fill(0);
      targetEnvelopeBytes.forEach((value) => value.fill(0));
      signerKey?.fill(0);
    }
  }

  async complete(
    handle: AuthenticatedHumanArtifactExactAccessPrepared,
  ): Promise<HumanArtifactExactAccessCryptoReceipt> {
    const snapshot = authenticated.get(handle as object);
    if (snapshot === undefined) throw new TypeError(
      "Human Artifact access completion requires authentic preparation",
    );
    try {
      return await withVerifiedCryptoPostgresTransaction(this.#handle, async (executor) => {
      const durable = await readHead(executor, snapshot.plan.cryptoObjectId);
      if (durable === null) throw new Error("Human Artifact crypto object is absent");
      await assertStoredChainAuthentic({
        executor,
        crypto: this.#crypto,
        objectId: durable.objectId,
        headAccessRevision: durable.accessRevision,
        expectedPayloadHash: durable.payloadHash,
        expectedHeadManifestHash: durable.manifestHash,
        resolveHistoricalAgentManagerAuthority:
          this.#resolveHistoricalAgentSignerAuthority,
      });
      let status: "applied" | "duplicate";
      if (targetIsExact(durable, snapshot)) {
        status = "duplicate";
      } else {
        if (durable.accessRevision !== snapshot.plan.expectedCryptoAccessRevision
          || !equalBytes(durable.manifestHash,
            decodeObjectAccessManifestV5(snapshot.manifestBytes).previousManifestHash!)
          || !exactIds(durable.namespaceIds, snapshot.plan.currentNamespaceIds)) {
          throw new Error("Human Artifact crypto head became stale");
        }
        const added = new Set(snapshot.plan.addedNamespaceIds);
        if (!await bindingsCurrent({ executor, bindings: snapshot.plan.currentBindings,
          resolvePolicyRevision: this.#resolvePolicyRevision })
          || !await bindingsCurrent({ executor, bindings: snapshot.plan.targetBindings,
            resolvePolicyRevision: this.#resolvePolicyRevision })
          || !await historicalWrapsAuthentic({ executor, crypto: this.#crypto,
            bindings: snapshot.plan.currentBindings,
            envelopes: snapshot.currentEnvelopes, requireCurrent: new Set(),
            resolveHistoricalCommitter: this.#resolveHistoricalBindingCommitter })
          || !await historicalWrapsAuthentic({ executor, crypto: this.#crypto,
            bindings: snapshot.plan.targetBindings,
            envelopes: snapshot.targetEnvelopes, requireCurrent: added,
            resolveHistoricalCommitter: this.#resolveHistoricalBindingCommitter })) {
          throw new Error("Human Artifact binding authority became stale");
        }
        const manifest = decodeObjectAccessManifestV5(snapshot.manifestBytes);
        await executeTypedCryptoQuery(
          executor,
          cryptoTypedDb.insert(objectCryptoAccessManifests).values({
            objectId: snapshot.plan.cryptoObjectId,
            accessRevision: snapshot.plan.nextCryptoAccessRevision,
            manifestHash: snapshot.manifestHash,
            previousManifestHash: manifest.previousManifestHash,
            payloadHash: manifest.payloadHash,
            manifestBytes: snapshot.manifestBytes,
          }),
        );
        for (const [ordinal, raw] of snapshot.envelopeBytes.entries()) {
          const fact = snapshot.targetEnvelopes[ordinal]!;
          await executeTypedCryptoQuery(
            executor,
            cryptoTypedDb.insert(objectCryptoNamespaceEnvelopes).values({
              objectId: snapshot.plan.cryptoObjectId,
              accessRevision: snapshot.plan.nextCryptoAccessRevision,
              namespaceId: fact.namespaceId,
              ordinal,
              envelopeHash: fact.envelopeHash,
              envelopeBytes: raw,
            }),
          );
        }
        const advanced = await executeTypedCryptoQuery(
          executor,
          cryptoTypedDb.update(objectCryptoAccessHeads).set({
            accessRevision: snapshot.plan.nextCryptoAccessRevision,
            manifestHash: snapshot.manifestHash,
          }).where(and(
            eq(objectCryptoAccessHeads.objectId, snapshot.plan.cryptoObjectId),
            eq(
              objectCryptoAccessHeads.accessRevision,
              snapshot.plan.expectedCryptoAccessRevision,
            ),
            eq(
              objectCryptoAccessHeads.manifestHash,
              manifest.previousManifestHash!,
            ),
          )).returning({ object_id: objectCryptoAccessHeads.objectId }),
        );
        if (advanced.length !== 1) throw new Error("Artifact access head CAS failed");
        status = "applied";
      }
      const verified = await readHead(executor, snapshot.plan.cryptoObjectId);
      if (verified === null || !targetIsExact(verified, snapshot)) {
        throw new Error("Human Artifact access receipt is not durable");
      }
      return Object.freeze({
        operationId: snapshot.plan.operationId,
        artifactId: snapshot.plan.artifactId,
        objectId: snapshot.plan.cryptoObjectId,
        artifactRevision: snapshot.plan.artifactRevision,
        blobId: snapshot.plan.blobId,
        blobGeneration: snapshot.plan.blobGeneration,
        expectedAccessRevision: snapshot.plan.expectedCryptoAccessRevision,
        resultAccessRevision: snapshot.plan.nextCryptoAccessRevision,
        currentManifestHash:
          decodeObjectAccessManifestV5(snapshot.manifestBytes).previousManifestHash!.slice(),
        resultManifestHash: snapshot.manifestHash.slice(),
        targetRequiredNamespaceFingerprint:
          snapshot.plan.targetRequiredNamespaceFingerprint.slice(),
        requestDigest: snapshot.signedRequestDigest.slice(),
        currentNamespaceIds: snapshot.plan.currentNamespaceIds,
        targetNamespaceIds: snapshot.plan.targetNamespaceIds,
        status,
      });
      });
    } finally {
      authenticated.delete(handle as object);
      snapshot.manifestBytes.fill(0);
      snapshot.manifestHash.fill(0);
      snapshot.envelopeBytes.forEach((value) => value.fill(0));
      snapshot.currentEnvelopes.forEach((entry) => entry.envelopeHash.fill(0));
      snapshot.targetEnvelopes.forEach((entry) => entry.envelopeHash.fill(0));
      snapshot.signedRequestDigest.fill(0);
      snapshot.plan.currentRequiredNamespaceFingerprint.fill(0);
      snapshot.plan.targetRequiredNamespaceFingerprint.fill(0);
      snapshot.plan.currentBindings.forEach((binding) => binding.bindingHash.fill(0));
      snapshot.plan.targetBindings.forEach((binding) => binding.bindingHash.fill(0));
    }
  }

  observe(cryptoObjectId: string): Promise<HumanArtifactExactAccessCryptoObservation> {
    return withVerifiedCryptoPostgresTransaction(this.#handle, async (executor) => {
      const durable = await readHead(executor, cryptoObjectId);
      if (durable === null) return Object.freeze({ status: "absent" as const });
      await assertStoredChainAuthentic({
        executor,
        crypto: this.#crypto,
        objectId: durable.objectId,
        headAccessRevision: durable.accessRevision,
        expectedPayloadHash: durable.payloadHash,
        expectedHeadManifestHash: durable.manifestHash,
        resolveHistoricalAgentManagerAuthority:
          this.#resolveHistoricalAgentSignerAuthority,
      });
      const manifest = decodeObjectAccessManifestV5(durable.manifestBytes);
      return manifest.previousManifestHash === null
        ? Object.freeze({ status: "current" as const, objectId: cryptoObjectId,
            accessRevision: durable.accessRevision,
            manifestHash: durable.manifestHash, namespaceIds: durable.namespaceIds })
        : Object.freeze({ status: "target" as const, objectId: cryptoObjectId,
            accessRevision: durable.accessRevision,
            manifestHash: durable.manifestHash,
            previousManifestHash: manifest.previousManifestHash.slice(),
            namespaceIds: durable.namespaceIds });
    });
  }
}
