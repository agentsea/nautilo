import {
  accessRevision,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  persistPreparedAgentObjectAccessManifestGenesis,
  prepareAgentObjectAccessManifestGenesis,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type AgentObjectAccessGrantUseStatus,
  type AgentRuntimeKeyGeneration,
  type AgentRuntimeSignerPublication,
  type LatticeCrypto,
  type PreparedAgentObjectAccessManifestGenesis,
  type ResolveCurrentAgentObjectAccessGenesisAuthorization,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeObjectAccessManifestV3,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  PostgresLatticeStorage,
  assertVerifiedCryptoPostgresHandle,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import { bytesToHex } from "@noble/hashes/utils.js";

import type {
  ProtectedRecordPublicationPort,
  RecordPublicationCryptoResult,
} from "./contracts";

export const REFLECTION_RECORD_CRYPTO_OBJECT_TYPE =
  "nautilo.reflection.record.v1";

export interface PreparedProtectedRecordPublication {
  readonly objectId: string;
  readonly recordId: string;
  readonly representationGeneration: number;
}

interface PreparedSnapshot {
  readonly objectId: string;
  readonly recordId: string;
  readonly representationGeneration: number;
  readonly payloadHash: Uint8Array;
  readonly object: Parameters<PostgresLatticeStorage["putObject"]>[0];
  readonly access: PreparedAgentObjectAccessManifestGenesis;
  readonly resolveCurrentAuthorization:
    ResolveCurrentAgentObjectAccessGenesisAuthorization;
}

const preparedSnapshots = new WeakMap<
  PreparedProtectedRecordPublication,
  PreparedSnapshot
>();

class RecordCryptoAuthorizationUnavailable extends Error {}
class RecordCryptoPublicationIncomplete extends Error {}
class RecordCryptoPublicationMismatch extends Error {}

export function deriveProtectedRecordObjectId(
  crypto: LatticeCrypto,
  recordId: string,
  representationGeneration: number,
): string {
  if (!Number.isSafeInteger(representationGeneration) || representationGeneration < 1) {
    throw new TypeError("Record representation generation is invalid");
  }
  const coordinate = new TextEncoder().encode(
    `nautilo-reflection-record-v1\0${recordId}\0${representationGeneration}`,
  );
  try {
    return `reflection-record-v1:${bytesToHex(crypto.hash(coordinate))}`;
  } finally {
    coordinate.fill(0);
  }
}

export interface PrepareProtectedRecordPublicationInput {
  readonly crypto: LatticeCrypto;
  readonly recordId: string;
  readonly representationGeneration: number;
  readonly payloadBytes: Uint8Array;
  readonly createdAt: number;
  readonly namespace: Readonly<{
    namespaceId: string;
    accessRevision: number;
    bindingHash: Uint8Array;
    domainId: string;
    domainEpoch: number;
    keyGeneration: number;
    aiKey: Uint8Array;
  }>;
  readonly grant: Readonly<{
    grantId: string;
    grantHash: Uint8Array;
    useStatus: AgentObjectAccessGrantUseStatus;
  }>;
  readonly runtime: AgentRuntimeKeyGeneration;
  readonly signerPublication: AgentRuntimeSignerPublication;
  readonly resolveCurrentAuthorization:
    ResolveCurrentAgentObjectAccessGenesisAuthorization;
}

/** Prepare with live exact authority; copied plaintext, AI key, and DEK are wiped. */
export function prepareProtectedRecordPublication(
  input: PrepareProtectedRecordPublicationInput,
): PreparedProtectedRecordPublication {
  const plaintext = input.payloadBytes.slice();
  const namespaceKey = input.namespace.aiKey.slice();
  const durableObjectId = deriveProtectedRecordObjectId(
    input.crypto,
    input.recordId,
    input.representationGeneration,
  );
  let dek: Uint8Array | null = null;
  try {
    const encrypted = encryptObjectPayload(
      input.crypto,
      {
        objectId: objectId(durableObjectId),
        keyClass: "ai",
        objectType: REFLECTION_RECORD_CRYPTO_OBJECT_TYPE,
        createdAt: unixTimestamp(input.createdAt),
      },
      plaintext,
    );
    dek = encrypted.dek;
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(
        input.crypto,
        namespaceKey,
        {
          objectId: objectId(durableObjectId),
          namespaceId: namespaceId(input.namespace.namespaceId),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(input.namespace.keyGeneration),
          bindingRevisionAtWrap: accessRevision(input.namespace.accessRevision),
        },
        dek,
      ),
    );
    const access = prepareAgentObjectAccessManifestGenesis(input.crypto, {
      objectId: objectId(durableObjectId),
      payloadHash: input.crypto.hash(payloadBytes),
      envelopeBytes: [envelopeBytes],
      grant: input.grant,
      namespace: {
        namespaceId: namespaceId(input.namespace.namespaceId),
        accessRevision: accessRevision(input.namespace.accessRevision),
        bindingHash: input.namespace.bindingHash,
        domainId: cryptoDomainId(input.namespace.domainId),
        domainEpoch: domainEpoch(input.namespace.domainEpoch),
      },
      agentAuthorizationRevision: authorizationRevision(
        input.signerPublication.authorizationRevision,
      ),
      runtime: input.runtime,
      signerPublication: input.signerPublication,
    });
    const prepared = Object.freeze({
      objectId: durableObjectId,
      recordId: input.recordId,
      representationGeneration: input.representationGeneration,
    });
    preparedSnapshots.set(prepared, Object.freeze({
      ...prepared,
      payloadHash: input.crypto.hash(plaintext),
      object: encryptedObjectWriteRecord(payloadBytes),
      access,
      resolveCurrentAuthorization: input.resolveCurrentAuthorization,
    }));
    return prepared;
  } finally {
    plaintext.fill(0);
    namespaceKey.fill(0);
    dek?.fill(0);
  }
}

