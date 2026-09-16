import type { DomainKeyClass } from "@nautilo/lattice-crypto";

import {
  type ClientNamespaceGenerationCacheEntryV1,
  type ClientNamespaceGenerationCacheRequirementV1,
  type ClientNamespaceGenerationCacheVaultV1,
} from "./namespace-generation-cache-v1.ts";
import type { ClientProfileCoordinates } from "./types.ts";

const DOMAIN_CACHE_NAMESPACE_PREFIX = "domain-key-v2:";
const HASH_BYTES = 32;

export interface ClientDomainKeyCacheRequirementV2 {
  readonly serverId: string;
  readonly domainId: string;
  readonly participantDigest: Uint8Array;
  readonly participantCount: number;
  readonly keyClass: DomainKeyClass;
  readonly domainKeyGeneration: number;
  readonly authorizationRevision: number;
  readonly headDigest: Uint8Array;
  readonly recipientDeviceGeneration: number;
}

export interface ClientDomainKeyCacheEntryV2
  extends ClientDomainKeyCacheRequirementV2 {
  readonly domainKey: Uint8Array;
}

export interface ClientDomainKeyCacheVaultV2 {
  availability(): ReturnType<ClientNamespaceGenerationCacheVaultV1["availability"]>;
  unlock(): ReturnType<ClientNamespaceGenerationCacheVaultV1["unlock"]>;
  lock(): ReturnType<ClientNamespaceGenerationCacheVaultV1["lock"]>;
  withKey<Value>(
    coordinates: ClientProfileCoordinates,
    requirement: ClientDomainKeyCacheRequirementV2,
    use: (domainKey: Uint8Array) => Value | Promise<Value>,
  ): Promise<Readonly<{ status: "hit"; value: Value }> | Readonly<{
    status: "miss";
  }>>;
  putKey(
    coordinates: ClientProfileCoordinates,
    entry: ClientDomainKeyCacheEntryV2,
  ): Promise<void>;
  evict(
    coordinates: ClientProfileCoordinates,
    domainId?: string,
  ): Promise<void>;
  forget(coordinates: ClientProfileCoordinates): Promise<void>;
}

function portable(label: string, value: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function counter(label: string, value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function digest(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.slice();
}

function normalize(
  value: ClientDomainKeyCacheRequirementV2,
): ClientDomainKeyCacheRequirementV2 {
  return Object.freeze({
    serverId: portable("Domain cache server", value.serverId),
    domainId: portable("Domain cache Domain", value.domainId),
    participantDigest: digest(
      "Domain cache participant digest",
      value.participantDigest,
    ),
    participantCount: counter(
      "Domain cache participant count",
      value.participantCount,
      1,
    ),
    keyClass: value.keyClass === "human" || value.keyClass === "ai"
      ? value.keyClass
      : (() => { throw new TypeError("Domain cache key class is invalid"); })(),
    domainKeyGeneration: counter(
      "Domain cache key generation",
      value.domainKeyGeneration,
      1,
    ),
    authorizationRevision: counter(
      "Domain cache authorization revision",
      value.authorizationRevision,
      1,
    ),
    headDigest: digest("Domain cache head digest", value.headDigest),
    recipientDeviceGeneration: counter(
      "Domain cache recipient generation",
      value.recipientDeviceGeneration,
      1,
    ),
  });
}

function underlyingRequirement(
  value: ClientDomainKeyCacheRequirementV2,
): ClientNamespaceGenerationCacheRequirementV1 {
  const requirement = normalize(value);
  return Object.freeze({
    namespaceId: `${DOMAIN_CACHE_NAMESPACE_PREFIX}${requirement.domainId}`,
    keyClass: requirement.keyClass,
    accessRevision: requirement.authorizationRevision,
    generation: requirement.domainKeyGeneration,
    headDigest: requirement.headDigest,
    publicationDigest: requirement.headDigest.slice(),
    publicationSetDigest: requirement.participantDigest,
    audienceFingerprint: requirement.participantDigest.slice(),
    recipientKeyGeneration: requirement.recipientDeviceGeneration,
  });
}

function destroyUnderlyingRequirement(
  value: ClientNamespaceGenerationCacheRequirementV1,
): void {
  value.headDigest.fill(0);
  value.publicationDigest.fill(0);
  value.publicationSetDigest.fill(0);
  value.audienceFingerprint.fill(0);
}

/**
 * V2 Domain-key cache over the already-qualified Browser/Electron sealed
 * cache custody. The adapter intentionally exposes no Namespace authority:
 * its wrapped store is merely an encrypted bounded persistence mechanism.
 */
class ClientDomainKeyCacheVaultAdapterV2
implements ClientDomainKeyCacheVaultV2 {
  constructor(
    private readonly underlying: ClientNamespaceGenerationCacheVaultV1,
  ) {}

  availability() {
    return this.underlying.availability();
  }

  unlock() {
    return this.underlying.unlock();
  }

  lock() {
    return this.underlying.lock();
  }

  async withKey<Value>(
    coordinates: ClientProfileCoordinates,
    requirement: ClientDomainKeyCacheRequirementV2,
    use: (domainKey: Uint8Array) => Value | Promise<Value>,
  ): Promise<Readonly<{ status: "hit"; value: Value }> | Readonly<{
    status: "miss";
  }>> {
    const underlying = underlyingRequirement(requirement);
    try {
      return await this.underlying.withEntries(
        coordinates,
        [underlying],
        (entries) => use(entries[0]!.generationKey),
      );
    } finally {
      destroyUnderlyingRequirement(underlying);
    }
  }

  async putKey(
    coordinates: ClientProfileCoordinates,
    value: ClientDomainKeyCacheEntryV2,
  ): Promise<void> {
    const requirement = underlyingRequirement(value);
    const domainKey = digest("Domain cache key", value.domainKey);
    const entry: ClientNamespaceGenerationCacheEntryV1 = Object.freeze({
      ...requirement,
      generationKey: domainKey,
    });
    try {
      await this.underlying.putEntries(coordinates, [entry]);
    } finally {
      destroyUnderlyingRequirement(requirement);
      domainKey.fill(0);
    }
  }

  evict(
    coordinates: ClientProfileCoordinates,
    domainId?: string,
  ): Promise<void> {
    return this.underlying.evict(
      coordinates,
      domainId === undefined
        ? undefined
        : `${DOMAIN_CACHE_NAMESPACE_PREFIX}${portable(
          "Domain cache Domain",
          domainId,
        )}`,
    );
  }

  forget(coordinates: ClientProfileCoordinates): Promise<void> {
    return this.underlying.forget(coordinates);
  }
}

export function createClientDomainKeyCacheVaultV2(
  underlying: ClientNamespaceGenerationCacheVaultV1,
): ClientDomainKeyCacheVaultV2 {
  return new ClientDomainKeyCacheVaultAdapterV2(underlying);
}
