import type { LatticeCrypto } from "../crypto/index.ts";
import {
  canonicalizeParticipants,
  compareUnsignedUtf8,
} from "../domain/participants.ts";
import {
  GRANT_V2_FORMAT_VERSION,
  GRANT_V2_SCHEME,
  grantV2SigningBytes,
  parseGrantSecretV2,
  serializeGrantSecretV2,
  type GrantCoveredDomainV2,
  type GrantOperationV2,
  type GrantSecretDomainRootV2,
  type GrantV2,
} from "../format/grant-v2.ts";
import type {
  AccessRevision,
  AgentId,
  AuthorizationRevision,
  CryptoDeviceId,
  CryptoDomainId,
  DomainEpoch,
  GrantId,
  HumanId,
  NamespaceId,
} from "../v2-types/ids.ts";
import {
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceId,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import { assertV2Range, V2_LIMITS } from "../v2-types/limits.ts";

export interface MintGrantDomainV2 extends GrantCoveredDomainV2 {
  readonly aiRoot: Uint8Array;
}

export interface MintGrantV2Input {
  readonly id: GrantId;
  readonly issuingDeviceId: CryptoDeviceId;
  readonly issuingHumanId: HumanId;
  readonly issuingDeviceSigningPrivateKey: Uint8Array;
  readonly recipientAgentId: AgentId;
  readonly recipientKeyId: string;
  readonly recipientEncryptionPublicKey: Uint8Array;
  readonly scope: readonly HumanId[];
  readonly operations: readonly GrantOperationV2[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly coveredDomains: readonly MintGrantDomainV2[];
  readonly singleUse: boolean;
}

/**
 * All fields here are fresh operation-time facts supplied by the host/device
 * boundary. Callers must rebuild this input for every operation; a cache may
 * retain parsed bytes but must never retain an authorization success.
 */
export interface GrantOperationAuthorizationV2 {
  readonly now: number;
  readonly expectedIssuingDeviceId: CryptoDeviceId;
  readonly issuingDeviceHumanId: HumanId;
  readonly issuingDeviceSigningPublicKey: Uint8Array;
  readonly issuingDeviceActive: boolean;
  readonly recipientAgentId: AgentId;
  readonly recipientKeyId: string;
  readonly recipientEncryptionPrivateKey: Uint8Array;
  readonly operation: GrantOperationV2;
  /**
   * Fresh storage result. Reusable grants set this true. For single-use grants
   * the coordinator must first observe an unconsumed row, then atomically
   * claim it after this possession/preflight step and immediately before the
   * operation. A failed or ambiguous claim never enters the crypto tail.
   */
  readonly singleUseAvailable: boolean;
  readonly namespaceId: NamespaceId;
  readonly namespaceAccessRevision: AccessRevision;
  readonly namespaceParticipants: readonly HumanId[];
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly hostAllowsOperation: boolean;
}

export interface OpenedGrantDomainV2 {
  readonly grantId: GrantId;
  readonly namespaceId: NamespaceId;
  readonly namespaceAccessRevision: AccessRevision;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly aiRoot: Uint8Array;
}

function isCanonicalParticipants(
  participants: readonly HumanId[],
): boolean {
  let canonical: readonly HumanId[];
  try {
    canonical = canonicalizeParticipants(participants);
  } catch {
    return false;
  }
  return canonical.every(
    (value, index) => value === participants[index],
  );
}

function isSubset(
  subset: readonly HumanId[],
  superset: readonly HumanId[],
): boolean {
  const values = new Set(superset);
  return subset.every((value) => values.has(value));
}

function validateMintDomains(
  domains: readonly MintGrantDomainV2[],
): {
  readonly coveredDomains: readonly GrantCoveredDomainV2[];
  readonly secret: readonly GrantSecretDomainRootV2[];
} {
  if (!Array.isArray(domains as unknown)) {
    throw new TypeError("Grant Domains must be an array");
  }
  assertV2Range(
    "Grant covered Domains",
    domains.length,
    1,
    V2_LIMITS.agentGrantDomains,
  );
  const coveredDomains: GrantCoveredDomainV2[] = [];
  const secret: GrantSecretDomainRootV2[] = [];
  try {
    for (const [index, domain] of domains.entries()) {
      cryptoDomainId(domain.domainId);
      domainEpoch(domain.domainEpoch);
      authorizationRevision(domain.agentAuthorizationRevision);
      if (
        !(domain.aiRoot instanceof Uint8Array)
        || domain.aiRoot.length !== 32
      ) {
        throw new RangeError("Grant AI root must be exactly 32 bytes");
      }
      if (
        index > 0
        && compareUnsignedUtf8(domains[index - 1]!.domainId, domain.domainId)
          >= 0
      ) {
        throw new RangeError(
          "Grant covered Domains must be canonical and unique",
        );
      }
      coveredDomains.push(Object.freeze({
        domainId: domain.domainId,
        domainEpoch: domain.domainEpoch,
        agentAuthorizationRevision: domain.agentAuthorizationRevision,
      }));
      secret.push(Object.freeze({
        domainId: domain.domainId,
        aiRoot: copyOwnedBytesV2(domain.aiRoot),
      }));
    }
    // The canonical secret serializer owns the exact nonempty/count/byte
    // bounds. Its validation buffer is itself secret-bearing.
    const validationBytes = serializeGrantSecretV2(secret);
    validationBytes.fill(0);
    return {
      coveredDomains: Object.freeze(coveredDomains),
      secret: Object.freeze(secret),
    };
  } catch (error) {
    secret.forEach((entry) => entry.aiRoot.fill(0));
    throw error;
  }
}

export async function mintGrantV2(
  crypto: LatticeCrypto,
  input: MintGrantV2Input,
): Promise<GrantV2> {
  grantId(input.id);
  cryptoDeviceId(input.issuingDeviceId);
  humanId(input.issuingHumanId);
  agentId(input.recipientAgentId);
  if (
    !isCanonicalParticipants(input.scope)
    || !input.scope.includes(input.issuingHumanId)
  ) {
    throw new RangeError(
      "Grant scope must be canonical and contain the issuing Human",
    );
  }
  const { coveredDomains, secret } = validateMintDomains(
    input.coveredDomains,
  );
  const signingPrivateKey = copyOwnedBytesV2(
    input.issuingDeviceSigningPrivateKey,
  );
  const unsignedCoordinates = Object.freeze({
    formatVersion: GRANT_V2_FORMAT_VERSION,
    id: input.id,
    issuingDeviceId: input.issuingDeviceId,
    recipientAgentId: input.recipientAgentId,
    recipientKeyId: input.recipientKeyId,
    scope: Object.freeze([...input.scope]),
    operations: Object.freeze([...input.operations]),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    coveredDomains,
    scheme: GRANT_V2_SCHEME,
    singleUse: input.singleUse,
  });
  let plaintext: Uint8Array<ArrayBufferLike> = new Uint8Array();
  try {
    plaintext = serializeGrantSecretV2(secret);
    const encryptedSecret = await crypto.sealTo(
      input.recipientEncryptionPublicKey,
      plaintext,
    );
    const unsigned = {
      ...unsignedCoordinates,
      encryptedSecret,
    } as const;
    const signature = crypto.sign(
      signingPrivateKey,
      grantV2SigningBytes(unsigned),
    );
    return Object.freeze({
      ...unsigned,
      encryptedSecret: copyOwnedBytesV2(encryptedSecret),
      signature: copyOwnedBytesV2(signature),
      consumed: false,
    });
  } finally {
    signingPrivateKey.fill(0);
    plaintext.fill(0);
    secret.forEach((entry) => entry.aiRoot.fill(0));
  }
}

function validateAuthorization(
  authorization: GrantOperationAuthorizationV2,
): boolean {
  cryptoDeviceId(authorization.expectedIssuingDeviceId);
  humanId(authorization.issuingDeviceHumanId);
  agentId(authorization.recipientAgentId);
  namespaceId(authorization.namespaceId);
  accessRevision(authorization.namespaceAccessRevision);
  cryptoDomainId(authorization.domainId);
  domainEpoch(authorization.domainEpoch);
  authorizationRevision(authorization.agentAuthorizationRevision);
  return (
    Number.isSafeInteger(authorization.now)
    && authorization.issuingDeviceActive
    && authorization.hostAllowsOperation
    && typeof authorization.singleUseAvailable === "boolean"
    && isCanonicalParticipants(authorization.namespaceParticipants)
  );
}

function snapshotGrantOperationAuthorization(
  authorization: GrantOperationAuthorizationV2,
): GrantOperationAuthorizationV2 {
  if (
    !Array.isArray(authorization.namespaceParticipants as unknown)
  ) {
    throw new TypeError();
  }
  // copyOwnedBytesV2 performs the stronger genuine-Uint8Array internal-slot
  // check while detaching both keys. A preceding instanceof check would be
  // redundant and weaker against prototype-forged lookalikes.
  return Object.freeze({
    now: authorization.now,
    expectedIssuingDeviceId:
      cryptoDeviceId(authorization.expectedIssuingDeviceId),
    issuingDeviceHumanId: humanId(authorization.issuingDeviceHumanId),
    issuingDeviceSigningPublicKey:
      copyOwnedBytesV2(
        authorization.issuingDeviceSigningPublicKey,
      ),
    issuingDeviceActive: authorization.issuingDeviceActive,
    recipientAgentId: agentId(authorization.recipientAgentId),
    recipientKeyId: authorization.recipientKeyId,
    recipientEncryptionPrivateKey:
      copyOwnedBytesV2(
        authorization.recipientEncryptionPrivateKey,
      ),
    operation: authorization.operation,
    singleUseAvailable: authorization.singleUseAvailable,
    namespaceId: namespaceId(authorization.namespaceId),
    namespaceAccessRevision:
      accessRevision(authorization.namespaceAccessRevision),
    namespaceParticipants: Object.freeze(
      authorization.namespaceParticipants.map(humanId),
    ),
    domainId: cryptoDomainId(authorization.domainId),
    domainEpoch: domainEpoch(authorization.domainEpoch),
    agentAuthorizationRevision:
      authorizationRevision(authorization.agentAuthorizationRevision),
    hostAllowsOperation: authorization.hostAllowsOperation,
  });
}

function secretMatchesCoveredDomains(
  secret: readonly GrantSecretDomainRootV2[],
  covered: readonly GrantCoveredDomainV2[],
): boolean {
  return (
    secret.length === covered.length
    && secret.every(
      (entry, index) => entry.domainId === covered[index]!.domainId,
    )
  );
}

/**
 * Internal primitive that verifies and opens one Domain root for one live
 * Namespace operation.
 *
 * This direct root-releasing primitive is deliberately absent from the
 * supported package root. Supported callers must use `preflightGrantUseV2`
 * plus `coordinateGrantUseV2`, which keeps the root private until after an
 * exact atomic single-use claim. It remains exported only for this module's
 * focused characterization tests and the adjacent coordinator.
 *
 * @internal
 */
export async function openGrantV2ForOperation(
  crypto: LatticeCrypto,
  grant: GrantV2,
  authorization: GrantOperationAuthorizationV2,
): Promise<OpenedGrantDomainV2 | null> {
  let current: GrantOperationAuthorizationV2;
  try {
    current = snapshotGrantOperationAuthorization(authorization);
  } catch {
    return null;
  }
  try {
  let covered: GrantCoveredDomainV2 | undefined;
  try {
    if (
      !validateAuthorization(current)
      || grant.consumed
      || (grant.singleUse && !current.singleUseAvailable)
      || grant.issuingDeviceId !== current.expectedIssuingDeviceId
      || !grant.scope.includes(current.issuingDeviceHumanId)
      || grant.recipientAgentId !== current.recipientAgentId
      || grant.recipientKeyId !== current.recipientKeyId
      || !grant.operations.includes(current.operation)
      || current.now < grant.issuedAt
      || current.now >= grant.expiresAt
      || !isSubset(grant.scope, current.namespaceParticipants)
      || !crypto.verify(
        current.issuingDeviceSigningPublicKey,
        grantV2SigningBytes(grant),
        grant.signature,
      )
    ) {
      return null;
    }

    covered = grant.coveredDomains.find(
      (entry) => entry.domainId === current.domainId,
    );
    if (
      !covered
      || covered.domainEpoch !== current.domainEpoch
      || covered.agentAuthorizationRevision
        !== current.agentAuthorizationRevision
    ) {
      return null;
    }
  } catch {
    return null;
  }

  let plaintext: Uint8Array<ArrayBufferLike>;
  try {
    plaintext = (
      await crypto.openSealed(
        current.recipientEncryptionPrivateKey,
        grant.encryptedSecret,
      )
    ) ?? new Uint8Array();
  } catch {
    return null;
  }

  const secret = parseGrantSecretV2(plaintext);
  if (secret === null) {
    plaintext.fill(0);
    return null;
  }
  try {
    if (!secretMatchesCoveredDomains(secret, grant.coveredDomains)) {
      return null;
    }
    const root = secret.find(
      (entry) => entry.domainId === current.domainId,
    )!;
    return Object.freeze({
      grantId: grant.id,
      namespaceId: current.namespaceId,
      namespaceAccessRevision: current.namespaceAccessRevision,
      domainId: covered.domainId,
      domainEpoch: covered.domainEpoch,
      agentAuthorizationRevision: covered.agentAuthorizationRevision,
      aiRoot: copyOwnedBytesV2(root.aiRoot),
    });
  } finally {
    plaintext.fill(0);
    secret.forEach((entry) => entry.aiRoot.fill(0));
  }
  } finally {
    current.recipientEncryptionPrivateKey.fill(0);
  }
}
