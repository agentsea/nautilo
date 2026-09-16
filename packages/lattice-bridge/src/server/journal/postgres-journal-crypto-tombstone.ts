import {
  and,
  eq,
  objectCryptoAccessHeads,
  objectCryptoNamespaceEnvelopes,
  processorCryptoSignerAuthorizations,
} from "@nautilo/db";
import {
  LatticeCrypto,
  assertPortableId,
  verifyCommonObjectAccessManifest,
  type CommonObjectAccessManifest,
} from "@nautilo/lattice-crypto";
import {
  verifyObjectAccessManifestV4,
  type ObjectAccessManifestV4,
  type ProcessorSignerAuthorizationV1,
} from "@nautilo/lattice-crypto/wire";

import {readProcessorSignerAuthorizationVersion, destroyVerifiedProcessorSignerAuthorizationV2} from "@nautilo/lattice-crypto/background";
import {loadVerifiedCurrentProcessorSignerAuthorization, destroyVerifiedCurrentProcessorSignerEvidence} from "../storage/postgres-current-processor-signer-authorization.ts";
import {
  loadVerifiedProcessorSignerAuthorization,
  exactManifestForStoredBytes,
} from "../storage/postgres-processor-transform-object-port.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
} from "../storage/postgres-record-codecs.ts";

export const JOURNAL_CRYPTO_TOMBSTONE_MAX_OBJECTS = 256;

export type JournalCryptoTombstoneResult = Readonly<{
  readonly status: "tombstoned";
  readonly advancedCount: number;
  readonly alreadyTombstonedCount: number;
}>;

export interface JournalCryptoTombstonePort {
  readonly tombstoneObjects: (input: Readonly<{
    readonly objectIds: readonly string[];
    readonly signal: AbortSignal;
  }>) => Promise<JournalCryptoTombstoneResult>;
}

type VerifiedTombstone = Readonly<{
  readonly objectId: string;
  readonly genesisHash: Uint8Array;
  readonly tombstoneHash: Uint8Array;
  readonly current: "genesis" | "tombstone";
}>;

const HASH_BYTES = 32;

function aborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Journal crypto tombstone operation aborted");
  }
}

