import {
  and,
  asc,
  eq,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
} from "@nautilo/db";
import {
  accessRevision,
  objectId,
  verifyHumanMemoryExactAccessRequest,
  type HumanMemoryExactAccessRequestEntry,
  type LatticeCrypto,
  type ResolveCurrentHumanMemoryExactAccessAuthority,
  unixTimestamp,
  verifyCommonObjectAccessManifestChain,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanMemoryExactAccessRequestV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";
import { sha256 } from "@noble/hashes/sha2.js";

import type {
  HumanMemoryExactAccessCryptoObservation,
  HumanMemoryExactAccessCryptoReceipt,
  HumanMemoryExactAccessPlan,
  HumanMemoryExactAccessPublicationAuthority,
  HumanMemoryExactAccessReplayAdmission,
} from "./postgres-human-memory-exact-access-product.ts";
import { assertHumanMemoryExactAccessReplayAdmission } from
  "./postgres-human-memory-exact-access-product.ts";
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
import {
  lockCurrentMemoryNativeAccessEntries,
  memoryNativeAccessEntriesAuthentic,
} from
  "./native-memory-access-authority.ts";

type ResolveLiveShadowAgentSigner = NonNullable<Parameters<
  typeof verifyStoredObjectAccessManifestChainV5
>[0]["resolveLiveShadowAgentSigner"]>;

async function assertStoredChainAuthentic(input: Parameters<
  typeof verifyStoredObjectAccessManifestChainV5
>[0]): Promise<void> {
  const verified = await verifyStoredObjectAccessManifestChainV5(input);
  destroyVerifiedStoredObjectAccessManifestChainV5(verified);
}

type PreparedSnapshot = Readonly<{
  plan: HumanMemoryExactAccessPlan;
  authority: HumanMemoryExactAccessPublicationAuthority;
  manifestBytes: Uint8Array;
  manifestHash: Uint8Array;
  envelopeBytes: readonly Uint8Array[];
  signedRequestDigest: Uint8Array;
}>;

declare const authenticatedPreparedBrand: unique symbol;
export type AuthenticatedHumanMemoryExactAccessPrepared = Readonly<{
  [authenticatedPreparedBrand]: true;
}>;

const authenticatedPrepared = new WeakMap<object, PreparedSnapshot>();

export function readAuthenticatedHumanMemoryExactAccessAuthority(
  prepared: AuthenticatedHumanMemoryExactAccessPrepared,
): HumanMemoryExactAccessPublicationAuthority {
  const snapshot = authenticatedPrepared.get(prepared as object);
  if (snapshot === undefined) {
    throw new TypeError("Human Memory exact-access handle is not authenticated");
  }
  return cloneAuthority(snapshot.authority);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function cloneAuthority(
  authority: HumanMemoryExactAccessPublicationAuthority,
): HumanMemoryExactAccessPublicationAuthority {
  const entries = (values: readonly HumanMemoryExactAccessRequestEntry[]) =>
    Object.freeze(values.map((entry) => Object.freeze({
    ...entry,
    headDigest: entry.headDigest.slice(),
    publicationDigest: entry.publicationDigest.slice(),
    publicationSetDigest: entry.publicationSetDigest.slice(),
    audienceFingerprint: entry.audienceFingerprint.slice(),
    envelopeHash: entry.envelopeHash.slice(),
  })));
  const authorityEntries = (values: typeof authority.currentAuthorityEntries) =>
    Object.freeze(values.map((entry) => Object.freeze({ ...entry,
      headDigest: entry.headDigest.slice(),
      publicationDigest: entry.publicationDigest.slice(),
      publicationSetDigest: entry.publicationSetDigest.slice(),
      audienceFingerprint: entry.audienceFingerprint.slice(),
    })));
  return Object.freeze({
    ...authority,
    payloadHash: authority.payloadHash.slice(),
    currentManifestHash: authority.currentManifestHash.slice(),
    nextManifestHash: authority.nextManifestHash.slice(),
    currentEntries: entries(authority.currentEntries),
    targetEntries: entries(authority.targetEntries),
    currentAuthorityEntries: authorityEntries(authority.currentAuthorityEntries),
    targetAuthorityEntries: authorityEntries(authority.targetAuthorityEntries),
  });
}

function authorityFromSigned(
  signed: ReturnType<typeof verifyHumanMemoryExactAccessRequest>,
): HumanMemoryExactAccessPublicationAuthority {
  const copy = (entries: readonly HumanMemoryExactAccessRequestEntry[]) =>
    cloneAuthority({ purpose: "persist-human-memory-native-access-update",
      operationId: signed.operationId, objectId: signed.cryptoObjectId,
      payloadHash: signed.payloadHash, expectedContentRevision: signed.expectedContentRevision,
      currentAccessRevision: signed.expectedAccessRevision,
      currentManifestHash: signed.currentManifestHash,
      nextAccessRevision: signed.nextAccessRevision, nextManifestHash: signed.nextManifestHash,
      currentEntries: entries, targetEntries: [],
      currentAuthorityEntries: signed.currentAuthorityEntries,
      targetAuthorityEntries: signed.targetAuthorityEntries,
      subjectHumanId: signed.subjectHumanId,
      committerDeviceId: signed.committerDeviceId,
      hostAuthorizationRevision: signed.hostAuthorizationRevision }).currentEntries;
  return Object.freeze({
    purpose: "persist-human-memory-native-access-update",
    operationId: signed.operationId,
    objectId: signed.cryptoObjectId,
    payloadHash: signed.payloadHash.slice(),
    expectedContentRevision: signed.expectedContentRevision,
    currentAccessRevision: signed.expectedAccessRevision,
    currentManifestHash: signed.currentManifestHash.slice(),
    nextAccessRevision: signed.nextAccessRevision,
    nextManifestHash: signed.nextManifestHash.slice(),
    currentEntries: copy(signed.currentEntries),
    targetEntries: copy(signed.targetEntries),
    currentAuthorityEntries: signed.currentAuthorityEntries.map((entry) => ({
      ...entry, headDigest: entry.headDigest.slice(),
      publicationDigest: entry.publicationDigest.slice(),
      publicationSetDigest: entry.publicationSetDigest.slice(),
      audienceFingerprint: entry.audienceFingerprint.slice(),
    })),
    targetAuthorityEntries: signed.targetAuthorityEntries.map((entry) => ({
      ...entry, headDigest: entry.headDigest.slice(),
      publicationDigest: entry.publicationDigest.slice(),
      publicationSetDigest: entry.publicationSetDigest.slice(),
      audienceFingerprint: entry.audienceFingerprint.slice(),
    })),
    subjectHumanId: signed.subjectHumanId,
    committerDeviceId: signed.committerDeviceId,
    hostAuthorizationRevision: signed.hostAuthorizationRevision,
  });
}

/**
 * Server-local authenticity bridge. HTTP structural bytes are admitted only
 * after their signed request, signed N+1 manifest, and exact envelope set have
 * all been authenticated; only this function can mint the opaque handle.
 */
export function authenticateHumanMemoryExactAccessPrepared(input: Readonly<{
  crypto: LatticeCrypto;
  plan: HumanMemoryExactAccessPlan;
  signedRequestBytes: Uint8Array;
  manifestBytes: Uint8Array;
  envelopeBytes: readonly Uint8Array[];
  now: number;
  resolveCurrentAuthority: ResolveCurrentHumanMemoryExactAccessAuthority;
  replayAdmission?: HumanMemoryExactAccessReplayAdmission;
}>): AuthenticatedHumanMemoryExactAccessPrepared {
  let verificationTime = input.now;
  if (input.replayAdmission !== undefined) {
    const decoded = decodeHumanMemoryExactAccessRequestV2(input.signedRequestBytes);
    const requestDigest = sha256(input.signedRequestBytes);
    try {
      assertHumanMemoryExactAccessReplayAdmission({
        admission: input.replayAdmission,
        operationId: decoded.operationId,
        memoryId: decoded.memoryId,
        subjectHumanId: decoded.subjectHumanId,
        requestDigest,
      });
      verificationTime = Number(decoded.issuedAt);
    } finally {
      requestDigest.fill(0);
      decoded.payloadHash.fill(0);
      decoded.currentManifestHash.fill(0);
      decoded.nextManifestHash.fill(0);
      decoded.signature.fill(0);
      for (const entry of [...decoded.currentEntries, ...decoded.targetEntries]) {
        entry.headDigest.fill(0);
        entry.publicationDigest.fill(0);
        entry.publicationSetDigest.fill(0);
        entry.audienceFingerprint.fill(0);
        entry.envelopeHash.fill(0);
      }
    }
  }
  let committerSigningPublicKey: Uint8Array | undefined;
  const signed = verifyHumanMemoryExactAccessRequest(input.crypto, {
    requestBytes: input.signedRequestBytes,
    now: unixTimestamp(verificationTime),
    resolveCurrentAuthority: (context) => {
      const resolved = input.resolveCurrentAuthority(context);
      committerSigningPublicKey = resolved?.slice();
      return resolved;
    },
  });
  const authority = authorityFromSigned(signed);
  if (committerSigningPublicKey === undefined) {
    throw new TypeError("Human Memory exact-access signer authority is unavailable");
  }
  const verifiedManifest = verifyCommonObjectAccessManifestChain(input.crypto, {
    manifestBytes: input.manifestBytes,
    proof: [],
    trustedMinimumHead: {
      objectId: objectId(signed.cryptoObjectId),
      payloadHash: signed.payloadHash,
      accessRevision: accessRevision(signed.expectedAccessRevision),
      manifestHash: signed.currentManifestHash,
    },
    resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
      context.committerDeviceId === signed.committerDeviceId
          && context.subjectHumanId === signed.subjectHumanId
        ? committerSigningPublicKey ?? null
        : null,
    resolveAgentRuntimeSignerPublicKey: () => null,
    resolveProcessorSignerAuthorizationBytes: () => null,
    resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
  });
  const targetEnvelopeHashes = input.envelopeBytes.map((bytes, index) => {
    const decoded = decodeNamespaceObjectEnvelopeV2(bytes);
    const expected = signed.targetEntries[index];
    if (
      expected === undefined
      || decoded.context.objectId !== signed.cryptoObjectId
      || decoded.context.namespaceId !== expected.namespaceId
      || decoded.context.keyClass !== "ai"
      || decoded.context.keyGeneration !== expected.keyGeneration
      || decoded.context.bindingRevisionAtWrap !== expected.namespaceAccessRevision
    ) throw new TypeError(
      "Human Memory exact-access envelope conflicts with its signed request",
    );
    return input.crypto.hash(bytes);
  }).sort((left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      const delta = left[index]! - right[index]!;
      if (delta !== 0) return delta;
    }
    return 0;
  });
  if (
    signed.subjectHumanId !== input.plan.subjectHumanId
    || signed.operationId !== input.plan.operationId
    || signed.memoryId !== input.plan.memoryId
    || signed.cryptoObjectId !== input.plan.cryptoObjectId
    || !bytesEqual(signed.payloadHash, authority.payloadHash)
    || signed.expectedContentRevision !== input.plan.expectedContentRevision
    || signed.expectedAccessRevision
      !== input.plan.expectedCryptoAccessRevision
    || signed.nextAccessRevision !== input.plan.nextCryptoAccessRevision
    || !bytesEqual(signed.currentManifestHash, authority.currentManifestHash)
    || !bytesEqual(signed.nextManifestHash, authority.nextManifestHash)
    || signed.committerDeviceId !== authority.committerDeviceId
    || signed.hostAuthorizationRevision !== authority.hostAuthorizationRevision
    || authority.operationId !== input.plan.operationId
    || !exactIds(
      authority.currentEntries.map((entry) => entry.namespaceId),
      input.plan.currentNamespaceIds,
    )
    || !exactIds(
      authority.targetEntries.map((entry) => entry.namespaceId),
      input.plan.targetNamespaceIds,
    )
    || !exactIds(authority.currentAuthorityEntries.map((entry) => entry.namespaceId),
      input.plan.currentNamespaceIds)
    || !exactIds(authority.targetAuthorityEntries.map((entry) => entry.namespaceId),
      input.plan.targetNamespaceIds)
    || verifiedManifest.manifest.accessRevision !== signed.nextAccessRevision
    || verifiedManifest.manifest.signer.kind !== "human_device"
    || verifiedManifest.manifest.signer.committerDeviceId
      !== signed.committerDeviceId
    || verifiedManifest.manifest.signer.subjectHumanId !== signed.subjectHumanId
    || verifiedManifest.manifest.hostAuthorizationRevision
      !== signed.hostAuthorizationRevision
    || !bytesEqual(verifiedManifest.manifestHash, signed.nextManifestHash)
    || verifiedManifest.manifest.envelopeHashes.length
      !== targetEnvelopeHashes.length
    || verifiedManifest.manifest.envelopeHashes.some((hash, index) =>
      !bytesEqual(hash, targetEnvelopeHashes[index]!)
    )
    || input.envelopeBytes.length !== signed.targetEntries.length
    || input.envelopeBytes.some((bytes, index) =>
      !bytesEqual(input.crypto.hash(bytes), signed.targetEntries[index]!.envelopeHash)
    )
  ) throw new TypeError("Human Memory exact-access prepared set conflicts with its product plan");
  const handle = Object.freeze({}) as AuthenticatedHumanMemoryExactAccessPrepared;
  authenticatedPrepared.set(handle, Object.freeze({
    plan: input.plan,
    authority: cloneAuthority(authority),
    manifestBytes: input.manifestBytes.slice(),
    manifestHash: verifiedManifest.manifestHash.slice(),
    envelopeBytes: Object.freeze(input.envelopeBytes.map((bytes) =>
      bytes.slice()
    )),
    signedRequestDigest: input.crypto.hash(input.signedRequestBytes),
  }));
  return handle;
}

function rowString(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function rowCounter(row: DatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw)
    : typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a safe counter`);
  }
  return value as number;
}

function rowBytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be bytea`);
  return Uint8Array.from(value);
}

