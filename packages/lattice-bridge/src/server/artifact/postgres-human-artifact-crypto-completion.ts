import {
  and,
  asc,
  eq,
  lte,
  cryptoObjects,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
} from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  ARTIFACT_CONTROL_OBJECT_TYPE_V1,
  fingerprintRequiredArtifactNamespaces,
  type ArtifactCryptoRevisionReference,
  type VerifiedArtifactCryptoRevision,
} from "../../artifact/artifact-repository.ts";
import type {
  ResolveHistoricalHumanObjectAccessGenesisSigner,
} from "../storage/postgres-conversation-crypto-completion.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type { DatabaseRow } from "../storage/postgres-record-codecs.ts";
import {
  humanArtifactPublicationAuthorityMatches,
  readAuthenticatedHumanArtifactPublication,
  type AuthenticatedHumanArtifactPublication,
  type ResolveHumanArtifactPublicationAuthority,
} from "./human-artifact-prepared-publication.ts";
import type {
  ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "../storage/agent-runtime-signer-history.ts";
import {
  destroyVerifiedStoredObjectAccessManifestChainV5,
  verifyStoredObjectAccessManifestChainV5,
  type ResolveHistoricalHumanDeviceSigningPublicKeyV5Async,
} from "../storage/postgres-object-access-manifest-v5.ts";

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function string(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function counter(row: DatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw)
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
  return value as number;
}

function bytes(row: DatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be bytea`);
  return value.slice();
}

function oneOrNull(rows: readonly DatabaseRow[], label: string): DatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} is not unique`);
  return rows[0] ?? null;
}

async function durableMatches(
  executor: CryptoPostgresExecutor,
  snapshot: ReturnType<typeof readAuthenticatedHumanArtifactPublication>,
): Promise<boolean | null> {
  const object = oneOrNull(await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      object_id: cryptoObjects.objectId,
      payload_hash: cryptoObjects.payloadHash,
      payload_bytes: cryptoObjects.payloadBytes,
    }).from(cryptoObjects)
      .where(eq(cryptoObjects.objectId, snapshot.revision.objectId))
      .limit(2),
  ), "Human Artifact encrypted object");
  const head = oneOrNull(await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      object_id: objectCryptoAccessHeads.objectId,
      access_revision: objectCryptoAccessHeads.accessRevision,
      manifest_hash: objectCryptoAccessHeads.manifestHash,
      previous_manifest_hash: objectCryptoAccessManifests.previousManifestHash,
      payload_hash: objectCryptoAccessManifests.payloadHash,
      manifest_bytes: objectCryptoAccessManifests.manifestBytes,
    }).from(objectCryptoAccessHeads)
      .innerJoin(objectCryptoAccessManifests, and(
        eq(
          objectCryptoAccessManifests.objectId,
          objectCryptoAccessHeads.objectId,
        ),
        eq(
          objectCryptoAccessManifests.accessRevision,
          objectCryptoAccessHeads.accessRevision,
        ),
      ))
      .where(eq(objectCryptoAccessHeads.objectId, snapshot.revision.objectId))
      .limit(2),
  ), "Human Artifact access head");
  const envelopes = await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.select({
      object_id: objectCryptoNamespaceEnvelopes.objectId,
      access_revision: objectCryptoNamespaceEnvelopes.accessRevision,
      namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
      ordinal: objectCryptoNamespaceEnvelopes.ordinal,
      envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
      envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
    }).from(objectCryptoNamespaceEnvelopes)
      .where(and(
        eq(objectCryptoNamespaceEnvelopes.objectId, snapshot.revision.objectId),
        eq(objectCryptoNamespaceEnvelopes.accessRevision, 0),
      ))
      .orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal))
      .limit(257),
  );
  if (object === null && head === null && envelopes.length === 0) return null;
  if (object === null || head === null) return false;
  return string(object, "object_id") === snapshot.revision.objectId
    && equalBytes(bytes(object, "payload_hash"), snapshot.payloadHash)
    && equalBytes(bytes(object, "payload_bytes"), snapshot.payloadBytes)
    && string(head, "object_id") === snapshot.revision.objectId
    && counter(head, "access_revision") === 0
    && head["previous_manifest_hash"] === null
    && equalBytes(bytes(head, "manifest_hash"), snapshot.manifestHash)
    && equalBytes(bytes(head, "payload_hash"), snapshot.payloadHash)
    && equalBytes(bytes(head, "manifest_bytes"), snapshot.manifestBytes)
    && envelopes.length === snapshot.envelopes.length
    && envelopes.every((row, ordinal) => {
      const expected = snapshot.envelopes[ordinal]!;
      return string(row, "object_id") === snapshot.revision.objectId
        && counter(row, "access_revision") === 0
        && counter(row, "ordinal") === ordinal
        && string(row, "namespace_id") === expected.namespaceId
        && equalBytes(bytes(row, "envelope_hash"), expected.envelopeHash)
        && equalBytes(bytes(row, "envelope_bytes"), expected.envelopeBytes);
    });
}