export interface PostgresProtectedRecordPublicationOptions {
  readonly handle: CryptoPostgresHandle;
  readonly crypto: LatticeCrypto;
  readonly resolvePrepared: (
    publicationBindingRef: string,
    expected: Readonly<{
      recordId: string;
      representationGeneration: number;
      payloadBytes: Uint8Array;
    }>,
  ) => PreparedProtectedRecordPublication | null;
  readonly authenticateCommitted: (input: Readonly<{
    objectId: string;
    recordId: string;
    representationGeneration: number;
  }>) => Promise<boolean>;
  readonly openPayload: ProtectedRecordPublicationPort["open"];
  readonly retireObject: (objectId: string) => Promise<void>;
}

/** Product-neutral use of the canonical lattice object/access transaction. */
export function createPostgresProtectedRecordPublicationPort(
  input: PostgresProtectedRecordPublicationOptions,
): ProtectedRecordPublicationPort {
  assertVerifiedCryptoPostgresHandle(input.handle);
  return Object.freeze({
    async publish(
      request: Parameters<ProtectedRecordPublicationPort["publish"]>[0],
    ): Promise<RecordPublicationCryptoResult> {
      const prepared = input.resolvePrepared(request.publicationBindingRef, request);
      const snapshot = prepared === null ? undefined : preparedSnapshots.get(prepared);
      const requestPayloadHash = input.crypto.hash(request.payloadBytes);
      if (
        snapshot === undefined
        || snapshot.recordId !== request.recordId
        || snapshot.representationGeneration !== request.representationGeneration
        || snapshot.payloadHash.byteLength !== requestPayloadHash.byteLength
        || !snapshot.payloadHash.every(
          (value, index) => value === requestPayloadHash[index],
        )
        || snapshot.objectId !== deriveProtectedRecordObjectId(
          input.crypto,
          request.recordId,
          request.representationGeneration,
        )
      ) {
        requestPayloadHash.fill(0);
        return { status: "unavailable", reason: "authorization_unavailable" };
      }
      requestPayloadHash.fill(0);
      try {
        const durable = await withVerifiedCryptoPostgresTransaction(
          input.handle,
          async (handle) => {
            const storage = new PostgresLatticeStorage(handle);
            const existing = await storage.getObject(snapshot.objectId);
            if (existing !== null) {
              const verified = await verifyStored(storage, input.crypto, snapshot.objectId);
              if (!verified) throw new RecordCryptoPublicationMismatch();
              return { status: "duplicate" as const, objectId: snapshot.objectId };
            }
            await storage.putObject(snapshot.object);
            const access = await persistPreparedAgentObjectAccessManifestGenesis({
              crypto: input.crypto,
              storage,
              prepared: snapshot.access,
              resolveCurrentAuthorization: snapshot.resolveCurrentAuthorization,
            });
            if (access === "stale") {
              throw new RecordCryptoAuthorizationUnavailable();
            }
            if (!(await verifyStored(storage, input.crypto, snapshot.objectId))) {
              throw new RecordCryptoPublicationIncomplete();
            }
            return {
              status: access === "duplicate" ? "duplicate" as const : "created" as const,
              objectId: snapshot.objectId,
            };
          },
        );
        if (durable.status === "duplicate" && !(await input.authenticateCommitted({
          objectId: snapshot.objectId,
          recordId: snapshot.recordId,
          representationGeneration: snapshot.representationGeneration,
        }))) {
          return { status: "unavailable", reason: "crypto_mismatch" };
        }
        return durable;
      } catch (error) {
        if (error instanceof RecordCryptoAuthorizationUnavailable) {
          return { status: "unavailable", reason: "authorization_unavailable" };
        }
        if (error instanceof RecordCryptoPublicationIncomplete) {
          return { status: "unavailable", reason: "crypto_incomplete" };
        }
        if (error instanceof RecordCryptoPublicationMismatch) {
          return { status: "unavailable", reason: "crypto_mismatch" };
        }
        return { status: "unavailable", reason: "storage_transient" };
      }
    },
    async verify(
      request: Parameters<ProtectedRecordPublicationPort["verify"]>[0],
    ) {
      const structurallyComplete = await withVerifiedCryptoPostgresTransaction(
        input.handle,
        (handle) => verifyStored(
          new PostgresLatticeStorage(handle),
          input.crypto,
          request.objectId,
        ),
      );
      if (!structurallyComplete) return "absent";
      return await input.authenticateCommitted(request) ? "complete" : "mismatch";
    },
    open: input.openPayload,
    retire: input.retireObject,
  });
}

async function verifyStored(
  storage: PostgresLatticeStorage,
  crypto: LatticeCrypto,
  expectedObjectId: string,
): Promise<boolean> {
  const object = await storage.getObject(expectedObjectId);
  const access = await storage.getObjectAccessState(expectedObjectId);
  if (object === null || access === null) return false;
  try {
    const payload = decodeEncryptedPayloadV2(object.payloadBytes);
    const manifest = decodeObjectAccessManifestV3(access.head.manifestBytes);
    const payloadHash = crypto.hash(object.payloadBytes);
    return payload.context.objectId === expectedObjectId
      && payload.context.objectType === REFLECTION_RECORD_CRYPTO_OBJECT_TYPE
      && payload.context.keyClass === "ai"
      && manifest.objectId === expectedObjectId
      && manifest.payloadHash.every((value, index) => value === payloadHash[index])
      && access.namespaceEnvelopes.length === 1;
  } catch {
    return false;
  }
}