function one(rows: readonly DatabaseRow[], label: string): DatabaseRow {
  if (rows.length !== 1) throw new Error(`${label} must exist exactly once`);
  return rows[0]!;
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
  objectId: string,
): Promise<DurableHead | null> {
  const heads = await executor.query(
    `/* human-memory:exact-access-crypto:head */
     SELECT h.object_id, h.access_revision, h.manifest_hash,
            m.payload_hash, m.manifest_bytes
       FROM object_crypto_access_heads h
       JOIN object_crypto_access_manifests m
         ON m.object_id = h.object_id
        AND m.access_revision = h.access_revision
        AND m.manifest_hash = h.manifest_hash
      WHERE h.object_id = $1 LIMIT 2 FOR UPDATE OF h`,
    [objectId],
  );
  if (heads.length === 0) return null;
  const head = one(heads, "Human Memory exact-access crypto head");
  const revision = rowCounter(head, "access_revision");
  const envelopes = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
      ordinal: objectCryptoNamespaceEnvelopes.ordinal,
      envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
      envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
    }).from(objectCryptoNamespaceEnvelopes)
      .where(and(
        eq(objectCryptoNamespaceEnvelopes.objectId, objectId),
        eq(objectCryptoNamespaceEnvelopes.accessRevision, revision),
      ))
      .orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal))
      .limit(257),
  );
  if (envelopes.length > 256) throw new Error("Human Memory exact-access envelope inventory is oversized");
  const canonicalEnvelopes = envelopes.map((row, ordinal) => {
    if (rowCounter(row, "ordinal") !== ordinal) {
      throw new Error("Human Memory exact-access envelope ordinal is invalid");
    }
    return Object.freeze({
      namespaceId: rowString(row, "namespace_id"),
      envelopeHash: rowBytes(row, "envelope_hash"),
      envelopeBytes: rowBytes(row, "envelope_bytes"),
    });
  }).sort((left, right) => left.namespaceId < right.namespaceId ? -1 : 1);
  if (canonicalEnvelopes.some((entry, index) =>
    index > 0 && canonicalEnvelopes[index - 1]!.namespaceId === entry.namespaceId
  )) throw new Error("Human Memory exact-access Namespace inventory is duplicated");
  return Object.freeze({
    objectId: rowString(head, "object_id"),
    payloadHash: rowBytes(head, "payload_hash"),
    accessRevision: revision,
    manifestHash: rowBytes(head, "manifest_hash"),
    manifestBytes: rowBytes(head, "manifest_bytes"),
    namespaceIds: Object.freeze(canonicalEnvelopes.map((entry) => entry.namespaceId)),
    envelopeHashes: Object.freeze(canonicalEnvelopes.map((entry) => entry.envelopeHash)),
    envelopeBytes: Object.freeze(canonicalEnvelopes.map((entry) => entry.envelopeBytes)),
  });
}

