import {
  ApiError,
  type DomainKeyAuthorityPlanResponseV2,
  type NautiloApiClient,
} from "@nautilo/api-client/browser";
import {
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  generateDomainKey,
  humanId,
  openDomainKeyRecipientEnvelope,
  prepareDomainKeyAccessRequest,
  prepareDomainKeyAcknowledgement,
  prepareDomainKeyHead,
  prepareDomainKeyRecipientAuthorization,
  prepareDomainKeyRecipientEnvelope,
  unixTimestamp,
  verifyDomainKeyAccessRequest,
  verifyDomainKeyHead,
  type DomainKeyClass,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_KEY_ACCESS_REQUEST_PURPOSE_V2,
  DOMAIN_KEY_ACKNOWLEDGEMENT_PURPOSE_V2,
  DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2,
  destroyDomainKeyAccessRequestV2,
  destroyDomainKeyAcknowledgementV2,
  destroyDomainKeyHeadV2,
  destroyDomainKeyRecipientAuthorizationV2,
  destroyDomainKeyRecipientEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import type {
  ClientDomainKeyCacheRequirementV2,
  ClientDomainKeyCacheVaultV2,
} from "../../client-vault/domain-key-cache-v2.ts";

type Api = Pick<
  NautiloApiClient,
  | "planDomainKeyAuthorityV2"
  | "publishDomainKeyAuthorityV2"
  | "requestDomainKeyRecipientV2"
  | "listPendingDomainKeyRequestsV2"
  | "fulfilDomainKeyRecipientV2"
  | "fetchDomainKeyEnvelopeV2"
  | "acknowledgeDomainKeyEnvelopeV2"
  | "planDomainNamespaceBundleV2"
  | "publishDomainNamespaceBundleV2"
> & Partial<Pick<NautiloApiClient, "listPendingDomainKeySourceWorkV2">>;

export type DomainKeyAccessDiagnosticV2 = Readonly<{
  stage:
    | "plan"
    | "head_publish"
    | "cache"
    | "envelope_open"
    | "request"
    | "fulfil"
    | "acknowledge";
  reason: string;
}>;

export type EnsureDomainKeyAccessResultV2 =
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "pending"; reason: "source_required" }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export type OpenedDomainKeyAuthorityV2 = Readonly<{
  serverId: string;
  domainId: string;
  participantDigest: Uint8Array;
  participantCount: number;
  keyClass: DomainKeyClass;
  domainKeyGeneration: number;
  authorizationRevision: number;
  headDigest: Uint8Array;
  recipientDeviceSigningGeneration: number;
}>;

type DomainAccessRequestV2 = Readonly<{
  sourceRoomId: string;
  namespaceId: string;
  keyClass: DomainKeyClass;
  signal?: AbortSignal;
}>;

export interface DomainKeyAuthorityClientV2 {
  ensure(input: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    keyClass: DomainKeyClass;
    signal?: AbortSignal;
  }>): Promise<EnsureDomainKeyAccessResultV2>;
  withDomainKey<Value>(input: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    keyClass: DomainKeyClass;
    signal?: AbortSignal;
  }>, use: (
    domainKey: Uint8Array,
    authority: OpenedDomainKeyAuthorityV2,
  ) => Value | Promise<Value>): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "pending" | "unavailable"; reason: string }>
  >;
  servicePending(input: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    keyClass: DomainKeyClass;
    signal?: AbortSignal;
  }>): Promise<Readonly<{ status: "ready"; fulfilled: number }> | Readonly<{
    status: "unavailable";
    reason: string;
  }>>;
  serviceBacklog?(): Promise<Readonly<{
    status: "ready";
    coordinates: number;
    fulfilled: number;
  }> | Readonly<{
    status: "unavailable";
    reason: string;
  }>>;
  recover?(input: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    keyClass: DomainKeyClass;
  }>, credential: Readonly<{
    keyId: string;
    generation: number;
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  }>): Promise<EnsureDomainKeyAccessResultV2>;
}

function toBase64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const bytes = Uint8Array.from(
    atob(padded),
    (character) => character.charCodeAt(0),
  );
  if (bytes.length === 0 || toBase64url(bytes) !== value) {
    bytes.fill(0);
    throw new TypeError("Domain authority bytes are noncanonical");
  }
  return bytes;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function wipe(values: readonly (Uint8Array | null | undefined)[]): void {
  values.forEach((value) => value?.fill(0));
}

function requirement(
  serverId: string,
  plan: Extract<DomainKeyAuthorityPlanResponseV2, { status: "ready" }>,
): ClientDomainKeyCacheRequirementV2 {
  return Object.freeze({
    serverId,
    domainId: plan.domainId,
    participantDigest: fromBase64url(plan.participantDigestBase64url),
    participantCount: plan.participantCount,
    keyClass: plan.keyClass,
    domainKeyGeneration: plan.domainKeyGeneration,
    authorizationRevision: plan.authorizationRevision,
    headDigest: fromBase64url(plan.headDigestBase64url),
    recipientDeviceGeneration: plan.recipientDeviceSigningGeneration,
  });
}

function destroyRequirement(value: ClientDomainKeyCacheRequirementV2): void {
  value.participantDigest.fill(0);
  value.headDigest.fill(0);
}

