import type { LatticeCrypto } from "../crypto/index.ts";
import {
  canonicalizeParticipants,
  compareUnsignedUtf8,
} from "../domain/participants.ts";
import {
  grantV2SigningBytes,
  parseGrantSecretV2,
  type GrantOperationV2,
  type GrantV2,
} from "../format/grant-v2.ts";
import {
  accessRevision,
  agentId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceId,
  type AccessRevision,
  type AuthorizationRevision,
  type CryptoDomainId,
  type DomainEpoch,
  type GrantId,
  type NamespaceId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export interface GrantAuthoritySetNamespaceRequirementV2 {
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly operations: readonly GrantOperationV2[];
  readonly namespaceParticipants: readonly string[];
  readonly expectedAccessRevision: AccessRevision;
  readonly expectedPolicyRevision: number;
}

export interface GrantAuthoritySetDomainRequirementV2 {
  readonly domainId: CryptoDomainId;
  readonly expectedEpoch: DomainEpoch;
  readonly expectedAgentAuthorizationRevision: AuthorizationRevision;
}

export interface GrantAuthoritySetAuthorizationV2 {
  readonly now: number;
  readonly expectedIssuingDeviceId: string;
  readonly issuingDeviceHumanId: string;
  readonly issuingDeviceSigningPublicKey: Uint8Array;
  readonly issuingDeviceActive: boolean;
  readonly recipientAgentId: string;
  readonly recipientKeyId: string;
  readonly recipientEncryptionPrivateKey: Uint8Array;
  readonly singleUseAvailable: boolean;
  readonly grantScope: readonly string[];
  readonly namespaceRequirements:
    readonly GrantAuthoritySetNamespaceRequirementV2[];
  readonly domainRequirements: readonly GrantAuthoritySetDomainRequirementV2[];
  readonly hostAllowsOperation: boolean;
}

export interface OpenedGrantAuthoritySetV2 {
  readonly grantId: GrantId;
  readonly namespaceRequirements: readonly Readonly<{
    readonly namespaceId: NamespaceId;
    readonly domainId: CryptoDomainId;
    readonly operations: readonly GrantOperationV2[];
    readonly expectedAccessRevision: AccessRevision;
    readonly expectedPolicyRevision: number;
  }>[];
  readonly domains: readonly Readonly<{
    readonly domainId: CryptoDomainId;
    readonly expectedEpoch: DomainEpoch;
    readonly expectedAgentAuthorizationRevision: AuthorizationRevision;
    readonly aiRoot: Uint8Array;
  }>[];
}

const AUTHORIZATION_FIELDS = Object.freeze([
  "domainRequirements",
  "expectedIssuingDeviceId",
  "grantScope",
  "hostAllowsOperation",
  "issuingDeviceActive",
  "issuingDeviceHumanId",
  "issuingDeviceSigningPublicKey",
  "namespaceRequirements",
  "now",
  "recipientAgentId",
  "recipientEncryptionPrivateKey",
  "recipientKeyId",
  "singleUseAvailable",
] as const);
const NAMESPACE_FIELDS = Object.freeze([
  "domainId",
  "expectedAccessRevision",
  "expectedPolicyRevision",
  "namespaceId",
  "namespaceParticipants",
  "operations",
] as const);
const DOMAIN_FIELDS = Object.freeze([
  "domainId",
  "expectedAgentAuthorizationRevision",
  "expectedEpoch",
] as const);

function exactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length
    || !actual.every((field, index) => field === expected[index])
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalOperations(
  operations: readonly GrantOperationV2[],
): readonly GrantOperationV2[] {
  if (
    !Array.isArray(operations as unknown)
    || operations.length < 1
    || operations.length > 2
  ) {
    throw new TypeError("Grant authority operations are invalid");
  }
  const canonical = [...new Set(operations)].sort(compareUnsignedUtf8);
  if (
    !canonical.every((operation) =>
      operation === "decrypt" || operation === "encrypt"
    )
    || !equalStrings(canonical, operations)
  ) {
    throw new TypeError("Grant authority operations must be canonical");
  }
  return Object.freeze(canonical);
}

function canonicalHumans(
  label: string,
  values: readonly string[],
  maximum: number,
): readonly string[] {
  if (
    !Array.isArray(values as unknown)
    || values.length < 1
    || values.length > maximum
  ) {
    throw new TypeError(`${label} is empty or exceeds its bound`);
  }
  const canonical = canonicalizeParticipants(values.map(humanId));
  if (!equalStrings(canonical, values)) {
    throw new TypeError(`${label} must be canonical and unique`);
  }
  return Object.freeze(canonical);
}

function isSubset(subset: readonly string[], superset: readonly string[]): boolean {
  const members = new Set(superset);
  return subset.every((value) => members.has(value));
}

export function snapshotGrantAuthoritySetAuthorizationV2(
  value: GrantAuthoritySetAuthorizationV2,
): GrantAuthoritySetAuthorizationV2 {
  exactFields("Grant authority-set authorization", value, AUTHORIZATION_FIELDS);
  if (
    !Number.isSafeInteger(value.now)
    || typeof value.issuingDeviceActive !== "boolean"
    || typeof value.singleUseAvailable !== "boolean"
    || typeof value.hostAllowsOperation !== "boolean"
    || !Array.isArray(value.namespaceRequirements as unknown)
    || value.namespaceRequirements.length < 1
    || value.namespaceRequirements.length > V2_LIMITS.agentGrantNamespaces
    || !Array.isArray(value.domainRequirements as unknown)
    || value.domainRequirements.length < 1
    || value.domainRequirements.length > V2_LIMITS.agentGrantDomains
  ) {
    throw new TypeError("Grant authority-set authorization is invalid");
  }
  const grantScope = canonicalHumans(
    "Grant authority scope",
    value.grantScope,
    V2_LIMITS.grantScopeHumans,
  );
  let previousNamespaceId: string | null = null;
  const namespaceRequirements = value.namespaceRequirements.map((entry) => {
    exactFields("Grant Namespace requirement", entry, NAMESPACE_FIELDS);
    const currentNamespaceId = namespaceId(entry.namespaceId);
    const currentDomainId = cryptoDomainId(entry.domainId);
    const participants = canonicalHumans(
      "Grant Namespace participants",
      entry.namespaceParticipants,
      V2_LIMITS.humanParticipantsPerDomain,
    );
    const operations = canonicalOperations(entry.operations);
    const expectedAccessRevision = accessRevision(entry.expectedAccessRevision);
    assertU64Counter("Policy revision", entry.expectedPolicyRevision);
    if (
      previousNamespaceId !== null
      && compareUnsignedUtf8(previousNamespaceId, currentNamespaceId) >= 0
    ) {
      throw new TypeError("Grant Namespace requirements must be canonical");
    }
    previousNamespaceId = currentNamespaceId;
    return Object.freeze({
      namespaceId: currentNamespaceId,
      domainId: currentDomainId,
      operations,
      namespaceParticipants: participants,
      expectedAccessRevision,
      expectedPolicyRevision: entry.expectedPolicyRevision,
    });
  });
  let previousDomainId: string | null = null;
  const domainRequirements = value.domainRequirements.map((entry) => {
    exactFields("Grant Domain requirement", entry, DOMAIN_FIELDS);
    const currentDomainId = cryptoDomainId(entry.domainId);
    if (
      previousDomainId !== null
      && compareUnsignedUtf8(previousDomainId, currentDomainId) >= 0
    ) {
      throw new TypeError("Grant Domain requirements must be canonical");
    }
    previousDomainId = currentDomainId;
    return Object.freeze({
      domainId: currentDomainId,
      expectedEpoch: domainEpoch(entry.expectedEpoch),
      expectedAgentAuthorizationRevision: authorizationRevision(
        entry.expectedAgentAuthorizationRevision,
      ),
    });
  });
  const namespaceDomains = [...new Set(
    namespaceRequirements.map((entry) => entry.domainId),
  )].sort(compareUnsignedUtf8);
  if (!equalStrings(
    namespaceDomains,
    domainRequirements.map((entry) => entry.domainId),
  )) {
    throw new TypeError("Grant Domain set must exactly cover Namespace Domains");
  }
  return Object.freeze({
    now: value.now,
    expectedIssuingDeviceId: cryptoDeviceId(value.expectedIssuingDeviceId),
    issuingDeviceHumanId: humanId(value.issuingDeviceHumanId),
    issuingDeviceSigningPublicKey:
      copyOwnedBytesV2(value.issuingDeviceSigningPublicKey),
    issuingDeviceActive: value.issuingDeviceActive,
    recipientAgentId: agentId(value.recipientAgentId),
    recipientKeyId: value.recipientKeyId,
    recipientEncryptionPrivateKey:
      copyOwnedBytesV2(value.recipientEncryptionPrivateKey),
    singleUseAvailable: value.singleUseAvailable,
    grantScope,
    namespaceRequirements: Object.freeze(namespaceRequirements),
    domainRequirements: Object.freeze(domainRequirements),
    hostAllowsOperation: value.hostAllowsOperation,
  });
}

export async function openGrantV2ForAuthoritySet(
  crypto: LatticeCrypto,
  grant: GrantV2,
  authorization: GrantAuthoritySetAuthorizationV2,
): Promise<OpenedGrantAuthoritySetV2 | null> {
  let current: GrantAuthoritySetAuthorizationV2;
  try {
    current = snapshotGrantAuthoritySetAuthorizationV2(authorization);
  } catch {
    return null;
  }
  let plaintext: Uint8Array | null = null;
  let openedDomains: Array<OpenedGrantAuthoritySetV2["domains"][number]> = [];
  try {
    const requestedOperations = [...new Set(
      current.namespaceRequirements.flatMap((entry) => entry.operations),
    )].sort(compareUnsignedUtf8);
    const exactDomains = grant.coveredDomains.length
        === current.domainRequirements.length
      && grant.coveredDomains.every((covered, index) => {
        const requested = current.domainRequirements[index]!;
        return covered.domainId === requested.domainId
          && covered.domainEpoch === requested.expectedEpoch
          && covered.agentAuthorizationRevision
            === requested.expectedAgentAuthorizationRevision;
      });
    if (
      grant.consumed
      || (grant.singleUse && !current.singleUseAvailable)
      || grant.issuingDeviceId !== current.expectedIssuingDeviceId
      || grant.recipientAgentId !== current.recipientAgentId
      || grant.recipientKeyId !== current.recipientKeyId
      || !current.issuingDeviceActive
      || !current.hostAllowsOperation
      || current.now < grant.issuedAt
      || current.now >= grant.expiresAt
      || !equalStrings(grant.scope, current.grantScope)
      || !current.grantScope.includes(current.issuingDeviceHumanId)
      || !equalStrings(grant.operations, requestedOperations)
      || !exactDomains
      || !current.namespaceRequirements.every((entry) =>
        isSubset(current.grantScope, entry.namespaceParticipants)
      )
      || !crypto.verify(
        current.issuingDeviceSigningPublicKey,
        grantV2SigningBytes(grant),
        grant.signature,
      )
    ) {
      return null;
    }
    plaintext = await crypto.openSealed(
      current.recipientEncryptionPrivateKey,
      grant.encryptedSecret,
    );
    if (plaintext === null) return null;
    const secret = parseGrantSecretV2(plaintext);
    if (
      secret === null
      || secret.length !== current.domainRequirements.length
      || !secret.every(
        (entry, index) => entry.domainId
          === current.domainRequirements[index]!.domainId,
      )
    ) {
      secret?.forEach((entry) => entry.aiRoot.fill(0));
      return null;
    }
    try {
      openedDomains = secret.map((entry, index) => {
        const required = current.domainRequirements[index]!;
        return Object.freeze({
          domainId: required.domainId,
          expectedEpoch: required.expectedEpoch,
          expectedAgentAuthorizationRevision:
            required.expectedAgentAuthorizationRevision,
          aiRoot: copyOwnedBytesV2(entry.aiRoot),
        });
      });
    } finally {
      secret.forEach((entry) => entry.aiRoot.fill(0));
    }
    const opened = Object.freeze({
      grantId: grantId(grant.id),
      namespaceRequirements: Object.freeze(
        current.namespaceRequirements.map((entry) => Object.freeze({
          namespaceId: entry.namespaceId,
          domainId: entry.domainId,
          operations: Object.freeze([...entry.operations]),
          expectedAccessRevision: entry.expectedAccessRevision,
          expectedPolicyRevision: entry.expectedPolicyRevision,
        })),
      ),
      domains: Object.freeze(openedDomains),
    });
    openedDomains = [];
    return opened;
  } catch {
    return null;
  } finally {
    openedDomains.forEach((entry) => entry.aiRoot.fill(0));
    plaintext?.fill(0);
    current.recipientEncryptionPrivateKey.fill(0);
  }
}