function durableMatchesAuthority(
  durable: DurableHead,
  authority: HumanMemoryExactAccessPublicationAuthority,
): boolean {
  return durable.objectId === authority.objectId
    && durable.accessRevision === authority.currentAccessRevision
    && bytesEqual(durable.payloadHash, authority.payloadHash)
    && bytesEqual(durable.manifestHash, authority.currentManifestHash)
    && exactIds(durable.namespaceIds, authority.currentEntries.map((entry) => entry.namespaceId))
    && durable.envelopeHashes.length === authority.currentEntries.length
    && durable.envelopeHashes.every((hash, index) => {
      const expected = authority.currentEntries[index]!;
      const decoded = decodeNamespaceObjectEnvelopeV2(durable.envelopeBytes[index]!);
      return expected.namespaceId === durable.namespaceIds[index]
        && decoded.context.namespaceId === expected.namespaceId
        && decoded.context.objectId === authority.objectId
        && decoded.context.keyClass === "ai"
        && decoded.context.keyGeneration === expected.keyGeneration
        && decoded.context.bindingRevisionAtWrap === expected.namespaceAccessRevision
        && bytesEqual(hash, expected.envelopeHash)
        && bytesEqual(sha256(durable.envelopeBytes[index]!), hash);
    });
}

function durableAuthorityMismatch(
  durable: DurableHead,
  authority: HumanMemoryExactAccessPublicationAuthority,
): string {
  if (durable.objectId !== authority.objectId) return "object";
  if (durable.accessRevision !== authority.currentAccessRevision) return "revision";
  if (!bytesEqual(durable.payloadHash, authority.payloadHash)) {
    const durableZero = durable.payloadHash.every((byte) => byte === 0);
    const authorityZero = authority.payloadHash.every((byte) => byte === 0);
    return durableZero ? "payload-durable-zero"
      : authorityZero ? "payload-authority-zero"
      : "payload";
  }
  if (!bytesEqual(durable.manifestHash, authority.currentManifestHash)) return "manifest";
  if (!exactIds(
    durable.namespaceIds,
    authority.currentEntries.map((entry) => entry.namespaceId),
  )) return "namespace-set";
  if (durable.envelopeHashes.length !== authority.currentEntries.length) {
    return "envelope-count";
  }
  return "envelope";
}