export function createDomainKeyAuthorityClientV2(input: Readonly<{
  api: Api;
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  cache: ClientDomainKeyCacheVaultV2;
  coordinates: ClientProfileCoordinates;
  serverId: string;
  now: () => number;
  createId: () => string;
  scheduleRetry?: (
    retry: () => Promise<void>,
    delayMs: number,
  ) => void;
  onBacklogCoordinate?: (request: DomainAccessRequestV2) => Promise<void>;
  onDiagnostic?: (diagnostic: DomainKeyAccessDiagnosticV2) => void;
}>): DomainKeyAuthorityClientV2 {
  const ensureCacheAvailable = async (): Promise<boolean> => {
    try {
      const available = await input.cache.availability();
      return available.status === "available"
        || (await input.cache.unlock()).status === "available";
    } catch {
      return false;
    }
  };
  const unavailable = (
    stage: DomainKeyAccessDiagnosticV2["stage"],
    reason: string,
  ) => {
    input.onDiagnostic?.(Object.freeze({ stage, reason }));
    return Object.freeze({ status: "unavailable" as const, reason });
  };
  const headRequestFailureReason = (error: unknown): string => {
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) {
        return "head_authorization_denied";
      }
      return "head_request_rejected";
    }
    if (
      error instanceof TypeError
      || (error instanceof Error && error.name === "ZodError")
    ) {
      return "head_response_invalid";
    }
    return "head_request_failed";
  };
  const scheduledRetries = new Set<string>();
  let backlogRetryScheduled = false;
  let backlogRetryAttempt = 0;
  const scheduleBacklogRetry = (): void => {
    if (
      backlogRetryScheduled
      || backlogRetryAttempt >= 120
      || input.scheduleRetry === undefined
    ) return;
    backlogRetryScheduled = true;
    backlogRetryAttempt += 1;
    input.scheduleRetry(async () => {
      backlogRetryScheduled = false;
      await client.serviceBacklog?.();
    }, 1_000);
  };
  const schedulePendingRetry = (
    request: DomainAccessRequestV2,
    attempt = 1,
  ): void => {
    if (input.scheduleRetry === undefined || attempt > 120) return;
    const key = [
      request.sourceRoomId,
      request.namespaceId,
      request.keyClass,
    ].join("\0");
    if (scheduledRetries.has(key)) return;
    scheduledRetries.add(key);
    input.scheduleRetry(async () => {
      let retried: EnsureDomainKeyAccessResultV2;
      try {
        retried = await client.ensure(request);
      } catch {
        // An ordinary foreground action will restart the bounded retry loop.
        scheduledRetries.delete(key);
        return;
      }
      scheduledRetries.delete(key);
      if (retried.status === "pending") {
        schedulePendingRetry(request, attempt + 1);
      }
    }, 5_000);
  };
  const withProfile = async <Value>(use: (profile: Awaited<
    ReturnType<typeof authenticateClientDeviceProfileV4>
  >) => Value | Promise<Value>): Promise<Value | null> => {
    const available = await input.vault.availability();
    if (
      available.status !== "available"
      && (await input.vault.unlock()).status !== "available"
    ) return null;
    return input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
      let profile;
      try {
        profile = await authenticateClientDeviceProfileV4({
          crypto: input.crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
      } catch {
        return null;
      }
      try {
        return await use(profile);
      } finally {
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });
  };

  const plan = (
    request: DomainAccessRequestV2,
  ) => input.api.planDomainKeyAuthorityV2(
    request.sourceRoomId,
    request.namespaceId,
    {
      requestVersion: 2,
      serverId: input.serverId,
      clientDeviceId: input.coordinates.deviceId,
      keyClass: request.keyClass,
    },
    request.signal === undefined ? undefined : {signal: request.signal},
  );

  const createHead = async (
    request: DomainAccessRequestV2,
    current: Extract<
      DomainKeyAuthorityPlanResponseV2,
      { status: "create_required" }
    >,
  ): Promise<boolean> => {
    const domainKey = generateDomainKey(input.crypto);
    const participantDigest = fromBase64url(
      current.participantDigestBase64url,
    );
    const devicePublicKey = fromBase64url(
      current.recipientEncryptionPublicKeyBase64url,
    );
    const devicePublicKeyDigest = fromBase64url(
      current.recipientPublicKeyDigestBase64url,
    );
    const recoveryPublicKey = fromBase64url(
      current.recoveryPublicKeyBase64url,
    );
    const recoveryPublicKeyDigest = fromBase64url(
      current.recoveryPublicKeyDigestBase64url,
    );
    const issuerSigningPublicKey = fromBase64url(
      current.issuerSigningPublicKeyBase64url,
    );
    const previousHeadDigest = current.previousHeadDigestBase64url === null
      ? null
      : fromBase64url(current.previousHeadDigestBase64url);
    try {
      const published = await withProfile(async (profile) => {
        const base = profile.baseProfile.baseProfile;
        if (
          base.deviceId !== current.issuerDeviceId
          || !sameBytes(base.signingPublicKey, issuerSigningPublicKey)
        ) return false;
        const operationId = input.createId();
        const idempotencyKey = input.createId();
        const head = prepareDomainKeyHead(input.crypto, {
          serverId: input.serverId,
          cryptoDomainId: cryptoDomainId(current.domainId),
          participantDigest,
          participantCount: current.participantCount,
          keyClass: current.keyClass,
          domainKeyGeneration: current.domainKeyGeneration,
          authorizationRevision: authorizationRevision(
            current.authorizationRevision,
          ),
          previousHeadDigest,
          publicationOperationId: operationId,
          issuerHumanId: humanId(current.issuerHumanId),
          issuerDeviceId: cryptoDeviceId(current.issuerDeviceId),
          issuerDeviceSigningGeneration:
            current.issuerDeviceSigningGeneration,
          issuedAt: current.issuedAt,
          deadlineAt: current.deadlineAt,
          issuerSigningPublicKey: base.signingPublicKey,
          issuerSigningPrivateKey: base.signingPrivateKey,
        });
        try {
          const deviceEnvelope = await prepareDomainKeyRecipientEnvelope(
            input.crypto,
            {
              head: head.head,
              headDigest: head.digest,
              recipient: {
                recipientHumanId: humanId(current.issuerHumanId),
                recipientKind: "device",
                recipientKeyId: current.issuerDeviceId,
                recipientKeyGeneration:
                  current.issuerDeviceSigningGeneration,
                recipientPublicKey: devicePublicKey,
                recipientPublicKeyDigest: devicePublicKeyDigest,
              },
              domainKey,
              issuerHumanId: humanId(current.issuerHumanId),
              issuerDeviceId: cryptoDeviceId(current.issuerDeviceId),
              issuerDeviceSigningGeneration:
                current.issuerDeviceSigningGeneration,
              issuerSigningPublicKey: base.signingPublicKey,
              issuerSigningPrivateKey: base.signingPrivateKey,
            },
          );
          try {
            const recoveryEnvelope = await prepareDomainKeyRecipientEnvelope(
              input.crypto,
              {
                head: head.head,
                headDigest: head.digest,
                recipient: {
                  recipientHumanId: humanId(current.issuerHumanId),
                  recipientKind: "recovery",
                  recipientKeyId: current.recoveryKeyId,
                  recipientKeyGeneration: current.recoveryKeyGeneration,
                  recipientPublicKey: recoveryPublicKey,
                  recipientPublicKeyDigest: recoveryPublicKeyDigest,
                },
                domainKey,
                issuerHumanId: humanId(current.issuerHumanId),
                issuerDeviceId: cryptoDeviceId(current.issuerDeviceId),
                issuerDeviceSigningGeneration:
                  current.issuerDeviceSigningGeneration,
                issuerSigningPublicKey: base.signingPublicKey,
                issuerSigningPrivateKey: base.signingPrivateKey,
              },
            );
            try {
              const deviceAuthorization =
                prepareDomainKeyRecipientAuthorization(
                  input.crypto,
                  {
                    authorizationOperationId: operationId,
                    reason: "head_establishment",
                    requestDigest: null,
                    envelopeBytes: deviceEnvelope.bytes,
                    envelopeDigest: deviceEnvelope.digest,
                    issuerHumanId: humanId(current.issuerHumanId),
                    issuerDeviceId: cryptoDeviceId(current.issuerDeviceId),
                    issuerDeviceSigningGeneration:
                      current.issuerDeviceSigningGeneration,
                    issuedAt: current.issuedAt,
                    deadlineAt: current.deadlineAt,
                    issuerSigningPublicKey: base.signingPublicKey,
                    issuerSigningPrivateKey: base.signingPrivateKey,
                  },
                );
              try {
                const recoveryAuthorization =
                  prepareDomainKeyRecipientAuthorization(
                    input.crypto,
                    {
                      authorizationOperationId: operationId,
                      reason: "head_establishment",
                      requestDigest: null,
                      envelopeBytes: recoveryEnvelope.bytes,
                      envelopeDigest: recoveryEnvelope.digest,
                      issuerHumanId: humanId(current.issuerHumanId),
                      issuerDeviceId: cryptoDeviceId(current.issuerDeviceId),
                      issuerDeviceSigningGeneration:
                        current.issuerDeviceSigningGeneration,
                      issuedAt: current.issuedAt,
                      deadlineAt: current.deadlineAt,
                      issuerSigningPublicKey: base.signingPublicKey,
                      issuerSigningPrivateKey: base.signingPrivateKey,
                    },
                  );
                try {
                  const response = await input.api.publishDomainKeyAuthorityV2(
                    request.sourceRoomId,
                    request.namespaceId,
                    {
                      requestVersion: 2,
                      serverId: input.serverId,
                      clientDeviceId: base.deviceId,
                      keyClass: request.keyClass,
                      operationId,
                      idempotencyKey,
                      headBytesBase64url: toBase64url(head.bytes),
                      envelopeBytesBase64url:
                        toBase64url(deviceEnvelope.bytes),
                      authorizationBytesBase64url:
                        toBase64url(deviceAuthorization.bytes),
                      recoveryEnvelopeBytesBase64url:
                        toBase64url(recoveryEnvelope.bytes),
                      recoveryAuthorizationBytesBase64url:
                        toBase64url(recoveryAuthorization.bytes),
                    },
                    request.signal === undefined
                      ? undefined
                      : {signal: request.signal},
                  );
                  if (
                    response.domainId !== current.domainId
                    || response.keyClass !== request.keyClass
                    || response.operationId !== operationId
                  ) return false;
                  const publishedHeadDigest = fromBase64url(
                    response.headDigestBase64url,
                  );
                  const publishedDeviceEnvelopeDigest = fromBase64url(
                    response.envelopeDigestBase64url,
                  );
                  const publishedRecoveryEnvelopeDigest = fromBase64url(
                    response.recoveryEnvelopeDigestBase64url,
                  );
                  try {
                    if (
                      !sameBytes(publishedHeadDigest, head.digest)
                      || !sameBytes(
                        publishedDeviceEnvelopeDigest,
                        deviceEnvelope.digest,
                      )
                      || !sameBytes(
                        publishedRecoveryEnvelopeDigest,
                        recoveryEnvelope.digest,
                      )
                    ) return false;
                    await input.cache.putKey(input.coordinates, {
                      serverId: input.serverId,
                      domainId: response.domainId,
                      participantDigest,
                      participantCount: current.participantCount,
                      keyClass: response.keyClass,
                      domainKeyGeneration: response.domainKeyGeneration,
                      authorizationRevision: response.authorizationRevision,
                      headDigest: publishedHeadDigest,
                      recipientDeviceGeneration:
                        current.issuerDeviceSigningGeneration,
                      domainKey,
                    });
                  } finally {
                    wipe([
                      publishedHeadDigest,
                      publishedDeviceEnvelopeDigest,
                      publishedRecoveryEnvelopeDigest,
                    ]);
                  }
                  return true;
                } finally {
                  destroyDomainKeyRecipientAuthorizationV2(
                    recoveryAuthorization.authorization,
                  );
                  wipe([
                    recoveryAuthorization.bytes,
                    recoveryAuthorization.digest,
                  ]);
                }
              } finally {
                destroyDomainKeyRecipientAuthorizationV2(
                  deviceAuthorization.authorization,
                );
                wipe([deviceAuthorization.bytes, deviceAuthorization.digest]);
              }
            } finally {
              destroyDomainKeyRecipientEnvelopeV2(recoveryEnvelope.envelope);
              wipe([recoveryEnvelope.bytes, recoveryEnvelope.digest]);
            }
          } finally {
            destroyDomainKeyRecipientEnvelopeV2(deviceEnvelope.envelope);
            wipe([deviceEnvelope.bytes, deviceEnvelope.digest]);
          }
        } finally {
          destroyDomainKeyHeadV2(head.head);
          wipe([head.bytes, head.digest]);
        }
      });
      return published === true;
    } finally {
      wipe([
        domainKey,
        participantDigest,
        devicePublicKey,
        devicePublicKeyDigest,
        recoveryPublicKey,
        recoveryPublicKeyDigest,
        issuerSigningPublicKey,
        previousHeadDigest,
      ]);
    }
  };

  const openFetchedEnvelope = async (
    request: DomainAccessRequestV2,
    current: Extract<DomainKeyAuthorityPlanResponseV2, { status: "ready" }>,
  ): Promise<"ready" | "pending" | "unavailable"> => {
    const fetched = await input.api.fetchDomainKeyEnvelopeV2(
      request.sourceRoomId,
      request.namespaceId,
      {
        requestVersion: 2,
        serverId: input.serverId,
        clientDeviceId: input.coordinates.deviceId,
        keyClass: request.keyClass,
      },
      request.signal === undefined ? undefined : {signal: request.signal},
    );
    if (fetched.status !== "ready") return fetched.status;
    const envelopeBytes = fromBase64url(fetched.envelopeBytesBase64url);
    const envelopeDigest = fromBase64url(fetched.envelopeDigestBase64url);
    const issuerSigningPublicKey = fromBase64url(
      fetched.issuerSigningPublicKeyBase64url,
    );
    const requestDigest = fetched.requestDigestBase64url === null
      ? null
      : fromBase64url(fetched.requestDigestBase64url);
    try {
      const opened = await withProfile(async (profile) => {
        const base = profile.baseProfile.baseProfile;
        const value = await openDomainKeyRecipientEnvelope(input.crypto, {
          envelopeBytes,
          expectedEnvelopeDigest: envelopeDigest,
          issuerSigningPublicKey,
          recipientHumanId: humanId(input.coordinates.humanActorId),
          recipientKind: "device",
          recipientKeyId: input.coordinates.deviceId,
          recipientKeyGeneration: current.recipientDeviceSigningGeneration,
          recipientPrivateKey: base.encryptionPrivateKey,
        });
        if (value === null) return false;
        const cacheRequirement = requirement(input.serverId, current);
        try {
          await input.cache.putKey(input.coordinates, {
            ...cacheRequirement,
            domainKey: value.domainKey,
          });
          if (requestDigest !== null) {
            const now = input.now();
            const recipientPublicKeyDigest = input.crypto.hash(
              base.encryptionPublicKey,
            );
            const acknowledgement = prepareDomainKeyAcknowledgement(
              input.crypto,
              {
                formatVersion: DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2,
                purpose: DOMAIN_KEY_ACKNOWLEDGEMENT_PURPOSE_V2,
                acknowledgementId: input.createId(),
                serverId: input.serverId,
                humanId: humanId(input.coordinates.humanActorId),
                deviceId: cryptoDeviceId(input.coordinates.deviceId),
                deviceSigningKeyGeneration:
                  current.recipientDeviceSigningGeneration,
                cryptoDomainId: cryptoDomainId(current.domainId),
                participantDigest: cacheRequirement.participantDigest,
                participantCount: cacheRequirement.participantCount,
                keyClass: current.keyClass,
                domainKeyGeneration: current.domainKeyGeneration,
                authorizationRevision: authorizationRevision(
                  current.authorizationRevision,
                ),
                headDigest: cacheRequirement.headDigest,
                recipientKeyId: input.coordinates.deviceId,
                recipientKeyGeneration:
                  current.recipientDeviceSigningGeneration,
                recipientPublicKeyDigest,
                requestDigest,
                envelopeDigest,
                processedDeviceRevision: current.recipientDeviceRevision,
                issuedAt: unixTimestamp(now),
                expiresAt: unixTimestamp(now + 30_000),
                signingPrivateKey: base.signingPrivateKey,
              },
            );
            try {
              await input.api.acknowledgeDomainKeyEnvelopeV2(
                request.sourceRoomId,
                request.namespaceId,
                {
                  requestVersion: 2,
                  serverId: input.serverId,
                  clientDeviceId: input.coordinates.deviceId,
                  keyClass: request.keyClass,
                  acknowledgementBytesBase64url:
                    toBase64url(acknowledgement.bytes),
                },
                request.signal === undefined
                  ? undefined
                  : {signal: request.signal},
              );
            } finally {
              destroyDomainKeyAcknowledgementV2(acknowledgement.value);
              wipe([acknowledgement.bytes, acknowledgement.digest]);
              recipientPublicKeyDigest.fill(0);
            }
          }
          return true;
        } finally {
          destroyRequirement(cacheRequirement);
          destroyDomainKeyRecipientEnvelopeV2(value.envelope);
          wipe([value.envelopeDigest, value.domainKey]);
        }
      });
      return opened === true ? "ready" : "unavailable";
    } finally {
      wipe([
        envelopeBytes,
        envelopeDigest,
        issuerSigningPublicKey,
        requestDigest,
      ]);
    }
  };

  const requestRecipient = async (
    request: DomainAccessRequestV2,
    current: Extract<DomainKeyAuthorityPlanResponseV2, { status: "ready" }>,
  ): Promise<boolean> => {
    const cacheRequirement = requirement(input.serverId, current);
    try {
      const result = await withProfile(async (profile) => {
        const base = profile.baseProfile.baseProfile;
        const now = input.now();
        const requestId = input.createId();
        const recipientPublicKeyDigest = input.crypto.hash(
          base.encryptionPublicKey,
        );
        try {
          const prepared = prepareDomainKeyAccessRequest(input.crypto, {
            formatVersion: DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2,
            purpose: DOMAIN_KEY_ACCESS_REQUEST_PURPOSE_V2,
            requestId,
            serverId: input.serverId,
            humanId: humanId(input.coordinates.humanActorId),
            deviceId: cryptoDeviceId(input.coordinates.deviceId),
            deviceSigningKeyGeneration:
              current.recipientDeviceSigningGeneration,
            cryptoDomainId: cryptoDomainId(current.domainId),
            participantDigest: cacheRequirement.participantDigest,
            participantCount: cacheRequirement.participantCount,
            keyClass: request.keyClass,
            domainKeyGeneration: current.domainKeyGeneration,
            authorizationRevision: authorizationRevision(
              current.authorizationRevision,
            ),
            headDigest: cacheRequirement.headDigest,
            recipientKeyId: input.coordinates.deviceId,
            recipientKeyGeneration:
              current.recipientDeviceSigningGeneration,
            recipientPublicKeyDigest,
            issuedAt: unixTimestamp(now),
            expiresAt: unixTimestamp(now + 30_000),
            signingPrivateKey: base.signingPrivateKey,
          });
          try {
            await input.api.requestDomainKeyRecipientV2(
              request.sourceRoomId,
              request.namespaceId,
              {
                requestVersion: 2,
                serverId: input.serverId,
                clientDeviceId: input.coordinates.deviceId,
                keyClass: request.keyClass,
                requestId,
                idempotencyKey: input.createId(),
                requestBytesBase64url: toBase64url(prepared.bytes),
              },
              request.signal === undefined
                ? undefined
                : {signal: request.signal},
            );
            return true;
          } finally {
            destroyDomainKeyAccessRequestV2(prepared.value);
            wipe([prepared.bytes, prepared.digest]);
          }
        } finally {
          recipientPublicKeyDigest.fill(0);
        }
      });
      return result === true;
    } finally {
      destroyRequirement(cacheRequirement);
    }
  };

  const client: DomainKeyAuthorityClientV2 = Object.freeze({
    async ensure(
      request: DomainAccessRequestV2,
    ): Promise<EnsureDomainKeyAccessResultV2> {
      if (!await ensureCacheAvailable()) {
        return unavailable("cache", "custody_unavailable");
      }
      let current: DomainKeyAuthorityPlanResponseV2;
      try {
        current = await plan(request);
      } catch {
        return unavailable("plan", "request_failed");
      }
      if (current.status === "unavailable") {
        return unavailable("plan", current.reason);
      }
      if (current.status === "create_required") {
        try {
          return await createHead(request, current)
            ? Object.freeze({ status: "ready" as const })
            : unavailable("head_publish", "publication_failed");
        } catch {
          return unavailable("head_publish", "publication_failed");
        }
      }
      const cacheRequirement = requirement(input.serverId, current);
      try {
        const cached = await input.cache.withKey(
          input.coordinates,
          cacheRequirement,
          () => true,
        );
        if (cached.status === "hit") return Object.freeze({ status: "ready" as const });
      } catch {
        return unavailable("cache", "custody_unavailable");
      } finally {
        destroyRequirement(cacheRequirement);
      }
      try {
        const opened = await openFetchedEnvelope(request, current);
        if (opened === "ready") return Object.freeze({ status: "ready" as const });
        if (opened === "pending") {
          schedulePendingRetry(request);
          return Object.freeze({
            status: "pending" as const,
            reason: "source_required" as const,
          });
        }
        if (!await requestRecipient(request, current)) {
          return unavailable("request", "request_failed");
        }
        schedulePendingRetry(request);
        return Object.freeze({
          status: "pending" as const,
          reason: "source_required" as const,
        });
      } catch {
        return unavailable("envelope_open", "envelope_unavailable");
      }
    },

    async withDomainKey<Value>(
      request: DomainAccessRequestV2,
      use: (
        domainKey: Uint8Array,
        authority: OpenedDomainKeyAuthorityV2,
      ) => Value | Promise<Value>,
    ): Promise<
      | Readonly<{ status: "opened"; value: Value }>
      | Readonly<{ status: "pending" | "unavailable"; reason: string }>
    > {
      const ensured = await client.ensure(request);
      if (ensured.status !== "ready") return ensured;
      const current = await plan(request);
      if (current.status !== "ready") {
        return Object.freeze({ status: "unavailable" as const, reason: "head_changed" });
      }
      const cacheRequirement = requirement(input.serverId, current);
      try {
        const opened = await input.cache.withKey(
          input.coordinates,
          cacheRequirement,
          async (domainKey) => {
            const authority = Object.freeze({
              serverId: cacheRequirement.serverId,
              domainId: cacheRequirement.domainId,
              participantDigest: cacheRequirement.participantDigest.slice(),
              participantCount: cacheRequirement.participantCount,
              keyClass: cacheRequirement.keyClass,
              domainKeyGeneration: cacheRequirement.domainKeyGeneration,
              authorizationRevision: cacheRequirement.authorizationRevision,
              headDigest: cacheRequirement.headDigest.slice(),
              recipientDeviceSigningGeneration:
                cacheRequirement.recipientDeviceGeneration,
            });
            try {
              return await use(domainKey, authority);
            } finally {
              authority.participantDigest.fill(0);
              authority.headDigest.fill(0);
            }
          },
        );
        return opened.status === "hit"
          ? Object.freeze({ status: "opened" as const, value: opened.value })
          : Object.freeze({ status: "unavailable" as const, reason: "cache_miss" });
      } finally {
        destroyRequirement(cacheRequirement);
      }
    },

    async servicePending(
      request: DomainAccessRequestV2,
    ): Promise<Readonly<{ status: "ready"; fulfilled: number }> | Readonly<{
      status: "unavailable";
      reason: string;
    }>> {
      if (!await ensureCacheAvailable()) {
        return unavailable("fulfil", "source_key_unavailable");
      }
      let current;
      let cacheRequirement: ClientDomainKeyCacheRequirementV2;
      try {
        current = await plan(request);
        if (current.status !== "ready") {
          return unavailable("fulfil", "head_unavailable");
        }
        cacheRequirement = requirement(input.serverId, current);
      } catch (error: unknown) {
        return unavailable("fulfil", headRequestFailureReason(error));
      }
      try {
        const serviced = await input.cache.withKey(
          input.coordinates,
          cacheRequirement,
          async (domainKey) => withProfile(async (profile) => {
            const base = profile.baseProfile.baseProfile;
            const headBytes = fromBase64url(current.headBytesBase64url);
            const issuerSigningPublicKey = fromBase64url(
              current.issuerSigningPublicKeyBase64url,
            );
            const head = verifyDomainKeyHead(input.crypto, {
              headBytes,
              issuerSigningPublicKey,
              expectedHeadDigest: cacheRequirement.headDigest,
            });
            if (
              head === null
              || head.serverId !== input.serverId
              || head.cryptoDomainId !== current.domainId
              || !sameBytes(
                head.participantDigest,
                cacheRequirement.participantDigest,
              )
              || head.participantCount !== current.participantCount
              || head.keyClass !== current.keyClass
              || head.domainKeyGeneration !== current.domainKeyGeneration
              || head.authorizationRevision !== current.authorizationRevision
            ) {
              headBytes.fill(0);
              issuerSigningPublicKey.fill(0);
              if (head !== null) destroyDomainKeyHeadV2(head);
              return null;
            }
            try {
              const pending = await input.api.listPendingDomainKeyRequestsV2(
                request.sourceRoomId,
                request.namespaceId,
                {
                  requestVersion: 2,
                  serverId: input.serverId,
                  clientDeviceId: input.coordinates.deviceId,
                  keyClass: request.keyClass,
                  limit: 8,
                },
                request.signal === undefined
                  ? undefined
                  : {signal: request.signal},
              );
              let fulfilled = 0;
              for (const target of pending.requests) {
                const requestBytes = fromBase64url(
                  target.requestBytesBase64url,
                );
                const requestDigest = fromBase64url(
                  target.requestDigestBase64url,
                );
                const targetSigningPublicKey = fromBase64url(
                  target.recipientSigningPublicKeyBase64url,
                );
                const targetEncryptionPublicKey = fromBase64url(
                  target.recipientEncryptionPublicKeyBase64url,
                );
                const targetPublicKeyDigest = fromBase64url(
                  target.recipientPublicKeyDigestBase64url,
                );
                let verified: ReturnType<typeof verifyDomainKeyAccessRequest> | null = null;
                try {
                  verified = verifyDomainKeyAccessRequest(input.crypto, {
                    bytes: requestBytes,
                    signingPublicKey: targetSigningPublicKey,
                  });
                  const actualRequestDigest = input.crypto.hash(requestBytes);
                  try {
                    if (
                      verified === null
                      || !sameBytes(actualRequestDigest, requestDigest)
                      || verified.requestId !== target.requestId
                      || verified.serverId !== input.serverId
                      || verified.cryptoDomainId !== current.domainId
                      || !sameBytes(
                        verified.participantDigest,
                        cacheRequirement.participantDigest,
                      )
                      || verified.participantCount !== current.participantCount
                      || verified.keyClass !== request.keyClass
                      || verified.domainKeyGeneration
                        !== current.domainKeyGeneration
                      || verified.authorizationRevision
                        !== current.authorizationRevision
                      || !sameBytes(
                        verified.headDigest,
                        cacheRequirement.headDigest,
                      )
                      || verified.humanId !== target.recipientHumanId
                      || verified.deviceId !== target.recipientDeviceId
                      || verified.deviceSigningKeyGeneration
                        !== target.recipientDeviceGeneration
                      || verified.recipientKeyId
                        !== target.recipientDeviceId
                      || verified.recipientKeyGeneration
                        !== target.recipientDeviceGeneration
                      || !sameBytes(
                        verified.recipientPublicKeyDigest,
                        targetPublicKeyDigest,
                      )
                    ) continue;
                  } finally {
                    actualRequestDigest.fill(0);
                  }
                  const envelope = await prepareDomainKeyRecipientEnvelope(
                    input.crypto,
                    {
                      head,
                      headDigest: cacheRequirement.headDigest,
                      recipient: {
                        recipientHumanId: humanId(target.recipientHumanId),
                        recipientKind: "device",
                        recipientKeyId: target.recipientDeviceId,
                        recipientKeyGeneration:
                          target.recipientDeviceGeneration,
                        recipientPublicKey: targetEncryptionPublicKey,
                        recipientPublicKeyDigest: targetPublicKeyDigest,
                      },
                      domainKey,
                      issuerHumanId: humanId(input.coordinates.humanActorId),
                      issuerDeviceId: cryptoDeviceId(input.coordinates.deviceId),
                      issuerDeviceSigningGeneration:
                        current.recipientDeviceSigningGeneration,
                      issuerSigningPublicKey: base.signingPublicKey,
                      issuerSigningPrivateKey: base.signingPrivateKey,
                    },
                  );
                  try {
                    const now = input.now();
                    const authorization = prepareDomainKeyRecipientAuthorization(
                      input.crypto,
                      {
                        authorizationOperationId: target.requestId,
                        reason: "catch_up",
                        requestDigest,
                        envelopeBytes: envelope.bytes,
                        envelopeDigest: envelope.digest,
                        issuerHumanId: humanId(input.coordinates.humanActorId),
                        issuerDeviceId: cryptoDeviceId(input.coordinates.deviceId),
                        issuerDeviceSigningGeneration:
                          current.recipientDeviceSigningGeneration,
                        issuedAt: now,
                        deadlineAt: now + 30_000,
                        issuerSigningPublicKey: base.signingPublicKey,
                        issuerSigningPrivateKey: base.signingPrivateKey,
                      },
                    );
                    try {
                      const result = await input.api.fulfilDomainKeyRecipientV2(
                        request.sourceRoomId,
                        request.namespaceId,
                        {
                          requestVersion: 2,
                          serverId: input.serverId,
                          clientDeviceId: input.coordinates.deviceId,
                          keyClass: request.keyClass,
                          requestId: target.requestId,
                          authorizationBytesBase64url:
                            toBase64url(authorization.bytes),
                        },
                        request.signal === undefined
                          ? undefined
                          : {signal: request.signal},
                      );
                      if (result.status !== "lost_race") fulfilled += 1;
                    } finally {
                      destroyDomainKeyRecipientAuthorizationV2(
                        authorization.authorization,
                      );
                      wipe([authorization.bytes, authorization.digest]);
                    }
                  } finally {
                    destroyDomainKeyRecipientEnvelopeV2(envelope.envelope);
                    wipe([envelope.bytes, envelope.digest]);
                  }
                } finally {
                  if (verified !== null) {
                    destroyDomainKeyAccessRequestV2(verified);
                  }
                  wipe([
                    requestBytes,
                    requestDigest,
                    targetSigningPublicKey,
                    targetEncryptionPublicKey,
                    targetPublicKeyDigest,
                  ]);
                }
              }
              return fulfilled;
            } finally {
              headBytes.fill(0);
              issuerSigningPublicKey.fill(0);
              destroyDomainKeyHeadV2(head);
            }
          }),
        );
        if (serviced.status !== "hit" || serviced.value === null) {
          return unavailable("fulfil", "source_key_unavailable");
        }
        return Object.freeze({
          status: "ready" as const,
          fulfilled: serviced.value,
        });
      } catch {
        return unavailable("fulfil", "request_failed");
      } finally {
        destroyRequirement(cacheRequirement);
      }
    },

    async serviceBacklog() {
      if (input.api.listPendingDomainKeySourceWorkV2 === undefined) {
        return unavailable("fulfil", "backlog_api_unavailable");
      }
      let pending;
      try {
        pending = await input.api.listPendingDomainKeySourceWorkV2({
          requestVersion: 2,
          serverId: input.serverId,
          clientDeviceId: input.coordinates.deviceId,
          limit: 16,
        });
      } catch {
        scheduleBacklogRetry();
        return unavailable("fulfil", "backlog_request_failed");
      }
      let fulfilled = 0;
      let fullCoordinate = false;
      for (const coordinate of pending.work) {
        const request = Object.freeze({
          sourceRoomId: coordinate.sourceRoomId,
          namespaceId: coordinate.namespaceId,
          keyClass: coordinate.keyClass,
        });
        // Deliver any current Domain key first. A newcomer may be its only
        // holder while an older qualified source is the only device able to
        // open retained Namespace history and wrap the replacement bundle.
        let serviced = await client.servicePending(request)
          .catch(() => unavailable("fulfil", "backlog_service_failed"));
        if (
          serviced.status === "unavailable"
          && serviced.reason === "source_key_unavailable"
        ) {
          // Reconnect recovery may have a durable envelope waiting even though
          // this process has not reopened the current key into its cache yet.
          const opened = await client.ensure(request).catch(() => null);
          if (opened?.status === "ready") {
            serviced = await client.servicePending(request)
              .catch(() => unavailable("fulfil", "backlog_service_failed"));
          }
        }
        if (serviced.status === "ready") {
          fulfilled += serviced.fulfilled;
          if (serviced.fulfilled >= 8) fullCoordinate = true;
        }
        await input.onBacklogCoordinate?.(request).catch(() => undefined);
      }
      const moreMayRemain = pending.work.length > 0 || fullCoordinate;
      if (moreMayRemain) {
        scheduleBacklogRetry();
      } else {
        backlogRetryAttempt = 0;
      }
      return Object.freeze({
        status: "ready" as const,
        coordinates: pending.work.length,
        fulfilled,
      });
    },

    async recover(
      request: DomainAccessRequestV2,
      credential: Readonly<{
        keyId: string;
        generation: number;
        publicKey: Uint8Array;
        privateKey: Uint8Array;
      }>,
    ) {
      if (!await ensureCacheAvailable()) {
        return unavailable("cache", "custody_unavailable");
      }
      const current = await plan(request).catch(() => null);
      if (current === null || current.status !== "ready") {
        return unavailable("plan", "head_unavailable");
      }
      const fetched = await input.api.fetchDomainKeyEnvelopeV2(
        request.sourceRoomId,
        request.namespaceId,
        {
          requestVersion: 2,
          serverId: input.serverId,
          clientDeviceId: input.coordinates.deviceId,
          keyClass: request.keyClass,
          recipientKind: "recovery",
          recoveryKeyId: credential.keyId,
          recoveryKeyGeneration: credential.generation,
        },
      ).catch(() => null);
      if (fetched === null || fetched.status !== "ready") {
        return unavailable("envelope_open", "recovery_envelope_unavailable");
      }
      const envelopeBytes = fromBase64url(fetched.envelopeBytesBase64url);
      const envelopeDigest = fromBase64url(fetched.envelopeDigestBase64url);
      const issuerSigningPublicKey = fromBase64url(
        fetched.issuerSigningPublicKeyBase64url,
      );
      const cacheRequirement = requirement(input.serverId, current);
      let opened: Awaited<ReturnType<typeof openDomainKeyRecipientEnvelope>> = null;
      try {
        opened = await openDomainKeyRecipientEnvelope(input.crypto, {
          envelopeBytes,
          expectedEnvelopeDigest: envelopeDigest,
          issuerSigningPublicKey,
          recipientHumanId: humanId(input.coordinates.humanActorId),
          recipientKind: "recovery",
          recipientKeyId: credential.keyId,
          recipientKeyGeneration: credential.generation,
          recipientPrivateKey: credential.privateKey,
        });
        if (opened === null) {
          return unavailable("envelope_open", "recovery_envelope_invalid");
        }
        await input.cache.putKey(input.coordinates, {
          ...cacheRequirement,
          domainKey: opened.domainKey,
        });
        if (!await requestRecipient(request, current)) {
          return unavailable("request", "recovery_rewrap_request_failed");
        }
        const serviced = await client.servicePending(request);
        if (serviced.status !== "ready") return serviced;
        const durable = await input.api.fetchDomainKeyEnvelopeV2(
          request.sourceRoomId,
          request.namespaceId,
          {
            requestVersion: 2,
            serverId: input.serverId,
            clientDeviceId: input.coordinates.deviceId,
            keyClass: request.keyClass,
          },
        ).catch(() => null);
        return durable?.status === "ready"
          ? Object.freeze({ status: "ready" as const })
          : unavailable("fulfil", "recovery_rewrap_unavailable");
      } finally {
        if (opened !== null) {
          destroyDomainKeyRecipientEnvelopeV2(opened.envelope);
          wipe([opened.envelopeDigest, opened.domainKey]);
        }
        destroyRequirement(cacheRequirement);
        wipe([envelopeBytes, envelopeDigest, issuerSigningPublicKey]);
      }
    },
  });
  return client;
}