function rowString(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Journal crypto tombstone column ${field} is invalid`);
  }
  return value;
}

function rowCounter(row: DatabaseRow, field: string): number {
  const value = row[field];
  const counter = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (
    typeof counter !== "number"
    || !Number.isSafeInteger(counter)
    || counter < 0
  ) {
    throw new TypeError(`Journal crypto tombstone column ${field} is invalid`);
  }
  return counter;
}

function rowBytes(
  row: DatabaseRow,
  field: string,
  length?: number,
): Uint8Array {
  const value = row[field];
  if (
    !(value instanceof Uint8Array)
    || (length !== undefined && value.length !== length)
  ) {
    throw new TypeError(`Journal crypto tombstone column ${field} is invalid`);
  }
  return Uint8Array.from(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function exactOne(
  rows: readonly DatabaseRow[],
  label: string,
): DatabaseRow {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(`Journal crypto tombstone ${label} is unavailable`);
  }
  return rows[0];
}

function sameProcessorSigner(
  left: ObjectAccessManifestV4 | CommonObjectAccessManifest,
  right: ObjectAccessManifestV4 | CommonObjectAccessManifest,
): boolean {
  return left.signer.kind === "processor_invocation"
    && right.signer.kind === "processor_invocation"
    && left.signer.processorKind === right.signer.processorKind
    && left.signer.processorVersion === right.signer.processorVersion
    && left.signer.signerAuthorizationId
      === right.signer.signerAuthorizationId
    && left.signer.signerKeyId === right.signer.signerKeyId
    && sameBytes(
      left.signer.workDescriptorHash,
      right.signer.workDescriptorHash,
    );
}

function authorityMatches(
  context: Readonly<{
    readonly issuingHumanId: string;
    readonly issuingDeviceId: string;
    readonly issuingDeviceAuthorizationRevision: number;
  }>,
  authorization: ProcessorSignerAuthorizationV1,
): boolean {
  return context.issuingHumanId === authorization.issuingHumanId
    && context.issuingDeviceId === authorization.issuingDeviceId
    && context.issuingDeviceAuthorizationRevision
      === authorization.issuingDeviceAuthorizationRevision;
}

async function verifyExactTombstone(
  executor: CryptoPostgresExecutor,
  crypto: LatticeCrypto,
  objectId: string,
  signal: AbortSignal,
): Promise<VerifiedTombstone> {
  aborted(signal);
  const row = exactOne(await executor.query(
    `SELECT object.object_id,
            object.payload_hash AS object_payload_hash,
            head.access_revision AS head_access_revision,
            head.manifest_hash AS head_manifest_hash,
            genesis.manifest_hash AS genesis_manifest_hash,
            genesis.payload_hash AS genesis_payload_hash,
            genesis.manifest_bytes AS genesis_manifest_bytes,
            tombstone.manifest_hash AS tombstone_manifest_hash,
            tombstone.previous_manifest_hash AS tombstone_previous_hash,
            tombstone.payload_hash AS tombstone_payload_hash,
            tombstone.manifest_bytes AS tombstone_manifest_bytes
       FROM crypto_objects AS object
       JOIN object_crypto_access_heads AS head
         ON head.object_id = object.object_id
       JOIN object_crypto_access_manifests AS genesis
         ON genesis.object_id = object.object_id
        AND genesis.access_revision = 0
       JOIN object_crypto_access_manifests AS tombstone
         ON tombstone.object_id = object.object_id
        AND tombstone.access_revision = 1
      WHERE object.object_id = $1
      LIMIT 2
      FOR UPDATE OF head`,
    [objectId],
  ), "object history");
  const storedObjectId = rowString(row, "object_id");
  const objectPayloadHash = rowBytes(row, "object_payload_hash", HASH_BYTES);
  const headRevision = rowCounter(row, "head_access_revision");
  const headHash = rowBytes(row, "head_manifest_hash", HASH_BYTES);
  const genesisHash = rowBytes(row, "genesis_manifest_hash", HASH_BYTES);
  const genesisPayloadHash = rowBytes(
    row,
    "genesis_payload_hash",
    HASH_BYTES,
  );
  const genesisBytes = rowBytes(row, "genesis_manifest_bytes");
  const tombstoneHash = rowBytes(
    row,
    "tombstone_manifest_hash",
    HASH_BYTES,
  );
  const tombstonePreviousHash = rowBytes(
    row,
    "tombstone_previous_hash",
    HASH_BYTES,
  );
  const tombstonePayloadHash = rowBytes(
    row,
    "tombstone_payload_hash",
    HASH_BYTES,
  );
  const tombstoneBytes = rowBytes(row, "tombstone_manifest_bytes");
  const calculatedGenesisHash = crypto.hash(genesisBytes);
  const calculatedTombstoneHash = crypto.hash(tombstoneBytes);
  try {
    if (
      storedObjectId !== objectId
      || !sameBytes(objectPayloadHash, genesisPayloadHash)
      || !sameBytes(objectPayloadHash, tombstonePayloadHash)
      || !sameBytes(genesisHash, calculatedGenesisHash)
      || !sameBytes(tombstoneHash, calculatedTombstoneHash)
      || !sameBytes(tombstonePreviousHash, genesisHash)
    ) {
      throw new Error("Journal crypto tombstone durable hashes conflict");
    }
    const genesisFamily = exactManifestForStoredBytes(genesisBytes);
    const tombstoneFamily = exactManifestForStoredBytes(tombstoneBytes);
    if ((genesisFamily.version !== 4 && genesisFamily.version !== 5)
      || (tombstoneFamily.version !== 4 && tombstoneFamily.version !== 5)
      || genesisFamily.version !== tombstoneFamily.version) {
      throw new Error("Journal crypto tombstone manifest family conflicts");
    }
    const decodedGenesis = genesisFamily.manifest;
    const decodedTombstone = tombstoneFamily.manifest;
    if (
      decodedGenesis.signer.kind !== "processor_invocation"
      || decodedTombstone.signer.kind !== "processor_invocation"
      || decodedGenesis.objectId !== objectId
      || decodedGenesis.accessRevision !== 0
      || decodedGenesis.previousManifestHash !== null
      || decodedGenesis.envelopeHashes.length < 1
      || decodedGenesis.envelopeHashes.length > JOURNAL_CRYPTO_TOMBSTONE_MAX_OBJECTS
      || !sameBytes(decodedGenesis.payloadHash, objectPayloadHash)
      || decodedTombstone.objectId !== objectId
      || decodedTombstone.accessRevision !== 1
      || decodedTombstone.previousManifestHash === null
      || !sameBytes(decodedTombstone.previousManifestHash, genesisHash)
      || decodedTombstone.envelopeHashes.length !== 0
      || !sameBytes(decodedTombstone.payloadHash, objectPayloadHash)
      || !sameProcessorSigner(decodedGenesis, decodedTombstone)
      || decodedGenesis.hostAuthorizationRevision
        !== decodedTombstone.hostAuthorizationRevision
      || decodedGenesis.signerAuthorizationHash === null
      || decodedTombstone.signerAuthorizationHash === null
      || !sameBytes(
        decodedGenesis.signerAuthorizationHash,
        decodedTombstone.signerAuthorizationHash,
      )
    ) {
      throw new Error("Journal crypto tombstone manifest chain is invalid");
    }
    const authorizationRows = await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        authorization_bytes:
          processorCryptoSignerAuthorizations.authorizationBytes,
      }).from(processorCryptoSignerAuthorizations).where(eq(
        processorCryptoSignerAuthorizations.authorizationId,
        decodedTombstone.signer.signerAuthorizationId,
      )).limit(2),
    );
    const authorizationBytes = rowBytes(
      exactOne(authorizationRows, "signer authorization"),
      "authorization_bytes",
    );
    const currentEvidence = readProcessorSignerAuthorizationVersion(authorizationBytes) === 2
      ? await loadVerifiedCurrentProcessorSignerAuthorization(executor, crypto, authorizationBytes) : null;
    const verifiedAuthorization = currentEvidence === null
      ? await loadVerifiedProcessorSignerAuthorization(executor, crypto, authorizationBytes) : null;
    const authorization = currentEvidence === null ? verifiedAuthorization!.authorization : {
      id: currentEvidence.certificate.credentialId,
      processorKind: currentEvidence.certificate.descriptor.subject.processorKind,
      processorVersion: currentEvidence.certificate.descriptor.subject.processorVersion,
      namespaceId: currentEvidence.certificate.descriptor.anchorNamespaceId,
      outputObjectIds: currentEvidence.certificate.descriptor.outputSlots.map((slot) => slot.objectId),
    };
    const retainedEvidence = currentEvidence ?? verifiedAuthorization!;
    const verifiedManifests: (ReturnType<typeof verifyObjectAccessManifestV4> | ReturnType<typeof verifyCommonObjectAccessManifest>)[] = [];
    try {
      const resolver = (evidence: Readonly<{
        readonly authorizationId: string;
        readonly authorizationHash: Uint8Array;
      }>) =>
        evidence.authorizationId
            === authorization.id
          && sameBytes(
            evidence.authorizationHash,
            retainedEvidence.authorizationHash,
          )
          ? retainedEvidence.authorizationBytes
          : null;
      const issuer = (context: Readonly<{
        readonly issuingHumanId: string;
        readonly issuingDeviceId: string;
        readonly issuingDeviceAuthorizationRevision: number;
      }>) =>
        verifiedAuthorization !== null && authorityMatches(context, verifiedAuthorization.authorization)
          ? verifiedAuthorization.issuerPublicKey : null;
      const currentIssuer: NonNullable<Parameters<typeof verifyObjectAccessManifestV4>[1]["resolveHistoricalCurrentIssuer"]> = context =>
        currentEvidence !== null && context.issuer.humanId === currentEvidence.certificate.issuer.humanId
          && context.issuer.deviceId === currentEvidence.certificate.issuer.deviceId
          && context.issuer.deviceGeneration === currentEvidence.certificate.issuer.deviceGeneration
          && sameBytes(context.descriptorHash, currentEvidence.certificate.descriptorHash)
          ? currentEvidence.issuerPublicKey : null;
      const resolvers = {
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: resolver,
        resolveHistoricalIssuingDevicePublicKey: issuer,
        resolveHistoricalProcessorIssuingDevicePublicKey: issuer,
        resolveHistoricalHumanDeviceSigningPublicKey: () => null,
        resolveHistoricalCurrentIssuer: currentIssuer,
      };
      const verify = (manifestBytes: Uint8Array) => genesisFamily.version === 5
        ? verifyCommonObjectAccessManifest(crypto, {manifestBytes, ...resolvers})
        : verifyObjectAccessManifestV4(crypto, {manifestBytes, ...resolvers});
      const genesis = verify(genesisBytes);
      verifiedManifests.push(genesis);
      const tombstone = verify(tombstoneBytes);
      verifiedManifests.push(tombstone);
      if (
        !sameBytes(genesis.manifestHash, genesisHash)
        || !sameBytes(tombstone.manifestHash, tombstoneHash)
        || (authorization.processorKind !== "stenographer"
          && !(authorization.processorKind === "reflection" && currentEvidence !== null && genesisFamily.version === 5))
        || authorization.processorVersion !== 1
        || !authorization.outputObjectIds.some(
          (authorizedObjectId) => authorizedObjectId === objectId,
        )
      ) {
        throw new Error(
          "Journal crypto tombstone signer boundary conflicts",
        );
      }
      const expectedNamespaces = currentEvidence?.certificate.descriptor.outputSlots
        .find(slot => slot.objectId === objectId)?.namespaceIds ?? [authorization.namespaceId];
      if (authorization.processorKind === "stenographer" && expectedNamespaces.length !== 1) {
        throw new Error("Stenographer tombstone requires its existing single Namespace");
      }
      const genesisEnvelopes = await executeTypedCryptoQuery(
        executor,
        cryptoTypedDb.select({
          namespace_id: objectCryptoNamespaceEnvelopes.namespaceId,
          ordinal: objectCryptoNamespaceEnvelopes.ordinal,
          envelope_hash: objectCryptoNamespaceEnvelopes.envelopeHash,
        }).from(objectCryptoNamespaceEnvelopes).where(and(
          eq(objectCryptoNamespaceEnvelopes.objectId, objectId),
          eq(objectCryptoNamespaceEnvelopes.accessRevision, 0),
        )).orderBy(objectCryptoNamespaceEnvelopes.ordinal).limit(expectedNamespaces.length + 1),
      );
      if (genesisEnvelopes.length !== expectedNamespaces.length
        || decodedGenesis.envelopeHashes.length !== expectedNamespaces.length
        || JSON.stringify(genesisEnvelopes.map(entry => rowString(entry, "namespace_id")).sort()) !== JSON.stringify([...expectedNamespaces].sort())
        || genesisEnvelopes.some((entry, ordinal) => rowCounter(entry, "ordinal") !== ordinal
          || !sameBytes(rowBytes(entry, "envelope_hash", HASH_BYTES), decodedGenesis.envelopeHashes[ordinal]!))) {
        throw new Error("Journal crypto tombstone genesis envelope inventory conflicts");
      }
    } finally {
      authorizationBytes.fill(0);
      verifiedAuthorization?.issuerPublicKey.fill(0);
      if (currentEvidence !== null) destroyVerifiedCurrentProcessorSignerEvidence(currentEvidence);
      for (const verified of verifiedManifests) {
        verified.manifestBytes.fill(0); verified.manifestHash.fill(0);
        if (verified.currentSignerAuthorization !== null) destroyVerifiedProcessorSignerAuthorizationV2(verified.currentSignerAuthorization);
      }
    }
    const current = headRevision === 0 && sameBytes(headHash, genesisHash)
      ? "genesis"
      : headRevision === 1 && sameBytes(headHash, tombstoneHash)
      ? "tombstone"
      : null;
    if (current === null) {
      throw new Error("Journal crypto tombstone access head conflicts");
    }
    const envelopes = await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        ordinal: objectCryptoNamespaceEnvelopes.ordinal,
      }).from(objectCryptoNamespaceEnvelopes).where(and(
        eq(objectCryptoNamespaceEnvelopes.objectId, objectId),
        eq(objectCryptoNamespaceEnvelopes.accessRevision, 1),
      )).limit(1),
    );
    if (envelopes.length !== 0) {
      throw new Error("Journal crypto tombstone retains a Namespace envelope");
    }
    return Object.freeze({
      objectId,
      genesisHash: genesisHash.slice(),
      tombstoneHash: tombstoneHash.slice(),
      current,
    });
  } finally {
    objectPayloadHash.fill(0);
    headHash.fill(0);
    genesisHash.fill(0);
    genesisPayloadHash.fill(0);
    genesisBytes.fill(0);
    tombstoneHash.fill(0);
    tombstonePreviousHash.fill(0);
    tombstonePayloadHash.fill(0);
    tombstoneBytes.fill(0);
    calculatedGenesisHash.fill(0);
    calculatedTombstoneHash.fill(0);
  }
}

export class PostgresJournalCryptoTombstoneRepository
  implements JournalCryptoTombstonePort {
  readonly #handle: CryptoPostgresHandle;
  readonly #crypto: LatticeCrypto;

  constructor(input: Readonly<{
    readonly handle: CryptoPostgresHandle;
    readonly crypto: LatticeCrypto;
  }>) {
    assertVerifiedCryptoPostgresHandle(input.handle);
    if (!(input.crypto instanceof LatticeCrypto)) {
      throw new TypeError(
        "Journal crypto tombstone repository requires LatticeCrypto",
      );
    }
    this.#handle = input.handle;
    this.#crypto = input.crypto;
  }

  async tombstoneObjects(input: Readonly<{
    readonly objectIds: readonly string[];
    readonly signal: AbortSignal;
  }>): Promise<JournalCryptoTombstoneResult> {
    aborted(input.signal);
    const rawObjectIds: unknown = input.objectIds;
    if (
      !Array.isArray(rawObjectIds)
      || rawObjectIds.length > JOURNAL_CRYPTO_TOMBSTONE_MAX_OBJECTS
    ) {
      throw new TypeError("Journal crypto tombstone batch is invalid");
    }
    const objectIds = rawObjectIds.map((value: unknown) => {
      if (typeof value !== "string") {
        throw new TypeError(
          "Journal crypto tombstone object id must be text",
        );
      }
      return value;
    });
    for (const objectId of objectIds) {
      assertPortableId("Journal crypto tombstone object id", objectId);
    }
    if (new Set(objectIds).size !== objectIds.length) {
      throw new TypeError("Journal crypto tombstone object ids are duplicated");
    }
    objectIds.sort();
    if (objectIds.length === 0) {
      return Object.freeze({
        status: "tombstoned",
        advancedCount: 0,
        alreadyTombstonedCount: 0,
      });
    }
    return this.#handle.transaction(async (transaction) => {
      aborted(input.signal);
      await transaction.query(
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      );
      const verified: VerifiedTombstone[] = [];
      for (const objectId of objectIds) {
        verified.push(
          await verifyExactTombstone(
            transaction,
            this.#crypto,
            objectId,
            input.signal,
          ),
        );
      }
      let advancedCount = 0;
      let alreadyTombstonedCount = 0;
      for (const object of verified) {
        aborted(input.signal);
        if (object.current === "tombstone") {
          alreadyTombstonedCount += 1;
          continue;
        }
        const rows = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(objectCryptoAccessHeads).set({
            accessRevision: 1,
            manifestHash: object.tombstoneHash,
          }).where(and(
            eq(objectCryptoAccessHeads.objectId, object.objectId),
            eq(objectCryptoAccessHeads.accessRevision, 0),
            eq(objectCryptoAccessHeads.manifestHash, object.genesisHash),
          )).returning({
            object_id: objectCryptoAccessHeads.objectId,
          }),
        );
        if (
          rows.length !== 1
          || rowString(rows[0]!, "object_id") !== object.objectId
        ) {
          throw new Error("Journal crypto tombstone head CAS failed");
        }
        advancedCount += 1;
      }
      aborted(input.signal);
      return Object.freeze({
        status: "tombstoned" as const,
        advancedCount,
        alreadyTombstonedCount,
      });
    });
  }
}
