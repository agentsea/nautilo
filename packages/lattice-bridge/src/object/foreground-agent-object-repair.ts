import type {
  AgentRuntimeKeyGeneration,
  LatticeCrypto,
  TaskRuntimePublicationSigning,
} from "@nautilo/lattice-crypto";

import {
  createAgentObjectProtector,
  type AgentObjectProtectionResult,
  type AgentObjectProtectionSource,
  type AgentObjectPreparationSource,
  type AgentObjectProtectionNamespace,
  type VerifiedAgentObject,
} from "./agent-object-protector.ts";
import {
  prepareDeviceWrappedAgentObject,
  readPreparedDeviceWrappedAgentObjectSnapshot,
  type DeviceWrappedAgentObjectNamespaceMaterial,
  type PreparedDeviceWrappedAgentObject,
} from "./device-wrapped-agent-object-crypto.ts";
import type { ForegroundAgentEntityCryptoInvocation } from
  "./foreground-agent-entity-crypto.ts";

export type ForegroundAgentObjectRepairSource = AgentObjectProtectionSource;
export type ForegroundAgentObjectRepairResult<Value> =
  AgentObjectProtectionResult<Value>;
export type VerifiedForegroundAgentObject = VerifiedAgentObject;

/** Trusted persistence owner for fresh writes with a durable publication receipt. */
export interface ForegroundAgentFreshPublication {
  recover(input: Readonly<{ source: AgentObjectPreparationSource;
    namespaces: readonly AgentObjectProtectionNamespace["authority"][];
  }>): Promise<VerifiedForegroundAgentObject | null>;
  persist(prepared: PreparedDeviceWrappedAgentObject, source: AgentObjectPreparationSource):
    Promise<"created" | "duplicate" | "stale">;
}