async function insertExact(
  executor: CryptoPostgresExecutor,
  snapshot: ReturnType<typeof readAuthenticatedHumanArtifactPublication>,
): Promise<void> {
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(cryptoObjects).values({
      objectId: snapshot.revision.objectId,
      payloadHash: snapshot.payloadHash,
      payloadBytes: snapshot.payloadBytes,
    }),
  );
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(objectCryptoAccessManifests).values({
      objectId: snapshot.revision.objectId,
      accessRevision: 0,
      manifestHash: snapshot.manifestHash,
      previousManifestHash: null,
      payloadHash: snapshot.payloadHash,
      manifestBytes: snapshot.manifestBytes,
    }),
  );
  for (const [ordinal, envelope] of snapshot.envelopes.entries()) {
    await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.insert(objectCryptoNamespaceEnvelopes).values({
        objectId: snapshot.revision.objectId,
        accessRevision: 0,
        namespaceId: envelope.namespaceId,
        ordinal,
        envelopeHash: envelope.envelopeHash,
        envelopeBytes: envelope.envelopeBytes,
      }),
    );
  }
  await executeTypedCryptoQuery(
    executor,
    cryptoTypedDb.insert(objectCryptoAccessHeads).values({
      objectId: snapshot.revision.objectId,
      accessRevision: 0,
      manifestHash: snapshot.manifestHash,
    }),
  );
}