function exactTarget(
  durable: DurableHead,
  snapshot: PreparedSnapshot,
): boolean {
  return durable.accessRevision === snapshot.authority.nextAccessRevision
    && bytesEqual(durable.manifestHash, snapshot.manifestHash)
    && bytesEqual(durable.manifestBytes, snapshot.manifestBytes)
    && exactIds(durable.namespaceIds,
      snapshot.authority.targetEntries.map((entry) => entry.namespaceId))
    && durable.envelopeBytes.length === snapshot.envelopeBytes.length
    && durable.envelopeBytes.every((bytes, index) =>
      bytesEqual(bytes, snapshot.envelopeBytes[index]!)
    );
}

export class PostgresHumanMemoryExactAccessCryptoCompletion {
  readonly #handle: CryptoPostgresHandle;
  readonly #crypto: LatticeCrypto;
  readonly #resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  readonly #resolveLiveShadowAgentSigner: ResolveLiveShadowAgentSigner;

  constructor(input: Readonly<{
    handle: CryptoPostgresHandle;
    crypto: LatticeCrypto;
    resolveHistoricalAgentSignerAuthority?:
      ResolveHistoricalAgentRuntimeSignerManagerAuthority;
    resolveLiveShadowAgentSigner?: ResolveLiveShadowAgentSigner;
  }>) {
    assertVerifiedCryptoPostgresHandle(input.handle);
    this.#handle = input.handle;
    this.#crypto = input.crypto;
    this.#resolveHistoricalAgentSignerAuthority =
      input.resolveHistoricalAgentSignerAuthority
      ?? (() => Promise.resolve(null));
    this.#resolveLiveShadowAgentSigner =
      input.resolveLiveShadowAgentSigner
      ?? (() => Promise.resolve(null));
  }

