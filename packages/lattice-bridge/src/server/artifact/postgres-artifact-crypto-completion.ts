import {
  persistPreparedHumanObjectAccessManifestGenesisSet,
  type LatticeCrypto,
  type LatticeStorage,
  type ObjectAccessGenesisEnvelopeAuthorizationContext,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  objectAccessManifestSigningBytesV5,
} from "@nautilo/lattice-crypto/wire";

import {
  ARTIFACT_CONTROL_OBJECT_TYPE_V1,
  artifactCryptoRevisionReference,
  fingerprintRequiredArtifactNamespaces,
  type ArtifactCryptoRevisionReference,
  type AtomicArtifactCryptoCompletionPort,
  type PreparedArtifactCryptoRevision,
  type VerifiedArtifactCryptoRevision,
} from "../../artifact/artifact-repository.ts";
import {
  readPreparedArtifactCryptoRevisionSnapshot,
} from "../../artifact/artifact-prepared-revision.ts";
import type {
  HistoricalHumanObjectAccessGenesisSignerAuthority,
  HistoricalHumanObjectAccessGenesisSignerContext,
  ResolveHistoricalHumanObjectAccessGenesisSigner,
} from "../storage/postgres-conversation-crypto-completion.ts";
import {
  PostgresLatticeStorage,
  assertVerifiedCryptoPostgresHandle,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";

const DIFFERENT_OBJECT_PAYLOAD =
  "Encrypted object is already initialized with different payload bytes";

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function exactFields(value: unknown, fields: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === fields.length
    && fields.every((field) => keys.includes(field));
}

function exactEnvelopeAuthority(
  actual: ObjectAccessGenesisEnvelopeAuthorizationContext,
  expected: ObjectAccessGenesisEnvelopeAuthorizationContext,
): boolean {
  return exactFields(actual, [
    "objectId",
    "namespaceId",
    "keyClass",
    "keyGeneration",
    "bindingRevisionAtWrap",
    "envelopeHash",
  ])
    && actual.envelopeHash instanceof Uint8Array
    && actual.objectId === expected.objectId
    && actual.namespaceId === expected.namespaceId
    && actual.keyClass === expected.keyClass
    && actual.keyGeneration === expected.keyGeneration
    && actual.bindingRevisionAtWrap === expected.bindingRevisionAtWrap
    && bytesEqual(actual.envelopeHash, expected.envelopeHash);
}

async function authenticHumanGenesis(input: Readonly<{
  crypto: LatticeCrypto;
  manifest: ReturnType<typeof decodeObjectAccessManifestV5>;
  envelopes: readonly ObjectAccessGenesisEnvelopeAuthorizationContext[];
  resolveHistoricalSigner: ResolveHistoricalHumanObjectAccessGenesisSigner;
}>): Promise<boolean> {
  if (input.manifest.signer.kind !== "human_device") return false;
  const context: HistoricalHumanObjectAccessGenesisSignerContext = Object.freeze({
    purpose: "verify-historical-human-object-access-genesis",
    objectId: input.manifest.objectId,
    payloadHash: input.manifest.payloadHash.slice(),
    envelopes: Object.freeze(input.envelopes.map((entry) => Object.freeze({
      ...entry,
      envelopeHash: entry.envelopeHash.slice(),
    }))),
    committerDeviceId: input.manifest.signer.committerDeviceId,
    hostAuthorizationRevision: input.manifest.hostAuthorizationRevision,
  });
  const resolved = await input.resolveHistoricalSigner(context);
  if (
    resolved === null
    || !exactFields(resolved, [
      "purpose",
      "objectId",
      "payloadHash",
      "envelopes",
      "committerDeviceId",
      "hostAuthorizationRevision",
      "committerSigningPublicKey",
    ])
    || !(resolved.payloadHash instanceof Uint8Array)
    || !(resolved.committerSigningPublicKey instanceof Uint8Array)
    || resolved.purpose !== context.purpose
    || resolved.objectId !== context.objectId
    || !bytesEqual(resolved.payloadHash, context.payloadHash)
    || resolved.committerDeviceId !== context.committerDeviceId
    || resolved.hostAuthorizationRevision !== context.hostAuthorizationRevision
    || resolved.envelopes.length !== context.envelopes.length
    || !resolved.envelopes.every((entry, index) =>
      exactEnvelopeAuthority(entry, context.envelopes[index]!)
    )
  ) return false;
  const authority: HistoricalHumanObjectAccessGenesisSignerAuthority = resolved;
  return input.crypto.verify(
    authority.committerSigningPublicKey,
    objectAccessManifestSigningBytesV5({
      objectId: input.manifest.objectId,
      payloadHash: input.manifest.payloadHash,
      accessRevision: input.manifest.accessRevision,
      previousManifestHash: input.manifest.previousManifestHash,
      envelopeHashes: input.manifest.envelopeHashes,
      signer: input.manifest.signer,
      signerAuthorizationHash: input.manifest.signerAuthorizationHash,
      hostAuthorizationRevision: input.manifest.hostAuthorizationRevision,
    }),
    input.manifest.signature,
  );
}

async function verifyStoredArtifactRevision(input: Readonly<{
  crypto: LatticeCrypto;
  storage: LatticeStorage;
  reference: ArtifactCryptoRevisionReference;
  resolveHistoricalSigner: ResolveHistoricalHumanObjectAccessGenesisSigner;
  expected?: ReturnType<typeof readPreparedArtifactCryptoRevisionSnapshot>;
}>): Promise<VerifiedArtifactCryptoRevision | null> {
  const [object, access] = await Promise.all([
    input.storage.getObject(input.reference.objectId),
    input.storage.getObjectAccessState(input.reference.objectId),
  ]);
  if (object === null || access === null) return null;
  const payload = decodeEncryptedPayloadV2(object.payloadBytes);
  const manifest = decodeObjectAccessManifestV5(access.head.manifestBytes);
  const envelopeFacts = access.namespaceEnvelopes.map((stored) => {
    const envelope = decodeNamespaceObjectEnvelopeV2(stored.envelopeBytes);
    const hash = input.crypto.hash(stored.envelopeBytes);
    if (
      stored.namespaceId !== envelope.context.namespaceId
      || envelope.context.objectId !== input.reference.objectId
      || envelope.context.keyClass !== "ai"
      || !bytesEqual(hash, stored.envelopeHash)
    ) throw new Error("Artifact durable Namespace envelope disagrees");
    return Object.freeze({
      context: Object.freeze({
        objectId: envelope.context.objectId,
        namespaceId: envelope.context.namespaceId,
        keyClass: envelope.context.keyClass,
        keyGeneration: envelope.context.keyGeneration,
        bindingRevisionAtWrap: envelope.context.bindingRevisionAtWrap,
        envelopeHash: hash,
      }),
      bytes: stored.envelopeBytes,
    });
  }).sort((left, right) =>
    left.context.namespaceId < right.context.namespaceId ? -1 : 1
  );
  const namespaceIds = envelopeFacts.map((entry) => entry.context.namespaceId);
  if (
    new Set(namespaceIds).size !== namespaceIds.length
    || object.objectId !== input.reference.objectId
    || payload.context.objectId !== input.reference.objectId
    || payload.context.objectType !== ARTIFACT_CONTROL_OBJECT_TYPE_V1
    || payload.context.keyClass !== "ai"
    || manifest.signer.kind !== "human_device"
    || manifest.objectId !== input.reference.objectId
    || manifest.accessRevision !== input.reference.expectedAccessRevision
    || manifest.accessRevision !== 0
    || !bytesEqual(input.crypto.hash(object.payloadBytes), manifest.payloadHash)
    || manifest.envelopeHashes.length !== envelopeFacts.length
  ) throw new Error("Artifact durable crypto coordinates disagree");
  const actualHashes = envelopeFacts
    .map((entry) => entry.context.envelopeHash)
    .sort(compareBytes);
  if (actualHashes.some((hash, index) =>
    !bytesEqual(hash, manifest.envelopeHashes[index]!)
  )) throw new Error("Artifact durable manifest envelope inventory disagrees");
  const fingerprint = fingerprintRequiredArtifactNamespaces(namespaceIds);
  if (!bytesEqual(
    fingerprint,
    input.reference.expectedRequiredNamespaceFingerprint,
  )) throw new Error("Artifact durable Namespace fingerprint disagrees");
  if (!await authenticHumanGenesis({
    crypto: input.crypto,
    manifest,
    envelopes: envelopeFacts.map((entry) => entry.context),
    resolveHistoricalSigner: input.resolveHistoricalSigner,
  })) return null;
  if (input.expected !== undefined) {
    const expected = input.expected;
    if (
      !bytesEqual(expected.object.payloadBytes.ciphertext, object.payloadBytes)
      || !bytesEqual(expected.access.manifestBytes, access.head.manifestBytes)
      || expected.access.envelopeBytes.length !== envelopeFacts.length
      || expected.access.envelopeBytes.some((bytes) =>
        !envelopeFacts.some((stored) => bytesEqual(bytes, stored.bytes))
      )
    ) throw new ArtifactCryptoCompletionConflictError(
      "Artifact crypto completion conflicts with durable object/access bytes",
    );
  }
  return Object.freeze({
    artifactId: input.reference.artifactId,
    artifactRevision: input.reference.artifactRevision,
    objectId: input.reference.objectId,
    accessRevision: manifest.accessRevision,
    requiredNamespaceIds: Object.freeze(namespaceIds),
    requiredNamespaceFingerprint: fingerprint,
  });
}

export class ArtifactCryptoCompletionConflictError extends Error {
  readonly code = "artifact_crypto_completion_conflict" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtifactCryptoCompletionConflictError";
  }
}