async function verifyStoredArtifactRevisionV5(input: Readonly<{
  executor: CryptoPostgresExecutor;
  crypto: LatticeCrypto;
  reference: ArtifactCryptoRevisionReference;
  resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  resolveHistoricalSigner: ResolveHistoricalHumanObjectAccessGenesisSigner;
  resolveHistoricalHumanDeviceSigningPublicKey?:
    ResolveHistoricalHumanDeviceSigningPublicKeyV5Async | undefined;
}>): Promise<Readonly<{
  verified: VerifiedArtifactCryptoRevision;
  signerEvidence: readonly Readonly<{
    kind: "agent_runtime_publication" | "processor_authorization";
    evidenceBytes: Uint8Array;
  }>[];
}> | null> {
  const object = oneOrNull(await executeTypedCryptoQuery(
    input.executor,
    cryptoTypedDb.select({
      object_id: cryptoObjects.objectId,
      payload_hash: cryptoObjects.payloadHash,
      payload_bytes: cryptoObjects.payloadBytes,
    }).from(cryptoObjects)
      .where(eq(cryptoObjects.objectId, input.reference.objectId))
      .limit(2),
  ), "common v5 Artifact encrypted object");
  const head = oneOrNull(await executeTypedCryptoQuery(
    input.executor,
    cryptoTypedDb.select({
      object_id: objectCryptoAccessHeads.objectId,
      access_revision: objectCryptoAccessHeads.accessRevision,
      manifest_hash: objectCryptoAccessHeads.manifestHash,
      payload_hash: objectCryptoAccessManifests.payloadHash,
      manifest_bytes: objectCryptoAccessManifests.manifestBytes,
    }).from(objectCryptoAccessHeads)
      .innerJoin(objectCryptoAccessManifests, and(
        eq(
          objectCryptoAccessManifests.objectId,
          objectCryptoAccessHeads.objectId,
        ),
        eq(
          objectCryptoAccessManifests.accessRevision,
          objectCryptoAccessHeads.accessRevision,
        ),
        eq(
          objectCryptoAccessManifests.manifestHash,
          objectCryptoAccessHeads.manifestHash,
        ),
      ))
      .where(eq(objectCryptoAccessHeads.objectId, input.reference.objectId))
      .limit(2),
  ), "common v5 Artifact access head");
  if (object === null && head === null) return null;
  if (object === null || head === null) {
    throw new Error("common v5 Artifact crypto state is partial");
  }
  const revision = counter(head, "access_revision");
  const envelopes = await executeTypedCryptoQuery(
    input.executor,
    cryptoTypedDb.select({
      namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
      ordinal: objectCryptoNamespaceEnvelopes.ordinal,
      envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
      envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
    }).from(objectCryptoNamespaceEnvelopes)
      .where(and(
        eq(objectCryptoNamespaceEnvelopes.objectId, input.reference.objectId),
        eq(objectCryptoNamespaceEnvelopes.accessRevision, revision),
      ))
      .orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal))
      .limit(257),
  );
  if (envelopes.length > 256) {
    throw new Error("common v5 Artifact envelope inventory is oversized");
  }
  const payloadBytes = bytes(object, "payload_bytes");
  const payloadHash = input.crypto.hash(payloadBytes);
  const payload = decodeEncryptedPayloadV2(payloadBytes);
  const envelopeContexts = envelopes.map((row, ordinal) => {
    if (counter(row, "ordinal") !== ordinal) {
      throw new Error("common v5 Artifact envelope ordinal is invalid");
    }
    const envelopeBytes = bytes(row, "envelope_bytes");
    const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes);
    const envelopeHash = input.crypto.hash(envelopeBytes);
    if (
      envelope.context.objectId !== input.reference.objectId
      || envelope.context.keyClass !== "ai"
      || envelope.context.namespaceId !== string(row, "namespace_id")
      || !equalBytes(envelopeHash, bytes(row, "envelope_hash"))
    ) throw new Error("common v5 Artifact envelope is substituted");
    return Object.freeze({
      objectId: envelope.context.objectId,
      namespaceId: envelope.context.namespaceId,
      keyClass: envelope.context.keyClass,
      keyGeneration: envelope.context.keyGeneration,
      bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
      envelopeHash,
    });
  }).sort((left, right) => left.namespaceId < right.namespaceId ? -1 : 1);
  const namespaceIds = envelopeContexts.map(({ namespaceId }) => namespaceId);
  const fingerprint = fingerprintRequiredArtifactNamespaces(namespaceIds);
  const headHash = bytes(head, "manifest_hash");
  if (
    revision !== input.reference.expectedAccessRevision
    || string(object, "object_id") !== input.reference.objectId
    || string(head, "object_id") !== input.reference.objectId
    || !equalBytes(bytes(object, "payload_hash"), payloadHash)
    || !equalBytes(bytes(head, "payload_hash"), payloadHash)
    || payload.context.objectId !== input.reference.objectId
    || payload.context.objectType !== ARTIFACT_CONTROL_OBJECT_TYPE_V1
    || payload.context.keyClass !== "ai"
    || !equalBytes(
      fingerprint,
      input.reference.expectedRequiredNamespaceFingerprint,
    )
  ) throw new Error("common v5 Artifact coordinates conflict");
  const verifiedChain = await verifyStoredObjectAccessManifestChainV5({
    executor: input.executor,
    crypto: input.crypto,
    objectId: input.reference.objectId,
    headAccessRevision: revision,
    expectedPayloadHash: payloadHash,
    expectedHeadManifestHash: headHash,
    resolveHistoricalAgentManagerAuthority:
      input.resolveHistoricalAgentSignerAuthority,
    resolveHistoricalHumanDeviceSigningPublicKey:
      input.resolveHistoricalHumanDeviceSigningPublicKey
      ?? (async (context) => {
        const resolved = await input.resolveHistoricalSigner({
          purpose: "verify-historical-human-object-access-genesis",
          objectId: input.reference.objectId,
          payloadHash,
          envelopes: envelopeContexts,
          committerDeviceId: context.committerDeviceId,
          hostAuthorizationRevision: context.hostAuthorizationRevision,
        });
        if (resolved === null) return null;
        const key = resolved.committerSigningPublicKey.slice();
        resolved.committerSigningPublicKey.fill(0);
        return key;
      }),
  });
  try {
    const verified = Object.freeze({
      artifactId: input.reference.artifactId,
      artifactRevision: input.reference.artifactRevision,
      objectId: input.reference.objectId,
      accessRevision: revision,
      requiredNamespaceIds: Object.freeze(namespaceIds),
      requiredNamespaceFingerprint: fingerprint,
    });
    return Object.freeze({
      verified,
      signerEvidence: Object.freeze(verifiedChain.signerEvidence.map(
        (entry) => Object.freeze({
          kind: entry.kind,
          evidenceBytes: entry.evidenceBytes.slice(),
        }),
      )),
    });
  } finally {
    destroyVerifiedStoredObjectAccessManifestChainV5(verifiedChain);
  }
}