  async complete(
    prepared: AuthenticatedHumanMemoryExactAccessPrepared,
  ): Promise<HumanMemoryExactAccessCryptoReceipt> {
    const snapshot = authenticatedPrepared.get(prepared as object);
    if (snapshot === undefined) {
      throw new TypeError("Human Memory exact-access completion requires an authenticated prepared handle");
    }
    return withVerifiedCryptoPostgresTransaction(this.#handle, async (executor) => {
      const durable = await readHead(executor, snapshot.authority.objectId);
      if (durable === null) throw new Error("Human Memory exact-access crypto object is absent");
      const durablePayloadBeforeAuthentication = durable.payloadHash.slice();
      await assertStoredChainAuthentic({
        executor,
        crypto: this.#crypto,
        objectId: durable.objectId,
        headAccessRevision: durable.accessRevision,
        expectedPayloadHash: durable.payloadHash,
        expectedHeadManifestHash: durable.manifestHash,
        resolveHistoricalAgentManagerAuthority:
          this.#resolveHistoricalAgentSignerAuthority,
        resolveLiveShadowAgentSigner: this.#resolveLiveShadowAgentSigner,
      });
      if (!bytesEqual(
        durable.payloadHash,
        durablePayloadBeforeAuthentication,
      )) {
        durablePayloadBeforeAuthentication.fill(0);
        throw new Error(
          "Human Memory stored-chain authentication mutated durable payload evidence",
        );
      }
      durablePayloadBeforeAuthentication.fill(0);
      const preparedManifest = decodeObjectAccessManifestV5(
        snapshot.manifestBytes,
      );
      if (!bytesEqual(
        snapshot.authority.payloadHash,
        preparedManifest.payloadHash,
      )) {
        throw new Error(
          "Human Memory authenticated request payload disagrees with its prepared manifest",
        );
      }
      let status: "applied" | "duplicate";
      if (exactTarget(durable, snapshot)) {
        status = "duplicate";
      } else {
        if (!durableMatchesAuthority(durable, snapshot.authority)) {
          throw new Error(
            `Human Memory exact-access crypto head is stale: ${durableAuthorityMismatch(durable, snapshot.authority)}`,
          );
        }
        if (
          !await memoryNativeAccessEntriesAuthentic({
            executor,
            entries: snapshot.authority.currentEntries,
          })
          || !await memoryNativeAccessEntriesAuthentic({
            executor,
            entries: snapshot.authority.targetEntries,
          })
          || !await lockCurrentMemoryNativeAccessEntries({
            executor,
            entries: snapshot.authority.currentAuthorityEntries,
          })
          || !await lockCurrentMemoryNativeAccessEntries({
            executor,
            entries: snapshot.authority.targetAuthorityEntries,
          })
        ) throw new Error("Human Memory exact-access binding authority is stale");
        const manifest = decodeObjectAccessManifestV5(snapshot.manifestBytes);
        if (
          manifest.objectId !== snapshot.authority.objectId
          || manifest.accessRevision !== snapshot.authority.nextAccessRevision
          || manifest.previousManifestHash === null
          || !bytesEqual(manifest.previousManifestHash, snapshot.authority.currentManifestHash)
          || !bytesEqual(manifest.payloadHash, snapshot.authority.payloadHash)
          || !bytesEqual(snapshot.manifestHash, snapshot.authority.nextManifestHash)
          || !bytesEqual(sha256(snapshot.manifestBytes), snapshot.manifestHash)
          || manifest.envelopeHashes.length !== snapshot.envelopeBytes.length
        ) throw new Error("Human Memory exact-access prepared manifest is invalid");
        await executeTypedCryptoQuery(
          executor,
          cryptoTypedDb.insert(objectCryptoAccessManifests).values({
            objectId: snapshot.authority.objectId,
            accessRevision: snapshot.authority.nextAccessRevision,
            manifestHash: snapshot.manifestHash,
            previousManifestHash: snapshot.authority.currentManifestHash,
            payloadHash: snapshot.authority.payloadHash,
            manifestBytes: snapshot.manifestBytes,
          }),
        );
        for (const [ordinal, bytes] of snapshot.envelopeBytes.entries()) {
          const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
          const expected = snapshot.authority.targetEntries[ordinal];
          const hash = sha256(bytes);
          if (
            expected === undefined
            || envelope.context.namespaceId !== expected.namespaceId
            || envelope.context.objectId !== snapshot.authority.objectId
            || envelope.context.keyClass !== "ai"
            || !bytesEqual(hash, expected.envelopeHash)
          ) throw new Error("Human Memory exact-access target envelope is invalid");
          await executeTypedCryptoQuery(
            executor,
            cryptoTypedDb.insert(objectCryptoNamespaceEnvelopes).values({
              objectId: snapshot.authority.objectId,
              accessRevision: snapshot.authority.nextAccessRevision,
              namespaceId: expected.namespaceId,
              ordinal,
              envelopeHash: hash,
              envelopeBytes: bytes,
            }),
          );
        }
        const advanced = await executeTypedCryptoQuery(
          executor,
          cryptoTypedDb.update(objectCryptoAccessHeads).set({
            accessRevision: snapshot.authority.nextAccessRevision,
            manifestHash: snapshot.manifestHash,
          }).where(and(
            eq(objectCryptoAccessHeads.objectId, snapshot.authority.objectId),
            eq(
              objectCryptoAccessHeads.accessRevision,
              snapshot.authority.currentAccessRevision,
            ),
            eq(
              objectCryptoAccessHeads.manifestHash,
              snapshot.authority.currentManifestHash,
            ),
          )).returning({ object_id: objectCryptoAccessHeads.objectId }),
        );
        if (advanced.length !== 1) throw new Error("Human Memory exact-access head CAS failed");
        status = "applied";
      }
      const verified = await readHead(executor, snapshot.authority.objectId);
      if (verified === null || !exactTarget(verified, snapshot)) {
        throw new Error("Human Memory exact-access crypto receipt is not durable");
      }
      return Object.freeze({
        operationId: snapshot.plan.operationId,
        memoryId: snapshot.plan.memoryId,
        objectId: snapshot.plan.cryptoObjectId,
        expectedContentRevision: snapshot.plan.expectedContentRevision,
        expectedAccessRevision: snapshot.plan.expectedCryptoAccessRevision,
        resultAccessRevision: snapshot.plan.nextCryptoAccessRevision,
        currentManifestHash: snapshot.authority.currentManifestHash.slice(),
        resultManifestHash: snapshot.manifestHash.slice(),
        targetRequiredNamespaceFingerprint:
          snapshot.plan.targetRequiredNamespaceFingerprint.slice(),
        requestDigest: snapshot.signedRequestDigest.slice(),
        currentNamespaceIds: snapshot.plan.currentNamespaceIds,
        targetNamespaceIds: snapshot.plan.targetNamespaceIds,
        status,
        publicationAuthority: cloneAuthority(snapshot.authority),
      });
    });
  }

  observe(objectId: string): Promise<HumanMemoryExactAccessCryptoObservation> {
    return withVerifiedCryptoPostgresTransaction(this.#handle, async (executor) => {
      const durable = await readHead(executor, objectId);
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
        resolveLiveShadowAgentSigner: this.#resolveLiveShadowAgentSigner,
      });
      const manifest = decodeObjectAccessManifestV5(durable.manifestBytes);
      const namespaceEnvelopeCoordinates = Object.freeze(
        durable.envelopeBytes.map((bytes, index) => {
          const envelope = decodeNamespaceObjectEnvelopeV2(bytes);
          if (envelope.context.namespaceId !== durable.namespaceIds[index]) {
            throw new Error("Human Memory exact-access envelope coordinates disagree");
          }
          return Object.freeze({
            namespaceId: envelope.context.namespaceId,
            generation: Number(envelope.context.keyGeneration),
            accessRevision: Number(envelope.context.bindingRevisionAtWrap),
          });
        }),
      );
      if (
        manifest.previousManifestHash === null
        || !bytesEqual(manifest.payloadHash, durable.payloadHash)
      ) {
        return Object.freeze({
          status: "current" as const,
          objectId,
          accessRevision: durable.accessRevision,
          manifestHash: durable.manifestHash,
          namespaceIds: durable.namespaceIds,
          namespaceEnvelopeCoordinates,
        });
      }
      return Object.freeze({
        status: "target" as const,
        objectId,
        accessRevision: durable.accessRevision,
        manifestHash: durable.manifestHash,
        previousManifestHash: manifest.previousManifestHash.slice(),
        namespaceIds: durable.namespaceIds,
        namespaceEnvelopeCoordinates,
      });
    });
  }
}
