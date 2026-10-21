import { sha256 } from "@noble/hashes/sha2.js";
import {
  eq, or, sql, cryptoObjects, foregroundMemoryCryptoPublicationReceipts,
} from "@nautilo/db";
import type { LatticeCrypto, ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization } from "@nautilo/lattice-crypto";
import { decodeObjectAccessManifestV5 } from "@nautilo/lattice-crypto/wire";
import type { ForegroundAgentFreshPublication } from "../../object/foreground-agent-object-repair.ts";
import type { AgentObjectPreparationSource } from "../../object/agent-object-protector.ts";
import { assertPreparedDeviceWrappedAgentObjectPlaintext,
  readPreparedDeviceWrappedAgentObjectSnapshot } from "../../object/device-wrapped-agent-object-crypto.ts";
import { MEMORY_OBJECT_TYPE } from "../../memory/memory-repository.ts";
import { persistDeviceWrappedAgentObject } from "../object/postgres-device-wrapped-agent-object.ts";
import { readVerifiedDeviceWrappedAgentObject } from "./postgres-memory-crypto-completion.ts";
import { readVerifiedForegroundMemoryPublicationReservation,
  type VerifiedForegroundMemoryPublicationReservation } from "./postgres-agent-memory-product-port.ts";
import { assertVerifiedCryptoPostgresHandle, cryptoTypedDb, executeTypedCryptoQuery,
  withVerifiedCryptoPostgresTransaction, type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length
  && a.every((value, index) => value === b[index]);
function conflict(): never { throw new TypeError("Foreground Memory publication receipt conflicts"); }
type Reader = Parameters<typeof readVerifiedDeviceWrappedAgentObject>[0];

/** Atomic ciphertext receipt owner. It lends no read capability or plaintext. */
export function createPostgresForegroundMemoryPublication(input: Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  resolveCurrentAuthorization: ResolveCurrentDeviceWrappedAgentObjectAccessGenesisSetAuthorization;
  resolveHistoricalAgentSignerAuthority: Reader["resolveHistoricalAgentSignerAuthority"];
  resolveLiveShadowAgentSigner?: Reader["resolveLiveShadowAgentSigner"];
}>): Readonly<{
  forReservation(proof: VerifiedForegroundMemoryPublicationReservation): ForegroundAgentFreshPublication;
}> {
  assertVerifiedCryptoPostgresHandle(input.handle);
  return Object.freeze({ forReservation(proof: VerifiedForegroundMemoryPublicationReservation) {
    // The immutable product reservation is checked by its canonical product owner.
    const reservation = readVerifiedForegroundMemoryPublicationReservation(proof);
    const assertSource = (source: AgentObjectPreparationSource) => {
      const digest = sha256(source.plaintextBytes);
      try {
        if (source.objectId !== reservation.cryptoObjectId || source.objectType !== MEMORY_OBJECT_TYPE
          || source.existingObjectId !== null || source.expectedAccessRevision !== 0
          || source.createdAt !== reservation.createdAt
          || source.namespaceIds.length !== reservation.namespaceIds.length
          || source.namespaceIds.some((value, index) => value !== reservation.namespaceIds[index])
          || !same(digest, reservation.plaintextDigest)) conflict();
      } finally { digest.fill(0); }
    };
    const readReceipt = async (handle: CryptoPostgresHandle) => {
      const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
        operation_id: foregroundMemoryCryptoPublicationReceipts.operationId,
        crypto_object_id: foregroundMemoryCryptoPublicationReceipts.cryptoObjectId,
        memory_id: foregroundMemoryCryptoPublicationReceipts.memoryId,
        content_revision: foregroundMemoryCryptoPublicationReceipts.contentRevision,
        agent_id: foregroundMemoryCryptoPublicationReceipts.agentId,
        reservation_digest: foregroundMemoryCryptoPublicationReceipts.reservationDigest,
        required_namespace_fingerprint: foregroundMemoryCryptoPublicationReceipts.requiredNamespaceFingerprint,
        genesis_manifest_hash: foregroundMemoryCryptoPublicationReceipts.genesisManifestHash,
      }).from(foregroundMemoryCryptoPublicationReceipts).where(or(
        eq(foregroundMemoryCryptoPublicationReceipts.operationId, reservation.operationId),
        eq(foregroundMemoryCryptoPublicationReceipts.cryptoObjectId, reservation.cryptoObjectId),
      )).limit(2));
      if (rows.length > 1) conflict();
      const row = rows[0];
      if (row === undefined) return null;
      if (row["operation_id"] !== reservation.operationId || row["crypto_object_id"] !== reservation.cryptoObjectId
        || row["memory_id"] !== reservation.memoryId || row["content_revision"] !== reservation.contentRevision
        || row["agent_id"] !== reservation.agentId
        || !(row["reservation_digest"] instanceof Uint8Array)
        || !same(row["reservation_digest"], reservation.reservationDigest)
        || !(row["required_namespace_fingerprint"] instanceof Uint8Array)
        || !same(row["required_namespace_fingerprint"], reservation.requiredNamespaceFingerprint)
        || !(row["genesis_manifest_hash"] instanceof Uint8Array)
        || row["genesis_manifest_hash"].length !== 32) conflict();
      return Uint8Array.from(row["genesis_manifest_hash"]);
    };
    const assertAbsentObject = async (handle: CryptoPostgresHandle) => {
      const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({ id: cryptoObjects.objectId })
        .from(cryptoObjects).where(eq(cryptoObjects.objectId, reservation.cryptoObjectId)).limit(1));
      if (rows.length !== 0) conflict();
    };
    const adapter: ForegroundAgentFreshPublication = Object.freeze({
      async recover({ source, namespaces }: Parameters<ForegroundAgentFreshPublication["recover"]>[0]) {
        assertSource(source);
        return withVerifiedCryptoPostgresTransaction(input.handle, async handle => {
          const genesisHash = await readReceipt(handle);
          if (genesisHash === null) { await assertAbsentObject(handle); return null; }
          try {
            const durable = await readVerifiedDeviceWrappedAgentObject({ handle, crypto: input.crypto,
              objectId: reservation.cryptoObjectId, expectedObjectType: MEMORY_OBJECT_TYPE,
              expectedAccessRevision: 0, expectedNamespaceIds: reservation.namespaceIds,
              resolveHistoricalAgentSignerAuthority: input.resolveHistoricalAgentSignerAuthority,
              resolveLiveShadowAgentSigner: input.resolveLiveShadowAgentSigner });
            if (durable === null) conflict();
            let accepted = false;
            try {
              const manifest = decodeObjectAccessManifestV5(durable.accessManifestBytes);
              if (!same(genesisHash, durable.accessManifestHash)
                || manifest.signer.kind !== "agent_runtime" || manifest.signer.agentId !== reservation.agentId
                || namespaces.length !== durable.namespaceEnvelopes.length
                || namespaces.some((current, index) => {
                  const envelope = durable.namespaceEnvelopes[index]!;
                  return current.namespaceId !== envelope.namespaceId
                    || current.namespaceKeyGeneration !== envelope.keyGeneration
                    || current.namespaceAccessRevision !== envelope.bindingRevisionAtWrap;
                })) conflict();
              accepted = true;
              return durable;
            } finally {
              durable.payloadHash.fill(0); durable.accessManifestBytes.fill(0); durable.accessManifestHash.fill(0);
              if (!accepted) {
                durable.payloadBytes.fill(0);
                durable.namespaceEnvelopes.forEach(entry => entry.envelopeBytes.fill(0));
              }
            }
          } finally { genesisHash.fill(0); }
        });
      },
      async persist(prepared: Parameters<ForegroundAgentFreshPublication["persist"]>[0], source: AgentObjectPreparationSource) {
        assertSource(source);
        assertPreparedDeviceWrappedAgentObjectPlaintext(prepared, source.plaintextBytes);
        const snapshot = readPreparedDeviceWrappedAgentObjectSnapshot(prepared);
        if (prepared.objectId !== reservation.cryptoObjectId || prepared.objectType !== MEMORY_OBJECT_TYPE
          || snapshot.access.authority.agentId !== reservation.agentId) conflict();
        return withVerifiedCryptoPostgresTransaction(input.handle, async handle => {
          const prior = await readReceipt(handle);
          if (prior !== null) {
            try { if (!same(prior, snapshot.access.manifestHash)) conflict(); }
            finally { prior.fill(0); }
          } else await assertAbsentObject(handle);
          const status = await persistDeviceWrappedAgentObject({ handle, crypto: input.crypto, prepared,
            resolveCurrentAuthorization: input.resolveCurrentAuthorization });
          if (status === "stale") throw new TypeError("Foreground Memory publication authority changed");
          await executeTypedCryptoQuery(handle, cryptoTypedDb.insert(foregroundMemoryCryptoPublicationReceipts).values({
            operationId: reservation.operationId, cryptoObjectId: reservation.cryptoObjectId,
            memoryId: reservation.memoryId, contentRevision: reservation.contentRevision,
            agentId: reservation.agentId, reservationDigest: reservation.reservationDigest,
            requiredNamespaceFingerprint: reservation.requiredNamespaceFingerprint,
            genesisManifestHash: snapshot.access.manifestHash, stagedAt: sql`CURRENT_TIMESTAMP`,
          }).onConflictDoNothing());
          const inserted = await readReceipt(handle);
          try { if (inserted === null || !same(inserted, snapshot.access.manifestHash)) conflict(); }
          finally { inserted?.fill(0); }
          return status;
        });
      },
    });
    return adapter;
  } });
}