export type HumanArtifactCryptoCompletionResult = Readonly<{
  status: "created" | "duplicate";
  verified: VerifiedArtifactCryptoRevision;
}>;

export type VerifiedHumanArtifactCryptoRevisionContent = Readonly<{
  verified: VerifiedArtifactCryptoRevision;
  encryptedControlPayloadBytes: Uint8Array;
  accessManifestBytes: Uint8Array;
  accessManifestProofBytes: readonly Uint8Array[];
  accessSignerEvidence: readonly Readonly<{
    kind: "agent_runtime_publication" | "processor_authorization";
    evidenceBytes: Uint8Array;
  }>[];
  namespaceEnvelopes: readonly Readonly<{
    namespaceId: string;
    envelopeBytes: Uint8Array;
  }>[];
}>;

/**
 * Restricted-role publication adapter for a structurally authenticated Human
 * HTTP request. The client-created WeakMap handle never crosses the wire; this
 * adapter consumes only the bridge-minted server-local handle.
 */
export class PostgresHumanArtifactCryptoCompletion {
  readonly #handle: CryptoPostgresHandle;
  readonly #crypto: LatticeCrypto;
  readonly #resolveCurrentAuthority: ResolveHumanArtifactPublicationAuthority;
  readonly #resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority;
  readonly #resolveHistoricalHumanDeviceSigningPublicKey:
    ResolveHistoricalHumanDeviceSigningPublicKeyV5Async | undefined;
  readonly #resolveHistoricalSigner:
    ResolveHistoricalHumanObjectAccessGenesisSigner;