export function createPostgresArtifactCryptoCompletion(input: Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  resolveHistoricalSigner: ResolveHistoricalHumanObjectAccessGenesisSigner;
}>): AtomicArtifactCryptoCompletionPort {
  assertVerifiedCryptoPostgresHandle(input.handle);
  return Object.freeze({
    complete: (revision: PreparedArtifactCryptoRevision) =>
      withVerifiedCryptoPostgresTransaction(input.handle, async (handle) => {
        const snapshot = readPreparedArtifactCryptoRevisionSnapshot(revision);
        const reference = artifactCryptoRevisionReference({
          artifactId: snapshot.revision.artifactId,
          resultArtifactRevision: snapshot.revision.artifactRevision,
          cryptoObjectId: snapshot.revision.objectId,
          resultAccessRevision: 0,
          requiredNamespaceFingerprint:
            fingerprintRequiredArtifactNamespaces(
              snapshot.revision.requiredNamespaceIds,
            ),
        });
        const storage = new PostgresLatticeStorage(handle);
        const replay = await verifyStoredArtifactRevision({
          crypto: input.crypto,
          storage,
          reference,
          resolveHistoricalSigner: input.resolveHistoricalSigner,
          expected: snapshot,
        });
        if (replay !== null) return "duplicate" as const;
        try {
          await storage.putObject(snapshot.object);
        } catch (cause) {
          if (
            cause instanceof Error
            && cause.message === DIFFERENT_OBJECT_PAYLOAD
          ) throw new ArtifactCryptoCompletionConflictError(
            "Artifact crypto object conflicts with durable payload bytes",
            cause,
          );
          throw cause;
        }
        const status = await persistPreparedHumanObjectAccessManifestGenesisSet({
          crypto: input.crypto,
          storage,
          prepared: snapshot.access,
          resolveCurrentAuthorization: snapshot.resolveCurrentAuthorization,
        });
        if (status === "stale") throw new ArtifactCryptoCompletionConflictError(
          "Artifact crypto completion conflicts with durable access state",
        );
        const verified = await verifyStoredArtifactRevision({
          crypto: input.crypto,
          storage,
          reference,
          resolveHistoricalSigner: input.resolveHistoricalSigner,
          expected: snapshot,
        });
        if (verified === null) throw new Error(
          "Artifact crypto transaction did not persist a complete revision",
        );
        return status === "duplicate" ? "duplicate" as const : "created" as const;
      }),

    verify: (reference: ArtifactCryptoRevisionReference) =>
      withVerifiedCryptoPostgresTransaction(input.handle, (handle) =>
        verifyStoredArtifactRevision({
          crypto: input.crypto,
          storage: new PostgresLatticeStorage(handle),
          reference,
          resolveHistoricalSigner: input.resolveHistoricalSigner,
        })
      ),
  });
}
