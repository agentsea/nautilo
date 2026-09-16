import {
  canonicalizeParticipants,
  compareUnsignedUtf8,
} from "../domain/participants.ts";
import type {
  AccessRevision,
  AuthorizationRevision,
  CryptoDomainId,
  DomainEpoch,
  HumanId,
  NamespaceId,
} from "../v2-types/ids.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
} from "../v2-types/ids.ts";
import {
  assertV2Range,
  V2_LIMITS,
} from "../v2-types/limits.ts";

export interface GrantNamespaceCandidateV2 {
  readonly namespaceId: NamespaceId;
  readonly participants: readonly HumanId[];
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly namespaceAccessRevision: AccessRevision;
}

export interface CoveredGrantDomainV2 {
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly agentAuthorizationRevision: AuthorizationRevision;
}

export interface GrantDomainEnumerationV2 {
  readonly domains: readonly CoveredGrantDomainV2[];
  readonly coveredNamespaceCount: number;
  readonly distinctDomainCount: number;
}

type DomainAccumulator = CoveredGrantDomainV2 & {
  readonly participants: readonly HumanId[];
};

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length
    && left.every((value, index) => value === right[index])
  );
}

function isSubset(
  scope: readonly HumanId[],
  participants: readonly HumanId[],
): boolean {
  const available = new Set(participants);
  return scope.every((participant) => available.has(participant));
}

/**
 * Enumerate the Domain-sized authorization snapshot for a grant.
 *
 * Namespace heads stay dynamic operation-time inputs; the sealed grant secret
 * needs only one AI root per returned Domain.
 */
export function enumerateGrantDomains(
  rawScope: readonly HumanId[],
  candidates: Iterable<GrantNamespaceCandidateV2>,
): GrantDomainEnumerationV2 {
  assertV2Range(
    "Grant Human scope",
    rawScope.length,
    1,
    V2_LIMITS.grantScopeHumans,
  );
  const scope = canonicalizeParticipants(rawScope);
  const domains = new Map<CryptoDomainId, DomainAccumulator>();
  let coveredNamespaceCount = 0;

  for (const candidate of candidates) {
    namespaceId(candidate.namespaceId);
    cryptoDomainId(candidate.domainId);
    domainEpoch(candidate.domainEpoch);
    authorizationRevision(candidate.agentAuthorizationRevision);
    accessRevision(candidate.namespaceAccessRevision);
    const participants = canonicalizeParticipants(candidate.participants);
    if (!equalStrings(participants, candidate.participants)) {
      throw new RangeError(
        `Namespace ${candidate.namespaceId} participants are not canonical`,
      );
    }
    if (!isSubset(scope, participants)) continue;
    coveredNamespaceCount += 1;

    const existing = domains.get(candidate.domainId);
    if (existing) {
      if (
        existing.domainEpoch !== candidate.domainEpoch
        || existing.agentAuthorizationRevision
          !== candidate.agentAuthorizationRevision
        || !equalStrings(existing.participants, participants)
      ) {
        throw new Error(
          `inconsistent current metadata for Crypto Domain ${candidate.domainId}`,
        );
      }
      continue;
    }

    assertV2Range(
      "Distinct covered Crypto Domains",
      domains.size + 1,
      1,
      V2_LIMITS.agentGrantDomains,
    );
    domains.set(candidate.domainId, {
      domainId: candidate.domainId,
      domainEpoch: candidate.domainEpoch,
      agentAuthorizationRevision: candidate.agentAuthorizationRevision,
      participants,
    });
  }

  const ordered = [...domains.values()]
    .sort((left, right) =>
      compareUnsignedUtf8(left.domainId, right.domainId)
    )
    .map(({
      participants: _participants,
      ...domain
    }) => Object.freeze(domain));

  return Object.freeze({
    domains: Object.freeze(ordered),
    coveredNamespaceCount,
    distinctDomainCount: ordered.length,
  });
}