  constructor(input: Readonly<{
    handle: CryptoPostgresHandle;
    crypto: LatticeCrypto;
    resolveCurrentAuthority: ResolveHumanArtifactPublicationAuthority;
    resolveHistoricalSigner: ResolveHistoricalHumanObjectAccessGenesisSigner;
    resolveHistoricalAgentSignerAuthority?:
      ResolveHistoricalAgentRuntimeSignerManagerAuthority | undefined;
    resolveHistoricalHumanDeviceSigningPublicKey?:
      ResolveHistoricalHumanDeviceSigningPublicKeyV5Async | undefined;
  }>) {
    assertVerifiedCryptoPostgresHandle(input.handle);
    this.#handle = input.handle;
    this.#crypto = input.crypto;
    this.#resolveCurrentAuthority = input.resolveCurrentAuthority;
    this.#resolveHistoricalAgentSignerAuthority =
      input.resolveHistoricalAgentSignerAuthority
      ?? (() => Promise.resolve(null));
    this.#resolveHistoricalSigner = input.resolveHistoricalSigner;
    this.#resolveHistoricalHumanDeviceSigningPublicKey =
      input.resolveHistoricalHumanDeviceSigningPublicKey;
  }

  async complete(
    prepared: AuthenticatedHumanArtifactPublication,
  ): Promise<HumanArtifactCryptoCompletionResult> {
    const snapshot = readAuthenticatedHumanArtifactPublication(prepared);
    const authority = await this.#resolveCurrentAuthority(snapshot.authority);
    if (
      authority === null
      || !humanArtifactPublicationAuthorityMatches(
        authority.context,
        snapshot.authority,
      )
    ) {
      authority?.committerSigningPublicKey.fill(0);
      throw new Error("Current Human Artifact publication authority is unavailable");
    }
    authority.committerSigningPublicKey.fill(0);
    const status = await withVerifiedCryptoPostgresTransaction(
      this.#handle,
      async (executor) => {
        const exact = await durableMatches(executor, snapshot);
        if (exact === false) {
          throw new Error("Human Artifact crypto publication conflicts with durable bytes");
        }
        if (exact === true) return "duplicate" as const;
        await insertExact(executor, snapshot);
        if (await durableMatches(executor, snapshot) !== true) {
          throw new Error("Human Artifact crypto publication is not durable");
        }
        return "created" as const;
      },
    );
    const verified: VerifiedArtifactCryptoRevision = Object.freeze({
      artifactId: snapshot.revision.artifactId,
      artifactRevision: snapshot.revision.artifactRevision,
      objectId: snapshot.revision.objectId,
      accessRevision: 0,
      requiredNamespaceIds: snapshot.revision.requiredNamespaceIds,
      requiredNamespaceFingerprint:
        snapshot.plan.requiredNamespaceFingerprint.slice(),
    });
    return Object.freeze({ status, verified });
  }

