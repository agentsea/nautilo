import type {
  AgentRuntimeKeyGeneration,
  LatticeCrypto,
} from "@nautilo/lattice-crypto";

import {
  createAgentObjectProtector,
  type AgentObjectProtectionResult,
  type AgentObjectProtectionSource,
  type VerifiedAgentObject,
} from "./agent-object-protector.ts";
import {
  prepareDeviceWrappedAgentObject,
  type DeviceWrappedAgentObjectNamespaceMaterial,
  type PreparedDeviceWrappedAgentObject,
} from "./device-wrapped-agent-object-crypto.ts";
import type { ForegroundAgentEntityCryptoInvocation } from
  "./foreground-agent-entity-crypto.ts";

export type ForegroundAgentObjectRepairSource = AgentObjectProtectionSource;
export type ForegroundAgentObjectRepairResult<Value> =
  AgentObjectProtectionResult<Value>;
export type VerifiedForegroundAgentObject = VerifiedAgentObject;

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
  }>;
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
}> {
  const protector = createAgentObjectProtector({
    crypto: input.crypto,
    entities: input.entities,
    read: input.read,
    prepareAndPersist: ({ operationId, source, opened }) => {
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
      return input.persist(prepareDeviceWrappedAgentObject({
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
      }));
    },
  });
  return Object.freeze({
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