/** Foreground Grant adapter over the family-neutral Agent object protector. */
export function createForegroundAgentObjectRepairer(input: Readonly<{
  crypto: LatticeCrypto;
  entities: Pick<
    ForegroundAgentEntityCryptoInvocation,
    "signal" | "use" | "useCurrentSet"
  >;
  publication: Readonly<{
    operationId: string;
    grantId: string;
    grantDigest: Uint8Array;
    recipientKeyId: string;
    runtime: AgentRuntimeKeyGeneration;
    signerKeyId: string;
    signerPublicKey: Uint8Array;
    agentAuthorizationRevision: number;
    taskRuntimeSigner?: TaskRuntimePublicationSigning;
  }>;
  freshPublication?: ForegroundAgentFreshPublication;
  persist(prepared: PreparedDeviceWrappedAgentObject): Promise<
    "created" | "duplicate" | "stale"
  >;
  read(request: Readonly<{
    objectId: string;
    expectedObjectType: string;
    expectedAccessRevision?: number;
    expectedNamespaceIds: readonly string[];
  }>): Promise<VerifiedForegroundAgentObject | null>;
}>): Readonly<{
  protect<Value>(request: Readonly<{
    source: ForegroundAgentObjectRepairSource;
    decode(plaintextBytes: Uint8Array): Value;
  }>): Promise<ForegroundAgentObjectRepairResult<Value>>;
  /** Verify newly persisted bytes without acquiring authority to read existing content. */
  publishFresh<Value>(request: Readonly<{
    source: AgentObjectPreparationSource;
    decode(plaintextBytes: Uint8Array): Value;
  }>): Promise<ForegroundAgentObjectRepairResult<Value>>;
}> {
  const prepare = ({ operationId, source, opened }: Readonly<{
    operationId: string;
    source: AgentObjectPreparationSource;
    opened: readonly AgentObjectProtectionNamespace[];
  }>) => {
      const namespaceSet: DeviceWrappedAgentObjectNamespaceMaterial[] =
        opened.map((item) => ({
          namespaceId: item.authority.namespaceId,
          accessRevision: item.authority.namespaceAccessRevision,
          keyGeneration: item.authority.namespaceKeyGeneration,
          domainId: item.authority.domainId,
          domainKeyGeneration: item.authority.domainKeyGeneration,
          domainAuthorizationRevision:
            item.authority.domainAuthorizationRevision,
          domainHeadDigest: item.authority.domainHeadDigest,
          headDigest: item.authority.namespaceHeadDigest,
          publicationDigest: item.authority.namespacePublicationDigest,
          publicationSetDigest:
            item.authority.namespacePublicationSetDigest,
          audienceFingerprint:
            item.authority.namespaceAudienceFingerprint,
          key: item.namespaceKey,
        }));
      return prepareDeviceWrappedAgentObject({
        crypto: input.crypto,
        objectId: source.objectId,
        objectType: source.objectType,
        plaintextBytes: source.plaintextBytes,
        createdAt: source.createdAt,
        namespaceSet,
        operationId,
        grant: {
          grantId: input.publication.grantId,
          grantHash: input.publication.grantDigest,
          recipientKeyId: input.publication.recipientKeyId,
        },
        runtime: input.publication.runtime,
        signerKeyId: input.publication.signerKeyId,
        signerPublicKey: input.publication.signerPublicKey,
        agentAuthorizationRevision:
          input.publication.agentAuthorizationRevision,
        ...(input.publication.taskRuntimeSigner === undefined ? {} : {
          taskRuntimeSigner: input.publication.taskRuntimeSigner,
        }),
      });
  };
  const protector = createAgentObjectProtector({
    crypto: input.crypto, entities: input.entities, read: input.read,
    prepareAndPersist: request => input.persist(prepare(request)),
  });
  const wipe = (durable: VerifiedAgentObject) => {
    durable.payloadBytes.fill(0);
    durable.namespaceEnvelopes.forEach(entry => entry.envelopeBytes.fill(0));
  };
  const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length
    && left.every((value, index) => value === right[index]);
  return Object.freeze({
    publishFresh: async <Value>(request: Readonly<{
      source: AgentObjectPreparationSource;
      decode(plaintextBytes: Uint8Array): Value;
    }>): Promise<ForegroundAgentObjectRepairResult<Value>> => {
      const source = Object.freeze({ ...request.source,
        namespaceIds: Object.freeze([...request.source.namespaceIds]),
        plaintextBytes: Uint8Array.from(request.source.plaintextBytes) });
      const unavailable = (): ForegroundAgentObjectRepairResult<Value> =>
        Object.freeze({ status: "waiting_for_authority", reason: "entity_namespace_authority_unavailable" });
      const read = (expectedAccessRevision?: number) => input.read({ objectId: source.objectId,
        expectedObjectType: source.objectType,
        ...(expectedAccessRevision === undefined ? {} : { expectedAccessRevision }),
        expectedNamespaceIds: source.namespaceIds });
      try {
        if (input.entities.signal.aborted) return unavailable();
        if (source.existingObjectId !== null
          || source.expectedAccessRevision !== undefined && source.expectedAccessRevision !== 0
          || source.namespaceIds.length === 0
          || source.namespaceIds.some((id, index) => index > 0 && source.namespaceIds[index - 1]! >= id)) {
          return { status: "failed", reason: "entity_namespace_set_invalid" };
        }
        const existing = input.freshPublication === undefined ? await read() : null;
        if (existing !== null) {
          wipe(existing);
          if (existing.accessRevision !== 0) return unavailable();
          // Existing bytes require the ordinary authenticated read/parity path.
          // An encrypt-only grant cannot adopt a collision or decrypt it here.
          return await protector.protect({ operationId: input.publication.operationId,
            source, decode: request.decode });
        }
        const published = await input.entities.useCurrentSet({ operations: ["encrypt"],
          namespaceIds: source.namespaceIds, execute: async opened => {
            if (opened.length !== source.namespaceIds.length
              || opened.some((entry, index) => entry.authority.namespaceId !== source.namespaceIds[index])) {
              return { status: "failed" as const, reason: "entity_namespace_set_invalid" };
            }
            if (input.freshPublication !== undefined) {
              const recovered = await input.freshPublication.recover({ source,
                namespaces: opened.map(entry => entry.authority) });
              if (recovered !== null) {
                try {
                  if (recovered.objectId !== source.objectId || recovered.accessRevision !== 0
                    || recovered.namespaceEnvelopes.length !== opened.length
                    || recovered.namespaceEnvelopes.some((entry, index) => {
                      const expected = opened[index]!.authority;
                      return entry.namespaceId !== expected.namespaceId
                        || entry.keyGeneration !== expected.namespaceKeyGeneration
                        || entry.bindingRevisionAtWrap !== expected.namespaceAccessRevision;
                    }) || input.entities.signal.aborted) return unavailable();
                  return Object.freeze({ status: "verified" as const, objectId: source.objectId,
                    provenance: "existing" as const, verification: "authenticated" as const,
                    value: request.decode(source.plaintextBytes) });
                } finally { wipe(recovered); }
              }
            }
            const prepared = prepare({ operationId: input.publication.operationId, source, opened });
            const snapshot = readPreparedDeviceWrappedAgentObjectSnapshot(prepared);
            // Retain our preparation bytes independently across the persistence callback.
            const expectedPayload = Uint8Array.from(snapshot.object.payloadBytes.ciphertext);
            const expectedEnvelopes = snapshot.access.envelopeBytes.map(bytes => Uint8Array.from(bytes));
            try {
              const persisted = input.freshPublication === undefined
                ? await input.persist(prepared)
                : await input.freshPublication.persist(prepared, source);
              if (persisted === "stale") return unavailable();
              const durable = await read(0);
              if (durable === null) return { status: "failed" as const, reason: "entity_crypto_publication_incomplete" };
              try {
                if (durable.objectId !== source.objectId || durable.accessRevision !== 0
                  || !equal(durable.payloadBytes, expectedPayload)
                  || durable.namespaceEnvelopes.length !== opened.length
                  || durable.namespaceEnvelopes.some((entry, index) => {
                    const expected = opened[index]!.authority;
                    return entry.namespaceId !== expected.namespaceId
                      || entry.keyGeneration !== expected.namespaceKeyGeneration
                      || entry.bindingRevisionAtWrap !== expected.namespaceAccessRevision
                      || !equal(entry.envelopeBytes, expectedEnvelopes[index]!);
                  })) return { status: "failed" as const, reason: "entity_parity_mismatch" };
                if (input.entities.signal.aborted) return unavailable();
                return Object.freeze({ status: "verified" as const, objectId: source.objectId,
                  provenance: "repaired" as const, verification: "authenticated" as const,
                  value: request.decode(source.plaintextBytes) });
              } finally { wipe(durable); }
            } finally {
              expectedPayload.fill(0);
              expectedEnvelopes.forEach(bytes => bytes.fill(0));
              snapshot.object.payloadBytes.ciphertext.fill(0);
              snapshot.access.manifestBytes.fill(0);
              snapshot.access.manifestHash.fill(0);
              snapshot.access.envelopeBytes.forEach(bytes => bytes.fill(0));
            }
          } });
        return published.status === "executed" ? published.value : unavailable();
      } catch {
        return { status: "failed", reason: "entity_repair_failed" };
      } finally { source.plaintextBytes.fill(0); }
    },
    protect: <Value>(request: Readonly<{
      source: ForegroundAgentObjectRepairSource;
      decode(plaintextBytes: Uint8Array): Value;
    }>) => protector.protect({
      operationId: input.publication.operationId,
      source: request.source,
      decode: request.decode,
    }),
  });
}