  verify(
    reference: ArtifactCryptoRevisionReference,
  ): Promise<VerifiedArtifactCryptoRevision | null> {
    return withVerifiedCryptoPostgresTransaction(this.#handle, async (executor) => {
      const result = await verifyStoredArtifactRevisionV5({
        executor,
        crypto: this.#crypto,
        reference,
        resolveHistoricalAgentSignerAuthority:
          this.#resolveHistoricalAgentSignerAuthority,
        resolveHistoricalSigner: this.#resolveHistoricalSigner,
        resolveHistoricalHumanDeviceSigningPublicKey:
          this.#resolveHistoricalHumanDeviceSigningPublicKey,
      });
      return result?.verified ?? null;
    });
  }

  async read(
    reference: ArtifactCryptoRevisionReference,
  ): Promise<VerifiedHumanArtifactCryptoRevisionContent | null> {
    const beforeResult = await withVerifiedCryptoPostgresTransaction(
      this.#handle,
      (executor) => verifyStoredArtifactRevisionV5({
        executor,
        crypto: this.#crypto,
        reference,
        resolveHistoricalAgentSignerAuthority:
          this.#resolveHistoricalAgentSignerAuthority,
        resolveHistoricalSigner: this.#resolveHistoricalSigner,
        resolveHistoricalHumanDeviceSigningPublicKey:
          this.#resolveHistoricalHumanDeviceSigningPublicKey,
      }),
    );
    if (beforeResult === null) return null;
    const before = beforeResult.verified;
    const content = await withVerifiedCryptoPostgresTransaction(
      this.#handle,
      async (executor) => {
        const object = oneOrNull(await executeTypedCryptoQuery(
          executor,
          cryptoTypedDb.select({
            payload_bytes: cryptoObjects.payloadBytes,
          }).from(cryptoObjects)
            .where(eq(cryptoObjects.objectId, reference.objectId))
            .limit(2),
        ), "Human Artifact read object");
        const manifests = await executeTypedCryptoQuery(
          executor,
          cryptoTypedDb.select({
            access_revision: objectCryptoAccessManifests.accessRevision,
            manifest_bytes: objectCryptoAccessManifests.manifestBytes,
          }).from(objectCryptoAccessManifests)
            .where(and(
              eq(objectCryptoAccessManifests.objectId, reference.objectId),
              lte(
                objectCryptoAccessManifests.accessRevision,
                reference.expectedAccessRevision,
              ),
            ))
            .orderBy(asc(objectCryptoAccessManifests.accessRevision))
            .limit(258),
        );
        const envelopes = await executeTypedCryptoQuery(
          executor,
          cryptoTypedDb.select({
            namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
            ordinal: objectCryptoNamespaceEnvelopes.ordinal,
            envelope_bytes: objectCryptoNamespaceEnvelopes.envelopeBytes,
          }).from(objectCryptoNamespaceEnvelopes)
            .where(and(
              eq(objectCryptoNamespaceEnvelopes.objectId, reference.objectId),
              eq(
                objectCryptoNamespaceEnvelopes.accessRevision,
                reference.expectedAccessRevision,
              ),
            ))
            .orderBy(asc(objectCryptoNamespaceEnvelopes.ordinal))
            .limit(257),
        );
        if (
          object === null
          || manifests.length !== reference.expectedAccessRevision + 1
          || envelopes.length !== before.requiredNamespaceIds.length
        ) throw new Error("Human Artifact authenticated content is incomplete");
        const head = manifests.at(-1)!;
        if (counter(head, "access_revision") !== reference.expectedAccessRevision) {
          throw new Error("Human Artifact access proof is incomplete");
        }
        return Object.freeze({
          encryptedControlPayloadBytes: bytes(object, "payload_bytes"),
          accessManifestBytes: bytes(head, "manifest_bytes"),
          accessManifestProofBytes: Object.freeze(
            manifests.slice(0, -1).map((row) => bytes(row, "manifest_bytes")),
          ),
          accessSignerEvidence: Object.freeze(beforeResult.signerEvidence.map(
            (entry) => Object.freeze({
              kind: entry.kind,
              evidenceBytes: entry.evidenceBytes.slice(),
            }),
          )),
          namespaceEnvelopes: Object.freeze(envelopes.map((row, ordinal) => {
            if (counter(row, "ordinal") !== ordinal) {
              throw new Error("Human Artifact envelope ordering is inexact");
            }
            return Object.freeze({
              namespaceId: string(row, "namespace_id"),
              envelopeBytes: bytes(row, "envelope_bytes"),
            });
          })),
        });
      },
    );
    const after = await this.verify(reference);
    if (
      after === null
      || after.objectId !== before.objectId
      || after.accessRevision !== before.accessRevision
      || !equalBytes(
        after.requiredNamespaceFingerprint,
        before.requiredNamespaceFingerprint,
      )
    ) {
      content.encryptedControlPayloadBytes.fill(0);
      content.accessManifestBytes.fill(0);
      content.accessManifestProofBytes.forEach((value) => value.fill(0));
      content.accessSignerEvidence.forEach((entry) =>
        entry.evidenceBytes.fill(0)
      );
      content.namespaceEnvelopes.forEach(({ envelopeBytes }) => envelopeBytes.fill(0));
      throw new Error("Human Artifact crypto head changed while reading");
    }
    return Object.freeze({ verified: after, ...content });
  }
}
