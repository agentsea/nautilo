import type { NautiloApiClient } from "@nautilo/api-client/browser";
import { createObservedHumanMemoryDeviceContent } from "../memory/observed-human-memory-device-content.ts";
import type { DeviceAdmissionStatus } from "@nautilo/api-client/browser";
import {
  LatticeCrypto,
  authorizationRevision,
  cryptoDeviceId,
  decodeHumanDeviceGroupHead,
  humanDeviceGroupHeadDigest,
  humanHistoryReadResultSetDigest,
  humanHistoryReadSelectedCoordinateDigest,
  humanId,
  prepareHumanHistoryReadAcknowledgement,
  unixTimestamp,
  type HumanHistoryReadResultCounts,
  type HumanHistoryReadSelectedCoordinate,
} from "@nautilo/lattice-crypto";
import type { BackgroundAuthorizationIssuerV2 } from
  "@nautilo/lattice-crypto/background";
import {
  authenticateClientDeviceProfileV4,
  createClientProfileObjectAccessAnchorPortV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import type { ClientNamespaceGenerationCacheVaultV1 } from
  "../../client-vault/namespace-generation-cache-v1.ts";
import { createClientDomainKeyCacheVaultV2 } from
  "../../client-vault/domain-key-cache-v2.ts";
import { deriveAdditionalDeviceClientIdentity } from
  "../../device/additional-device-client.ts";
import {
  createAuthorizedHumanLiveShadowMessageClient,
  type AuthorizedHumanLiveShadowMessageClient,
  type CreateAuthorizedHumanLiveShadowMessageClientInput,
  type HumanLiveShadowMessageApiPort,
} from "./authorized-human-live-shadow-message-client.ts";
import {
  createDomainKeyAuthorityClientV2,
  type DomainKeyAuthorityClientV2,
} from
  "./domain-key-authority-client.ts";
import { createDomainNamespaceAuthorityClientV2 } from
  "./domain-namespace-authority-client.ts";
import type { ProtectedRoomAccessStateV2 } from
  "./domain-namespace-authority-client.ts";
import {
  createDomainNamespaceAuthorityAdapterV2,
  createDomainNamespaceHistoryAuthorityAdapterV2,
} from
  "./domain-namespace-authority-adapter.ts";
import { createDomainForegroundAuthorityClientV2 } from
  "./domain-foreground-authority-client.ts";
import {
  createVaultLiveShadowMessageReceiver,
  type VaultLiveShadowMessageReceiver,
} from "./vault-live-shadow-message-receiver.ts";
import {
  createVaultHumanPeerLiveShadowMessageReceiver,
  type VaultHumanPeerLiveShadowMessageReceiver,
} from "./vault-human-peer-live-shadow-message-receiver.ts";
import {
  createVaultSharedAgentLiveShadowMessageReceiver,
  type VaultSharedAgentLiveShadowMessageReceiver,
} from "./vault-shared-agent-live-shadow-message-receiver.ts";
import {
  createVaultSharedAgentOutputLiveShadowReceiver,
  type VaultSharedAgentOutputLiveShadowReceiver,
} from "./vault-shared-agent-output-live-shadow-receiver.ts";
import {
  createVaultRoomHistoryShadowMessageReader,
  type RoomHistoryShadowRecordTransportV1,
  type RoomHistoryShadowFallbackReasonV1,
  type VaultRoomHistoryShadowMessageReader,
  type VaultRoomHistoryShadowReadResultV1,
} from "./vault-room-history-shadow-message-reader.ts";
import { prepareHumanDeviceOrdinaryRepairAttestationV3 } from
  "../../message/human-device-ordinary-repair-attestation-v2.ts";
import { encodeMessagePayloadV2 } from "../../message/message-payload-v2.ts";
import {
  createPreparedMutationJournal,
  type PreparedHumanMutation,
  type PreparedHumanMemoryMutation,
  type PreparedMutationRetryCandidate,
  type PreparedMutationJournalVaultPort,
} from "../memory/prepared-mutation-journal.ts";
import {
  createAuthorizedHumanMemoryClientFromTrustedPorts,
  type AuthorizedHumanMemoryClient,
} from "../memory/authorized-human-memory-client.ts";
import type { EncryptionDataOperationOwner } from
  "../../transition/encryption-data-operation-owner.ts";
import { createDeviceMessageBackfillClient, type DeviceMessageBackfillApiPort } from "./device-message-backfill-client.ts";
import { createHumanMemoryProcessorTransport } from "../memory/human-memory-processor-transport.ts";
import {
  createVaultAuthorizedHumanMemoryDeviceContentPort,
} from "../memory/vault-human-memory-device-content.ts";
import type { PreparedMutationJournalCustodyAvailability } from
  "../memory/file-prepared-mutation-journal-vault.ts";
import {
  createHumanDeviceMembershipClient,
  type HumanDeviceMembershipApiPort,
} from "../../device/human-device-membership-client.ts";
import {
  createBackgroundAuthorizationSweepV2,
  type BackgroundAuthorizationSweepResultV2,
} from "../background/background-authorization-sweep-v2.ts";
import {
  respondToCurrentDeviceAuthorizationV2,
  type CurrentBackgroundAuthorizationSigningAuthorityV2,
} from "../background/device-authorization-responder-v2.ts";

export type ForegroundShadowClientKind = "browser" | "electron";

export interface ForegroundShadowPreparedMutationJournalVault
  extends PreparedMutationJournalVaultPort {
  availability(): Promise<PreparedMutationJournalCustodyAvailability>;
  unlock(): Promise<PreparedMutationJournalCustodyAvailability>;
}

/** Platform custody only. Protocol and transport decisions stay shared. */
export interface ForegroundShadowClientPlatform {
  readonly clientKind: ForegroundShadowClientKind;
  readonly clientLabel: "Browser" | "Electron";
  createProfileVault(): ClientProfileVault;
  createPreparedMutationJournalVault():
    ForegroundShadowPreparedMutationJournalVault;
  createNamespaceGenerationCacheVault():
    ClientNamespaceGenerationCacheVaultV1;
  createId(): string;
}

export interface ForegroundLiveShadowMessageClientInput {
  readonly api: HumanLiveShadowMessageApiPort & Pick<
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
  > & Partial<Pick<NautiloApiClient, "listPendingDomainKeySourceWorkV2">>
    & Partial<HumanDeviceMembershipApiPort>;
  readonly serverScope: string;
  readonly userId: string;
  readonly humanActorId: string;
  readonly installationId: string;
  readonly normalizeContent: (content: string) => string;
  readonly crypto?: LatticeCrypto;
  readonly now?: () => number;
  readonly createIdempotencyKey?: () => string;
  readonly onHumanVerified?: CreateAuthorizedHumanLiveShadowMessageClientInput[
    "onHumanVerified"
  ];
  readonly onDurableRecovery?: CreateAuthorizedHumanLiveShadowMessageClientInput[
    "onDurableRecovery"
  ];
  readonly onProtectedRoomAccessState?: (
    state: ProtectedRoomAccessStateV2,
  ) => void;
}

type DomainAuthorityApi = Pick<
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

const HUMAN_DEVICE_MEMBERSHIP_API_METHODS = Object.freeze([
  "loadHumanDeviceMembership",
  "establishHumanDeviceMembership",
  "beginHumanDeviceMembership",
  "publishHumanDeviceMembershipJoin",
  "listHumanDeviceMembershipPending",
  "listHumanDeviceMembershipRoster",
  "publishHumanDeviceMembershipAdd",
  "publishHumanDeviceMembershipRemove",
  "acknowledgeHumanDeviceMembership",
] as const);

function humanDeviceMembershipApi(
  candidate: ForegroundLiveShadowMessageClientInput["api"],
): HumanDeviceMembershipApiPort | null {
  const record = candidate as unknown as Record<string, unknown>;
  return HUMAN_DEVICE_MEMBERSHIP_API_METHODS.every((method) =>
      typeof record[method] === "function"
    )
    ? candidate as HumanDeviceMembershipApiPort
    : null;
}

type IdentityInput = Readonly<{
  serverScope: string;
  userId: string;
  humanActorId: string;
  installationId: string;
}>;

function identity(
  platform: Pick<ForegroundShadowClientPlatform, "clientKind">,
  crypto: LatticeCrypto,
  input: IdentityInput,
) {
  return deriveAdditionalDeviceClientIdentity({
    crypto,
    ...input,
    clientKind: platform.clientKind,
  });
}

export type ForegroundBackgroundAuthorizationApi = DomainAuthorityApi
  & Pick<
    NautiloApiClient,
    | "listBackgroundAuthorizationRequests"
    | "respondBackgroundAuthorizationRequest"
    | "loadHumanDeviceMembership"
    | "listHumanDeviceMembershipRoster"
  >
  & Readonly<{
    deviceAdmission: Pick<NautiloApiClient["deviceAdmission"], "status">;
    admin: Readonly<{
      encryptionTransition: Pick<
        NautiloApiClient["admin"]["encryptionTransition"],
        "getPolicy"
      >;
    }>;
  }>;

export type ForegroundBackgroundAuthorizationClientInput = IdentityInput
  & Readonly<{
    api: ForegroundBackgroundAuthorizationApi;
    crypto?: LatticeCrypto;
    now?: () => number;
    createId?: () => string;
  }>;

export interface ForegroundBackgroundAuthorizationClientV2 {
  readonly deviceId: string;
  service(input?: Readonly<{ signal?: AbortSignal }>):
    Promise<BackgroundAuthorizationSweepResultV2>;
}

type CurrentPublicSigningAuthority = Readonly<{
  issuer: BackgroundAuthorizationIssuerV2;
  policyRevision: number;
  localSnapshot: Readonly<{
    domainId: string;
    epoch: number;
    stateHash: Uint8Array;
  }>;
}>;

function decodeCanonicalBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const bytes = Uint8Array.from(
    atob(padded),
    (character) => character.charCodeAt(0),
  );
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const canonical = btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
  if (bytes.length === 0 || canonical !== value) {
    bytes.fill(0);
    throw new TypeError("Current Human-device authority bytes are invalid");
  }
  return bytes;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function destroyPublicSigningAuthority(
  authority: CurrentPublicSigningAuthority,
): void {
  authority.issuer.headDigest.fill(0);
  authority.issuer.signingPublicKeyHash.fill(0);
  authority.localSnapshot.stateHash.fill(0);
}

/**
 * Shared Browser/Electron current-authority responder. Public issuer
 * coordinates are reconstructed from the authenticated admission and M304
 * membership routes, then checked against the locally authenticated V4 MLS
 * snapshot before the profile signing key is lent.
 */
export function createForegroundBackgroundAuthorizationClientV2(
  platform: Pick<
    ForegroundShadowClientPlatform,
    | "clientKind"
    | "createProfileVault"
    | "createNamespaceGenerationCacheVault"
    | "createId"
  >,
  input: ForegroundBackgroundAuthorizationClientInput,
): ForegroundBackgroundAuthorizationClientV2 {
  const crypto = input.crypto ?? new LatticeCrypto();
  const currentIdentity = identity(
    platform,
    crypto,
    input,
  );
  const vault = platform.createProfileVault();
  const now = input.now ?? Date.now;
  const createId = input.createId ?? (() => platform.createId());
  const authorities = createForegroundDomainAuthorityClientsV2(platform, {
    api: input.api,
    crypto,
    vault,
    coordinates: currentIdentity.coordinates,
    now,
    createId,
    cache: platform.createNamespaceGenerationCacheVault(),
  });
  if (authorities === null) {
    throw new TypeError("Background Domain authority API is unavailable");
  }

  const inspectCurrent = async (
    signal?: AbortSignal,
  ): Promise<CurrentPublicSigningAuthority | null> => {
    signal?.throwIfAborted();
    const policy = await input.api.admin.encryptionTransition.getPolicy(
      signal === undefined ? undefined : { signal },
    );
    signal?.throwIfAborted();
    const admission = await input.api.deviceAdmission.status(
      signal === undefined ? undefined : { signal },
    );
    signal?.throwIfAborted();
    if ((policy.policy.mode !== "shadow_encryption"
      && policy.policy.mode !== "encrypted_only")
      || admission.status !== "admitted"
      || admission.deviceId !== currentIdentity.coordinates.deviceId
      || admission.expiresAt <= now()) return null;
    const membership = await input.api.loadHumanDeviceMembership({
      requestVersion: 1,
      deviceId: currentIdentity.coordinates.deviceId,
    });
    signal?.throwIfAborted();
    const roster = await input.api.listHumanDeviceMembershipRoster({
      requestVersion: 1,
      currentDeviceId: currentIdentity.coordinates.deviceId,
    });
    signal?.throwIfAborted();
    if (membership.membershipState !== "current"
      || membership.head === null
      || membership.deviceId !== currentIdentity.coordinates.deviceId
      || membership.deviceGeneration !== admission.deviceGeneration
      || membership.humanId !== input.humanActorId
      || roster.currentDeviceId !== currentIdentity.coordinates.deviceId) {
      return null;
    }
    const rosterDevice = roster.devices.find((entry) =>
      entry.deviceId === currentIdentity.coordinates.deviceId
      && entry.isCurrentDevice
    );
    if (rosterDevice === undefined
      || rosterDevice.membershipState !== "current"
      || rosterDevice.membershipEvidence === null
      || rosterDevice.deviceGeneration !== admission.deviceGeneration) {
      return null;
    }
    const headBytes = decodeCanonicalBase64url(
      membership.head.headBytesBase64url,
    );
    const rosterHeadDigest = decodeCanonicalBase64url(
      rosterDevice.membershipEvidence.headDigestBase64url,
    );
    let head: ReturnType<typeof decodeHumanDeviceGroupHead> | undefined;
    let headDigest: Uint8Array | undefined;
    try {
      const decodedHead = decodeHumanDeviceGroupHead(headBytes);
      head = decodedHead;
      const computedHeadDigest = humanDeviceGroupHeadDigest(
        crypto,
        decodedHead,
      );
      headDigest = computedHeadDigest;
      const evidence = rosterDevice.membershipEvidence;
      if (decodedHead.serverInstanceId !== membership.serverInstanceId
        || decodedHead.humanId !== input.humanActorId
        || decodedHead.lineageGeneration !== evidence.lineageGeneration
        || decodedHead.epoch !== evidence.epoch
        || decodedHead.securityRevision !== evidence.securityRevision
        || evidence.acknowledgedSequence !== membership.head.sequence
        || !sameBytes(computedHeadDigest, rosterHeadDigest)) return null;
      const available = await vault.availability();
      signal?.throwIfAborted();
      if (available.status !== "available"
        && (await vault.unlock()).status !== "available") return null;
      signal?.throwIfAborted();
      return await vault.withOpenProfile(
        currentIdentity.coordinates,
        async (profileBytes) => {
          const profile = await authenticateClientDeviceProfileV4({
            crypto,
            profileBytes,
            expectedDeviceId: currentIdentity.coordinates.deviceId,
          });
          try {
            signal?.throwIfAborted();
            const snapshot = profile.humanDeviceGroupSnapshot;
            if (snapshot === null
              || snapshot.domainId !== decodedHead.groupId
              || snapshot.epoch !== decodedHead.epoch
              || !sameBytes(snapshot.stateHash, decodedHead.stateHash)) {
              return null;
            }
            return Object.freeze({
              issuer: Object.freeze({
                humanId: input.humanActorId,
                deviceId: currentIdentity.coordinates.deviceId,
                deviceGeneration: admission.deviceGeneration,
                serverInstanceId: membership.serverInstanceId,
                lineageGeneration: decodedHead.lineageGeneration,
                epoch: decodedHead.epoch,
                securityRevision: decodedHead.securityRevision,
                headDigest: computedHeadDigest.slice(),
                signingPublicKeyHash: crypto.hash(
                  profile.baseProfile.baseProfile.signingPublicKey,
                ),
              }),
              policyRevision: policy.policy.revision,
              localSnapshot: Object.freeze({
                domainId: snapshot.domainId,
                epoch: snapshot.epoch,
                stateHash: snapshot.stateHash.slice(),
              }),
            });
          } finally {
            destroyOpenedClientDeviceProfileV4(profile);
          }
        },
      );
    } finally {
      headBytes.fill(0);
      rosterHeadDigest.fill(0);
      headDigest?.fill(0);
      head?.stateHash.fill(0);
      head?.rosterDigest.fill(0);
      head?.previousHeadDigest?.fill(0);
    }
  };

  const sweep = createBackgroundAuthorizationSweepV2({
    api: input.api,
    respond: async (descriptorBytes, signal) => {
      let current: CurrentPublicSigningAuthority | null;
      try {
        current = await inspectCurrent(signal);
      } catch {
        signal?.throwIfAborted();
        return Object.freeze({
          status: "unavailable" as const,
          reason: "signing_authority_unavailable" as const,
        });
      }
      if (current === null) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "signing_authority_unavailable" as const,
        });
      }
      try {
        return await respondToCurrentDeviceAuthorizationV2({
          descriptorBytes,
          ...(signal === undefined ? {} : { signal }),
          domainAuthority: authorities.domain,
          namespaceAuthority: authorities.namespace,
          crypto,
          serverId: input.serverScope,
          now,
          createId,
          withCurrentSigningAuthority: async <Value>(use: (
            authority: CurrentBackgroundAuthorizationSigningAuthorityV2,
          ) => Value | Promise<Value>): Promise<Value | null> => {
            signal?.throwIfAborted();
            return vault.withOpenProfile(
              currentIdentity.coordinates,
              async (profileBytes) => {
                const profile = await authenticateClientDeviceProfileV4({
                  crypto,
                  profileBytes,
                  expectedDeviceId: currentIdentity.coordinates.deviceId,
                });
                try {
                  signal?.throwIfAborted();
                  const base = profile.baseProfile.baseProfile;
                  const publicKeyHash = crypto.hash(base.signingPublicKey);
                  try {
                    const snapshot = profile.humanDeviceGroupSnapshot;
                    if (snapshot === null
                      || snapshot.domainId !== current.localSnapshot.domainId
                      || snapshot.epoch !== current.localSnapshot.epoch
                      || !sameBytes(
                        snapshot.stateHash,
                        current.localSnapshot.stateHash,
                      )
                      || !sameBytes(
                        publicKeyHash,
                        current.issuer.signingPublicKeyHash,
                      )) return null;
                    return await use({
                      issuer: current.issuer,
                      signingPrivateKey: base.signingPrivateKey,
                      policyRevision: current.policyRevision,
                    });
                  } finally {
                    publicKeyHash.fill(0);
                  }
                } finally {
                  destroyOpenedClientDeviceProfileV4(profile);
                }
              },
            );
          },
        });
      } finally {
        destroyPublicSigningAuthority(current);
      }
    },
  });
  return Object.freeze({
    deviceId: currentIdentity.coordinates.deviceId,
    service: (options: Readonly<{ signal?: AbortSignal }> = {}) =>
      sweep.sweep(options),
  });
}

export function createForegroundDomainKeyAuthorityClientV2(
  platform: Pick<
    ForegroundShadowClientPlatform,
    "createNamespaceGenerationCacheVault"
  >,
  input: Readonly<{
    api: DomainAuthorityApi;
    crypto: LatticeCrypto;
    vault: ClientProfileVault;
    coordinates: ClientProfileCoordinates;
    now: () => number;
    createId: () => string;
    cache?: ClientNamespaceGenerationCacheVaultV1;
  }>,
) {
  return createForegroundDomainAuthorityClientsV2(platform, input)?.domain
    ?? null;
}

function createForegroundDomainAuthorityClientsV2(
  platform: Pick<
    ForegroundShadowClientPlatform,
    "createNamespaceGenerationCacheVault"
  >,
  input: Readonly<{
    api: DomainAuthorityApi;
    crypto: LatticeCrypto;
    vault: ClientProfileVault;
    coordinates: ClientProfileCoordinates;
    now: () => number;
    createId: () => string;
    cache?: ClientNamespaceGenerationCacheVaultV1;
    onProtectedRoomAccessState?: (
      state: ProtectedRoomAccessStateV2,
    ) => void;
  }>,
) {
  const api = input.api;
  const namespaceRef: {
    current?: ReturnType<typeof createDomainNamespaceAuthorityClientV2>;
  } = {};
  const domain = createDomainKeyAuthorityClientV2({
    api,
    crypto: input.crypto,
    vault: input.vault,
    cache: createClientDomainKeyCacheVaultV2(
      input.cache ?? platform.createNamespaceGenerationCacheVault(),
    ),
    coordinates: input.coordinates,
    serverId: input.coordinates.serverScope,
    now: input.now,
    createId: input.createId,
    scheduleRetry: (retry, delayMs) => {
      globalThis.setTimeout(() => void retry(), delayMs);
    },
    onBacklogCoordinate: async (request) => {
      await namespaceRef.current?.ensure(request);
    },
    onDiagnostic: ({ stage, reason }) => {
      console.warn(`V2 Domain authority unavailable: ${stage}/${reason}`);
    },
  });
  const namespace = createDomainNamespaceAuthorityClientV2({
    api,
    crypto: input.crypto,
    vault: input.vault,
    coordinates: input.coordinates,
    domainAuthority: domain,
    serverId: input.coordinates.serverScope,
    now: input.now,
    createId: input.createId,
    ...(input.onProtectedRoomAccessState === undefined
      ? {}
      : { onAccessState: input.onProtectedRoomAccessState }),
  });
  namespaceRef.current = namespace;
  return Object.freeze({ domain, namespace });
}

/**
 * Opens this device's small personal Domain authority and, once open, services
 * other enrolled devices waiting for the same keys. Settings calls this during
 * ordinary readiness polling, so a connected peer does not need a foreground
 * Message send merely to finish a new device connection.
 */
export async function ensurePersonalDomainAuthorityV2(
  authority: DomainKeyAuthorityClientV2,
  anchor: Readonly<{ roomId: string; namespaceId: string }>,
): Promise<Readonly<{ status: "ready" | "pending" | "unavailable" }>> {
  const results = await Promise.all(
    (["human", "ai"] as const).map(async (keyClass) => {
      const request = {
        sourceRoomId: anchor.roomId,
        namespaceId: anchor.namespaceId,
        keyClass,
      };
      const ensured = await authority.ensure(request);
      if (ensured.status === "ready") {
        await authority.servicePending(request).catch(() => undefined);
      }
      return ensured;
    }),
  );
  if (authority.serviceBacklog !== undefined) {
    await authority.serviceBacklog().catch(() => undefined);
  }
  return Object.freeze({
    status: results.every((result) => result.status === "ready")
      ? "ready" as const
      : results.some((result) => result.status === "unavailable")
      ? "unavailable" as const
      : "pending" as const,
  });
}

/** Restore the two minimum personal Domain keys from recovery custody. */
export async function recoverPersonalDomainAuthorityV2(
  authority: DomainKeyAuthorityClientV2,
  anchor: Readonly<{ roomId: string; namespaceId: string }>,
  credential: Readonly<{
    keyId: string;
    generation: number;
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  }>,
): Promise<Readonly<{ status: "ready" | "unavailable" }>> {
  if (authority.recover === undefined) {
    return Object.freeze({ status: "unavailable" as const });
  }
  const results = await Promise.all(
    (["human", "ai"] as const).map((keyClass) => authority.recover!({
      sourceRoomId: anchor.roomId,
      namespaceId: anchor.namespaceId,
      keyClass,
    }, credential)),
  );
  return Object.freeze({
    status: results.every((result) => result.status === "ready")
      ? "ready" as const
      : "unavailable" as const,
  });
}

/** Public, secret-free coordinate used to bind foreground approvals. */
export function deriveForegroundCryptoDeviceId(
  clientKind: ForegroundShadowClientKind,
  input: IdentityInput,
): string {
  return deriveAdditionalDeviceClientIdentity({
    crypto: new LatticeCrypto(),
    ...input,
    clientKind,
  }).coordinates.deviceId;
}

function authorityClients(
  platform: ForegroundShadowClientPlatform,
  input: Readonly<{
    api: ForegroundLiveShadowMessageClientInput["api"];
    crypto: LatticeCrypto;
    vault: ClientProfileVault;
    coordinates: ClientProfileCoordinates;
    now: () => number;
    createId: () => string;
    onProtectedRoomAccessState?: (
      state: ProtectedRoomAccessStateV2,
    ) => void;
  }>,
) {
  const cache = platform.createNamespaceGenerationCacheVault();
  const clients = createForegroundDomainAuthorityClientsV2(platform, {
    ...input,
    cache,
  });
  if (clients === null) {
    return Object.freeze({
      namespaceAuthority: undefined,
      namespaceV2: undefined,
      domainKeyAuthority: undefined,
      domainForegroundAuthority: null,
      receiveDomainKeyDelivery: undefined,
    });
  }
  const { domain, namespace } = clients;
  const adapter = createDomainNamespaceAuthorityAdapterV2({
    domainAuthority: domain,
    namespaceAuthority: namespace,
  });
  return Object.freeze({
    namespaceAuthority: adapter,
    namespaceV2: namespace,
    domainKeyAuthority: domain,
    domainForegroundAuthority: createDomainForegroundAuthorityClientV2({
      domainAuthority: domain,
      namespaceAuthority: namespace,
    }),
    receiveDomainKeyDelivery: (
      sourceRoomId: string,
      namespaceId: string,
      keyClass: "human" | "ai",
    ) => namespace.ensure({ sourceRoomId, namespaceId, keyClass }),
  });
}

function namespaceAuthority(
  platform: ForegroundShadowClientPlatform,
  input: Parameters<typeof authorityClients>[1],
) {
  const authority = authorityClients(platform, input).namespaceAuthority;
  if (authority === undefined) {
    throw new TypeError("Domain Key V2 authority API is unavailable");
  }
  return authority;
}

export type ForegroundHumanMemoryClientInput = Readonly<{
  dataOperationOwner: EncryptionDataOperationOwner;
  api: NautiloApiClient;
  serverScope: string;
  userId: string;
  humanActorId: string;
  installationId: string;
  crypto?: LatticeCrypto;
  now?: () => number;
  createIdempotencyKey?: () => string;
  resolveDeviceAdmissionStatus: () => Promise<DeviceAdmissionStatus>;
  onProtectedRoomAccessState?: (state: ProtectedRoomAccessStateV2) => void;
}>;

/**
 * Shared Browser/Electron Human Memory client assembly. The platform decides
 * custody; protocol identity, Domain authority, anchors, and mutation journal
 * are the same ones used by foreground encrypted messaging.
 */
export function createForegroundHumanMemoryClient(
  platform: ForegroundShadowClientPlatform,
  input: ForegroundHumanMemoryClientInput,
): AuthorizedHumanMemoryClient {
  const crypto = input.crypto ?? new LatticeCrypto();
  const clientIdentity = identity(platform, crypto, input);
  const vault = platform.createProfileVault();
  const journalVault = platform.createPreparedMutationJournalVault();
  const now = input.now ?? Date.now;
  const createId = input.createIdempotencyKey ?? (() => platform.createId());
  const authorities = authorityClients(platform, {
    api: input.api,
    crypto,
    vault,
    coordinates: clientIdentity.coordinates,
    now,
    createId,
    ...(input.onProtectedRoomAccessState === undefined ? {} : {
      onProtectedRoomAccessState: input.onProtectedRoomAccessState,
    }),
  });
  if (authorities.namespaceAuthority === undefined) {
    throw new TypeError("Domain Key V2 Human Memory authority is unavailable");
  }
  const journal = createPreparedMutationJournal({ vault: journalVault, now });
  async function withJournal<Result>(use: () => Promise<Result>): Promise<Result> {
    const current = await journalVault.availability();
    if (current.status !== "available") {
      const unlocked = await journalVault.unlock();
      if (unlocked.status !== "available") {
        throw new TypeError(`Human Memory retry custody is unavailable (${unlocked.status})`);
      }
    }
    return use();
  }
  const isMemoryKind = (kind: string): kind is PreparedHumanMemoryMutation["kind"] =>
    kind === "create" || kind === "update" || kind === "access" || kind === "repair";
  const isMemoryMutation = (
    mutation: PreparedHumanMutation,
  ): mutation is PreparedHumanMemoryMutation => isMemoryKind(mutation.kind);
  return createAuthorizedHumanMemoryClientFromTrustedPorts({
    owner: input.dataOperationOwner,
    api: createHumanMemoryProcessorTransport({
      api: input.api, crypto, subjectId: input.userId, now,
    }),
    content: createObservedHumanMemoryDeviceContent({
      crypto,
      async withSigningAuthority(_dto, use) {
        const admission = await input.resolveDeviceAdmissionStatus();
        if (admission.status !== "admitted"
          || admission.deviceId !== clientIdentity.coordinates.deviceId) return null;
        const available = await vault.availability();
        if (available.status !== "available"
          && (await vault.unlock()).status !== "available") return null;
        return vault.withOpenProfile(clientIdentity.coordinates, async (profileBytes) => {
          const profile = await authenticateClientDeviceProfileV4({
            crypto, profileBytes, expectedDeviceId: clientIdentity.coordinates.deviceId,
          });
          try {
            const base = profile.baseProfile.baseProfile;
            return await use({ subjectHumanId: input.humanActorId,
              readerDeviceId: base.deviceId, readerDeviceSigningKeyGeneration: admission.deviceGeneration,
              hostAuthorizationRevision: base.trustedHostAuthorizationRevision,
              signingPrivateKey: base.signingPrivateKey, signingPublicKey: base.signingPublicKey });
          } finally { destroyOpenedClientDeviceProfileV4(profile); }
        });
      },
      async observe(bytes) {
        await input.api.observeHumanMemoryRead({ requestVersion: 1,
          acknowledgementBytesBase64url: bytesToBase64url(bytes) });
      },
      content: createVaultAuthorizedHumanMemoryDeviceContentPort({
      crypto,
      vault,
      coordinates: clientIdentity.coordinates,
      subjectHumanId: input.humanActorId,
      now,
      createOperationId: createId,
      createProfileStageId: createId,
      resolveDeviceAdmissionStatus: input.resolveDeviceAdmissionStatus,
      accessAnchors: createClientProfileObjectAccessAnchorPortV4({
        crypto, vault, coordinates: clientIdentity.coordinates,
        createStageId: createId,
      }),
      namespaceAuthority: authorities.namespaceAuthority,
      }),
    }),
    journal: {
      capacity: () => withJournal(() => journal.capacity()),
      putBeforeSend: (mutation) => withJournal(() => journal.putBeforeSend(mutation)),
      listDue: async (at) => (await withJournal(() => journal.listDue(at))).filter(
        (candidate): candidate is PreparedMutationRetryCandidate =>
          isMemoryKind(candidate.kind),
      ),
      withPrepared: (operationId, use) => withJournal(() => journal.withPrepared(
        operationId,
        (mutation) => {
          if (!isMemoryMutation(mutation)) {
            throw new TypeError("Prepared mutation is not a Human Memory mutation");
          }
          return use(mutation);
        },
      )),
      recordOutcome: (outcome) => withJournal(() => journal.recordOutcome(outcome)),
    },
    createOperationId: () => createId(),
  });
}

export function createForegroundLiveShadowMessageClient(
  platform: ForegroundShadowClientPlatform,
  input: ForegroundLiveShadowMessageClientInput,
): AuthorizedHumanLiveShadowMessageClient {
  const crypto = input.crypto ?? new LatticeCrypto();
  const clientIdentity = identity(platform, crypto, input);
  const journalVault = platform.createPreparedMutationJournalVault();
  const profileVault = platform.createProfileVault();
  const now = input.now ?? Date.now;
  const createIdempotencyKey = input.createIdempotencyKey
    ?? (() => platform.createId());
  const authorities = authorityClients(platform, {
    api: input.api,
    crypto,
    vault: profileVault,
    coordinates: clientIdentity.coordinates,
    now,
    createId: createIdempotencyKey,
    ...(input.onProtectedRoomAccessState === undefined
      ? {}
      : { onProtectedRoomAccessState: input.onProtectedRoomAccessState }),
  });
  const namespaceAuthority = authorities.namespaceAuthority;
  const membershipApi = humanDeviceMembershipApi(input.api);
  const membership = membershipApi === null
    ? null
    : createHumanDeviceMembershipClient({
      api: membershipApi,
      crypto,
      vault: profileVault,
      coordinates: clientIdentity.coordinates,
      clientKind: platform.clientKind,
      installationLineageDigest: clientIdentity.installationLineageDigest,
      idempotencyKey: clientIdentity.idempotencyKey,
    });
  return createAuthorizedHumanLiveShadowMessageClient({
    planRequestVersion: 2,
    api: input.api,
    crypto,
    vault: profileVault,
    coordinates: clientIdentity.coordinates,
    journal: createPreparedMutationJournal({ vault: journalVault, now }),
    ensureJournalAvailable: async () => {
      const current = await journalVault.availability();
      if (current.status === "available") return true;
      return (await journalVault.unlock()).status === "available";
    },
    now,
    createIdempotencyKey,
    normalizeContent: input.normalizeContent,
    ...(membership === null ? {} : {
      ensureDeviceMembershipReady: async () => {
        const progress = await membership.ensure();
        // Foreground message preparation owns its exact Domain/Namespace
        // readiness immediately after this repair. Reaching the current MLS
        // head is therefore sufficient even when personal authority remains
        // independently pending.
        return progress.status === "ready"
          || (progress.status === "syncing"
            && progress.syncReason === "personal_authority_required");
      },
    }),
    ...(namespaceAuthority === undefined ? {} : {
      namespaceAuthority,
      synchronizeHumanPeerRecipients: async (
        roomId: string,
        namespaceId: string,
      ) => {
        const synchronized = await namespaceAuthority
          .synchronizeRecipients({ sourceRoomId: roomId, namespaceId, keyClass: "human" });
        if (synchronized.status !== "ready") return false;
        const current = await namespaceAuthority.ensure({
          sourceRoomId: roomId,
          namespaceId,
          keyClass: "human",
          operationId: createIdempotencyKey(),
          idempotencyKey: createIdempotencyKey(),
        });
        return current.status === "ready";
      },
      serviceDomainKeyRequests: async (
        roomId: string,
        namespaceId: string,
        keyClass: "human" | "ai",
      ) => {
        const synchronized = await namespaceAuthority
          .synchronizeRecipients({ sourceRoomId: roomId, namespaceId, keyClass });
        return synchronized.status === "ready";
      },
      serviceDomainKeyBacklog: async () =>
        authorities.domainKeyAuthority?.serviceBacklog === undefined
          ? false
          : (await authorities.domainKeyAuthority.serviceBacklog()).status
            === "ready",
    }),
    ...(authorities.domainForegroundAuthority === null
      ? {}
      : { domainForegroundAuthority: authorities.domainForegroundAuthority }),
    ...(authorities.receiveDomainKeyDelivery === undefined ? {} : {
      receiveDomainKeyDelivery: async (
        roomId: string,
        namespaceId: string,
        keyClass: "human" | "ai",
      ) => (await authorities.receiveDomainKeyDelivery(
        roomId,
        namespaceId,
        keyClass,
      )).status === "ready",
    }),
    onUnavailable: ({ stage, reason }) => {
      console.warn(`Live Shadow Human diagnostic: ${stage}/${reason}`);
    },
    ...(input.onHumanVerified === undefined
      ? {}
      : { onHumanVerified: input.onHumanVerified }),
    ...(input.onDurableRecovery === undefined
      ? {}
      : { onDurableRecovery: input.onDurableRecovery }),
  });
}

export type ForegroundLiveShadowMessageReceiverInput = Omit<
  ForegroundLiveShadowMessageClientInput,
  "normalizeContent" | "createIdempotencyKey" | "onHumanVerified"
> & Readonly<{
  api: Pick<NautiloApiClient, "verifyLiveShadowRoomMessage">;
  onTerminalVerification?: (operationId: string) => Promise<void> | void;
  onVerificationAttemptFailed?: (diagnostic: Readonly<{
    operationId: string;
    attempt: number;
    willRetry: boolean;
  }>) => void;
}>;

export function createForegroundLiveShadowMessageReceiver(
  platform: ForegroundShadowClientPlatform,
  input: ForegroundLiveShadowMessageReceiverInput,
): VaultLiveShadowMessageReceiver {
  const crypto = input.crypto ?? new LatticeCrypto();
  const clientIdentity = identity(platform, crypto, input);
  const profileVault = platform.createProfileVault();
  const now = input.now ?? Date.now;
  const currentNamespaceAuthority = namespaceAuthority(platform, {
    api: input.api,
    crypto,
    vault: profileVault,
    coordinates: clientIdentity.coordinates,
    now,
    createId: () => platform.createId(),
    ...(input.onProtectedRoomAccessState === undefined
      ? {}
      : { onProtectedRoomAccessState: input.onProtectedRoomAccessState }),
  });
  return createVaultLiveShadowMessageReceiver({
    crypto,
    vault: profileVault,
    coordinates: clientIdentity.coordinates,
    namespaceAuthority: currentNamespaceAuthority,
    submitVerification: async (verification) => {
      const receipt = await input.api.verifyLiveShadowRoomMessage(
        verification.roomId,
        verification.operationId,
        {
          requestVersion: 1,
          operationId: verification.operationId,
          verificationBytesBase64url: verification.verificationBytesBase64url,
        },
      );
      return receipt.status;
    },
    ...(input.onTerminalVerification === undefined
      ? {}
      : { onTerminalVerification: input.onTerminalVerification }),
    onVerificationAttemptFailed: input.onVerificationAttemptFailed
      ?? (({ operationId, attempt, willRetry }) => {
        console.warn(
          `[live-shadow] ${platform.clientLabel} terminal verification attempt ${attempt} failed`
            + ` for ${operationId}; ${willRetry ? "retrying" : "exhausted"}`,
        );
      }),
    now,
  });
}

export type ForegroundHumanPeerLiveShadowMessageReceiverInput = Omit<
  ForegroundLiveShadowMessageClientInput,
  "normalizeContent" | "createIdempotencyKey" | "onHumanVerified"
> & Readonly<{
  api: ForegroundLiveShadowMessageClientInput["api"] & Pick<
    NautiloApiClient,
    | "planHumanPeerLiveShadowAcknowledgement"
    | "acknowledgeHumanPeerLiveShadowMessage"
  >;
}>;

export function createForegroundHumanPeerLiveShadowMessageReceiver(
  platform: ForegroundShadowClientPlatform,
  input: ForegroundHumanPeerLiveShadowMessageReceiverInput,
): VaultHumanPeerLiveShadowMessageReceiver {
  const crypto = input.crypto ?? new LatticeCrypto();
  const clientIdentity = identity(platform, crypto, input);
  const profileVault = platform.createProfileVault();
  const now = input.now ?? Date.now;
  const authority = namespaceAuthority(platform, {
    api: input.api,
    crypto,
    vault: profileVault,
    coordinates: clientIdentity.coordinates,
    now,
    createId: () => platform.createId(),
    ...(input.onProtectedRoomAccessState === undefined
      ? {}
      : { onProtectedRoomAccessState: input.onProtectedRoomAccessState }),
  });
  return createVaultHumanPeerLiveShadowMessageReceiver({
    crypto,
    vault: profileVault,
    coordinates: clientIdentity.coordinates,
    namespaceAuthority: authority,
    api: {
      planHumanPeerLiveShadowAcknowledgement: async (request) =>
        input.api.planHumanPeerLiveShadowAcknowledgement(
          request.roomId,
          request.operationId,
          {
            requestVersion: 1,
            operationId: request.operationId,
            clientDeviceId: request.clientDeviceId,
          },
        ),
      acknowledgeHumanPeerLiveShadowMessage: async (request) => {
        const response = await input.api.acknowledgeHumanPeerLiveShadowMessage(
          request.roomId,
          request.operationId,
          {
            requestVersion: 1,
            operationId: request.operationId,
            acknowledgementBytesBase64url: request.acknowledgementBytesBase64url,
          },
        );
        return response.status;
      },
    },
    now,
  });
}

export type ForegroundSharedAgentLiveShadowMessageReceiverInput = Omit<
  ForegroundLiveShadowMessageClientInput,
  "normalizeContent" | "createIdempotencyKey" | "onHumanVerified"
> & Readonly<{
  api: ForegroundLiveShadowMessageClientInput["api"] & Pick<
    NautiloApiClient,
    | "planSharedAgentLiveShadowAcknowledgement"
    | "acknowledgeSharedAgentLiveShadowMessage"
  >;
}>;

export function createForegroundSharedAgentLiveShadowMessageReceiver(
  platform: ForegroundShadowClientPlatform,
  input: ForegroundSharedAgentLiveShadowMessageReceiverInput,
): VaultSharedAgentLiveShadowMessageReceiver {
  const crypto = input.crypto ?? new LatticeCrypto();
  const clientIdentity = identity(platform, crypto, input);
  const profileVault = platform.createProfileVault();
  const now = input.now ?? Date.now;
  const authority = namespaceAuthority(platform, {
    api: input.api,
    crypto,
    vault: profileVault,
    coordinates: clientIdentity.coordinates,
    now,
    createId: () => platform.createId(),
    ...(input.onProtectedRoomAccessState === undefined
      ? {}
      : { onProtectedRoomAccessState: input.onProtectedRoomAccessState }),
  });
  return createVaultSharedAgentLiveShadowMessageReceiver({
    crypto,
    vault: profileVault,
    coordinates: clientIdentity.coordinates,
    namespaceAuthority: authority,
    api: {
      planSharedAgentLiveShadowAcknowledgement: async (request) =>
        input.api.planSharedAgentLiveShadowAcknowledgement(
          request.roomId,
          request.operationId,
          {
            requestVersion: 1,
            operationId: request.operationId,
            clientDeviceId: request.clientDeviceId,
          },
        ),
      acknowledgeSharedAgentLiveShadowMessage: async (request) => {
        const response = await input.api.acknowledgeSharedAgentLiveShadowMessage(
          request.roomId,
          request.operationId,
          {
            requestVersion: 1,
            operationId: request.operationId,
            acknowledgementBytesBase64url: request.acknowledgementBytesBase64url,
          },
        );
        return response.status;
      },
    },
    now,
  });
}

export type ForegroundSharedAgentOutputLiveShadowReceiverInput = Omit<
  ForegroundLiveShadowMessageClientInput,
  "normalizeContent" | "createIdempotencyKey" | "onHumanVerified"
> & Readonly<{
  api: ForegroundLiveShadowMessageClientInput["api"] & Pick<
    NautiloApiClient,
    "planSharedAgentOutputRead" | "acknowledgeSharedAgentOutput"
  >;
}>;

export function createForegroundSharedAgentOutputLiveShadowReceiver(
  platform: ForegroundShadowClientPlatform,
  input: ForegroundSharedAgentOutputLiveShadowReceiverInput,
): VaultSharedAgentOutputLiveShadowReceiver {
  const crypto = input.crypto ?? new LatticeCrypto();
  const clientIdentity = identity(platform, crypto, input);
  const profileVault = platform.createProfileVault();
  const now = input.now ?? Date.now;
  const authority = namespaceAuthority(platform, {
    api: input.api,
    crypto,
    vault: profileVault,
    coordinates: clientIdentity.coordinates,
    now,
    createId: () => platform.createId(),
    ...(input.onProtectedRoomAccessState === undefined
      ? {}
      : { onProtectedRoomAccessState: input.onProtectedRoomAccessState }),
  });
  return createVaultSharedAgentOutputLiveShadowReceiver({
    crypto,
    vault: profileVault,
    coordinates: clientIdentity.coordinates,
    namespaceAuthority: authority,
    api: {
      planSharedAgentOutputRead: (request) => input.api.planSharedAgentOutputRead(
        request.roomId,
        request.executionId,
        {
          requestVersion: 1,
          operationId: request.executionId,
          clientDeviceId: request.clientDeviceId,
        },
      ),
      acknowledgeSharedAgentOutput: async (request) => {
        const response = await input.api.acknowledgeSharedAgentOutput(
          request.roomId,
          request.executionId,
          {
            requestVersion: 1,
            operationId: request.executionId,
            acknowledgementBytesBase64url: request.acknowledgementBytesBase64url,
          },
        );
        return response.status;
      },
    },
    now,
  });
}

export type ForegroundRoomHistoryShadowMessageReaderInput = Omit<
  ForegroundLiveShadowMessageClientInput,
  "api" | "normalizeContent" | "onHumanVerified" | "onDurableRecovery"
> & Readonly<{
  api: ForegroundLiveShadowMessageClientInput["api"] & Pick<
    NautiloApiClient,
    "acknowledgeRoomHistoryShadowRead"
  >;
  resolveTrustedDeviceSigningPublicKey?: (input: Readonly<{
    deviceId: string;
    hostAuthorizationRevision: number;
    trustedDeviceRevision: number;
  }>) => Promise<Uint8Array | null>;
  onHistoryVerificationDiagnostic?: NonNullable<Parameters<
    typeof createVaultRoomHistoryShadowMessageReader
  >[0]["onDiagnostic"]>;
}>;

export interface ForegroundRoomHistoryShadowAcknowledgementInput {
  readonly roomId: string;
  readonly operationId: string;
  readonly clientRequestKey: string;
  readonly policyRevision: number;
  readonly subjectHumanId: string;
  readonly readerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: number;
  readonly selectedCoordinateDigestBase64url: string;
  readonly selectedCoordinates: readonly (Omit<HumanHistoryReadSelectedCoordinate, "role"> &
    Readonly<{ role: "user" | "assistant" | "tool" | "system" }>)[];
  readonly eligibleCoordinates: readonly (Omit<HumanHistoryReadSelectedCoordinate, "role"> &
    Readonly<{ role: "user" | "assistant" | "tool" | "system" }>)[];
  readonly eligibleRecords: readonly RoomHistoryShadowRecordTransportV1[];
  readonly allowOrdinaryRepairs: boolean;
  readonly acknowledgement:
    | Readonly<{
      status: "required";
      tokenBase64url: string;
      issuedAt: string;
      expiresAt: string;
    }>
    | Readonly<{ status: "already_recorded" }>;
  readonly result: VaultRoomHistoryShadowReadResultV1;
  readonly signal?: AbortSignal;
}

export interface ForegroundRoomHistoryShadowMessageReader
  extends VaultRoomHistoryShadowMessageReader {
  readonly readerDeviceId: string;
  acknowledge(
    input: ForegroundRoomHistoryShadowAcknowledgementInput,
  ): Promise<"accepted" | "replayed" | "already_recorded">;
}

export type ForegroundMessageBackfillClientInput = ForegroundRoomHistoryShadowMessageReaderInput & Readonly<{
  api: ForegroundRoomHistoryShadowMessageReaderInput["api"] & DeviceMessageBackfillApiPort;
  dataOperationOwner: EncryptionDataOperationOwner;
}>;

/** Both supported clients use the same vault-owned repair implementation. */
export function createForegroundMessageBackfillClient(
  platform: ForegroundShadowClientPlatform, input: ForegroundMessageBackfillClientInput,
) {
  const crypto = input.crypto ?? new LatticeCrypto();
  const clientIdentity = identity(platform, crypto, input);
  const vault = platform.createProfileVault();
  const now = input.now ?? Date.now;
  const createId = input.createIdempotencyKey ?? (() => platform.createId());
  const clients = authorityClients(platform, {api: input.api, crypto, vault,
    coordinates: clientIdentity.coordinates, now, createId,
    ...(input.onProtectedRoomAccessState === undefined ? {} : {onProtectedRoomAccessState: input.onProtectedRoomAccessState})});
  if (clients.namespaceAuthority === undefined) throw new TypeError("Message repair namespace authority is unavailable");
  return createDeviceMessageBackfillClient({owner: input.dataOperationOwner, api: input.api,
    namespaceAuthority: clients.namespaceAuthority, vault, coordinates: clientIdentity.coordinates, crypto,
    historyReader: createForegroundRoomHistoryShadowMessageReader(platform, input), now, createId});
}

function bytesFromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("Room history digest is not canonical base64url");
  }
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")
      + "=".repeat((4 - value.length % 4) % 4)),
    (character) => character.charCodeAt(0),
  );
}

function bytesToBase64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function historyResultCounts(
  result: VaultRoomHistoryShadowReadResultV1,
): HumanHistoryReadResultCounts {
  return Object.freeze({
    verified: result.verifiedCount,
    clientCryptoUnavailable: result.fallbackCounts.client_crypto_unavailable ?? 0,
    clientCustodyUnavailable: result.fallbackCounts.client_custody_unavailable ?? 0,
    currentReadAuthorityUnavailable:
      result.fallbackCounts.current_read_authority_unavailable ?? 0,
    retainedKeyMaterialUnavailable:
      result.fallbackCounts.retained_key_material_unavailable ?? 0,
    signerEvidenceUnavailable:
      result.fallbackCounts.signer_evidence_unavailable ?? 0,
    liveShadowLifecycleUnavailable:
      result.fallbackCounts.live_shadow_lifecycle_unavailable ?? 0,
    integrityFailure: result.fallbackCounts.integrity_failure ?? 0,
    parityMismatch: result.fallbackCounts.parity_mismatch ?? 0,
  });
}

function historyOutcome(reason: RoomHistoryShadowFallbackReasonV1): Readonly<{
  outcome: "unavailable" | "failed";
  reason: RoomHistoryShadowFallbackReasonV1;
}> {
  return Object.freeze({
    outcome: reason === "integrity_failure" || reason === "parity_mismatch"
      ? "failed"
      : "unavailable",
    reason,
  });
}

export function createForegroundRoomHistoryShadowMessageReader(
  platform: ForegroundShadowClientPlatform,
  input: ForegroundRoomHistoryShadowMessageReaderInput,
): ForegroundRoomHistoryShadowMessageReader {
  const crypto = input.crypto ?? new LatticeCrypto();
  const clientIdentity = identity(platform, crypto, input);
  const vault = platform.createProfileVault();
  const now = input.now ?? Date.now;
  const createId = input.createIdempotencyKey ?? (() => platform.createId());
  const clients = authorityClients(platform, {
    api: input.api,
    crypto,
    vault,
    coordinates: clientIdentity.coordinates,
    now,
    createId,
    ...(input.onProtectedRoomAccessState === undefined
      ? {}
      : { onProtectedRoomAccessState: input.onProtectedRoomAccessState }),
  });
  if (
    clients.namespaceAuthority === undefined
    || clients.namespaceV2 === undefined
  ) throw new TypeError("Domain Key V2 history authority is unavailable");
  const namespace = clients.namespaceAuthority;
  const authority = createDomainNamespaceHistoryAuthorityAdapterV2({
    namespaceAuthority: clients.namespaceV2,
  });
  const reader = createVaultRoomHistoryShadowMessageReader({
    crypto,
    vault,
    coordinates: clientIdentity.coordinates,
    authority,
    namespaceAuthority: namespace,
    resolveTrustedDeviceSigningPublicKey:
      input.resolveTrustedDeviceSigningPublicKey ?? (() => Promise.resolve(null)),
    createProfileStageId: createId,
    ...(input.onHistoryVerificationDiagnostic === undefined ? {} : {
      onDiagnostic: input.onHistoryVerificationDiagnostic,
    }),
  });
  const acknowledge = async (
    acknowledgementInput: ForegroundRoomHistoryShadowAcknowledgementInput,
  ): Promise<"accepted" | "replayed" | "already_recorded"> => {
    if (acknowledgementInput.acknowledgement.status === "already_recorded") {
      return "already_recorded";
    }
    const admission = acknowledgementInput.acknowledgement;
    if (
      acknowledgementInput.result.records.length
        !== acknowledgementInput.eligibleCoordinates.length
      || acknowledgementInput.result.eligibleCount
        !== acknowledgementInput.eligibleCoordinates.length
    ) throw new TypeError("Room history acknowledgement result set is incomplete");

    const selectedDigest = bytesFromBase64url(
      acknowledgementInput.selectedCoordinateDigestBase64url,
    );
    const computedSelection = humanHistoryReadSelectedCoordinateDigest(
      crypto,
      acknowledgementInput.selectedCoordinates,
    );
    let orderedResultSetDigest: Uint8Array | undefined;
    try {
      if (
        selectedDigest.length !== computedSelection.length
        || !selectedDigest.every((byte, index) => byte === computedSelection[index])
      ) throw new TypeError("Room history selected page digest disagrees");
      const entries = acknowledgementInput.result.records.map((result, index) => {
        const coordinate = acknowledgementInput.eligibleCoordinates[index]!;
        if (
          result.sessionId !== coordinate.sessionId
          || Number(result.messageId) !== coordinate.messageId
          || result.editRevision !== coordinate.editRevision
        ) throw new TypeError("Room history acknowledgement order disagrees");
        const coordinateDigest = humanHistoryReadSelectedCoordinateDigest(
          crypto,
          [coordinate],
        );
        return Object.freeze({
          coordinateDigest,
          ...(result.status === "verified"
            ? { outcome: "verified" as const, reason: "none" as const }
            : historyOutcome(result.reason)),
        });
      });
      try {
        orderedResultSetDigest = humanHistoryReadResultSetDigest(crypto, entries);
      } finally {
        entries.forEach((entry) => entry.coordinateDigest.fill(0));
      }

      const available = await vault.availability();
      if (
        available.status !== "available"
        && (await vault.unlock()).status !== "available"
      ) {
        const response = await input.api.acknowledgeRoomHistoryShadowRead(
          acknowledgementInput.roomId,
          {
            requestVersion: 1,
            status: "client_unavailable",
            operationId: acknowledgementInput.operationId,
            tokenBase64url: admission.tokenBase64url,
            reason: "client_custody_unavailable",
          },
          acknowledgementInput.signal === undefined
            ? undefined
            : {signal: acknowledgementInput.signal},
        );
        return response.status;
      }
      return await vault.withOpenProfile(
        clientIdentity.coordinates,
        async (profileBytes) => {
          const profile = await authenticateClientDeviceProfileV4({
            crypto,
            profileBytes,
            expectedDeviceId: clientIdentity.coordinates.deviceId,
          });
          try {
            const base = profile.baseProfile.baseProfile;
            if (orderedResultSetDigest === undefined) {
              throw new TypeError("Room history result digest is unavailable");
            }
            const prepared = prepareHumanHistoryReadAcknowledgement(crypto, {
              operationId: acknowledgementInput.operationId,
              clientRequestKey: acknowledgementInput.clientRequestKey,
              policyRevision: acknowledgementInput.policyRevision,
              subjectHumanId: humanId(acknowledgementInput.subjectHumanId),
              readerDeviceId: cryptoDeviceId(clientIdentity.coordinates.deviceId),
              readerDeviceSigningKeyGeneration:
                acknowledgementInput.readerDeviceSigningKeyGeneration,
              hostAuthorizationRevision: authorizationRevision(
                acknowledgementInput.hostAuthorizationRevision,
              ),
              roomId: acknowledgementInput.roomId,
              selectedCoordinateDigest: selectedDigest,
              eligibleCount: acknowledgementInput.result.eligibleCount,
              resultCounts: historyResultCounts(acknowledgementInput.result),
              orderedResultSetDigest,
              issuedAt: unixTimestamp(Date.parse(admission.issuedAt)),
              deadlineAt: unixTimestamp(Date.parse(admission.expiresAt)),
              readerSigningPublicKey: base.signingPublicKey,
              readerSigningPrivateKey: base.signingPrivateKey,
            });
            try {
              const ordinaryRepairs = acknowledgementInput.result.records.flatMap(
                (result, index) => {
                  const record = acknowledgementInput.eligibleRecords[index];
                  if (!acknowledgementInput.allowOrdinaryRepairs
                    || result.status !== "verified"
                    || result.verification !== "signed_representation_authenticated"
                    || record === undefined
                    || record.representationMode !== "protected-only"
                    || record.protectedMessage.protectedPayload.status !== "encrypted") return [];
                  const retained = record.kind === "existing_representation"
                    ? record.retainedGeneration
                    : { namespaceGeneration: record.namespaceGeneration, accessRevision: record.namespaceAccessRevision };
                  if (retained === undefined) return [];
                  const attestation = prepareHumanDeviceOrdinaryRepairAttestationV3(crypto, {
                    keyClass: record.protectedMessage.protectedPayload.keyClass,
                    operationId: acknowledgementInput.operationId,
                    policyRevision: acknowledgementInput.policyRevision,
                    subjectHumanId: acknowledgementInput.subjectHumanId,
                    readerDeviceId: clientIdentity.coordinates.deviceId,
                    readerDeviceSigningKeyGeneration: acknowledgementInput.readerDeviceSigningKeyGeneration,
                    hostAuthorizationRevision: acknowledgementInput.hostAuthorizationRevision,
                    roomId: acknowledgementInput.roomId,
                    namespaceId: record.protectedMessage.projection.namespaceId,
                    namespaceAccessRevision: retained.accessRevision,
                    namespaceKeyGeneration: retained.namespaceGeneration,
                    sessionId: result.sessionId,
                    messageId: Number(result.messageId),
                    editRevision: result.editRevision,
                    cryptoObjectId: record.protectedMessage.protectedPayload.cryptoObjectId,
                    authorRole: record.protectedMessage.projection.role,
                    createdAt: Date.parse(record.protectedMessage.projection.createdAt),
                    issuedAt: Date.parse(admission.issuedAt),
                    deadlineAt: Date.parse(admission.expiresAt),
                    payload: result.payload,
                    signingPrivateKey: base.signingPrivateKey,
                  });
                  const payloadBytes = encodeMessagePayloadV2(result.payload);
                  const { payloadDigest, signature, ...coordinates } = attestation;
                  const transport = Object.freeze({
                    ...coordinates,
                    payloadDigestBase64url: bytesToBase64url(payloadDigest),
                    payloadBytesBase64url: bytesToBase64url(payloadBytes),
                    signatureBase64url: bytesToBase64url(signature),
                  });
                  payloadBytes.fill(0); payloadDigest.fill(0); signature.fill(0);
                  return [transport];
                },
              );
              const response = await input.api.acknowledgeRoomHistoryShadowRead(
                acknowledgementInput.roomId,
                ordinaryRepairs.length === 0 ? {
                  requestVersion: 1,
                  status: "signed",
                  operationId: acknowledgementInput.operationId,
                  tokenBase64url: admission.tokenBase64url,
                  acknowledgementBytesBase64url: bytesToBase64url(prepared.bytes),
                } : {
                  requestVersion: 2,
                  status: "signed_with_ordinary_repairs",
                  operationId: acknowledgementInput.operationId,
                  tokenBase64url: admission.tokenBase64url,
                  acknowledgementBytesBase64url: bytesToBase64url(prepared.bytes),
                  selectedCoordinates: [...acknowledgementInput.selectedCoordinates],
                  ordinaryRepairs,
                },
                acknowledgementInput.signal === undefined
                  ? undefined
                  : {signal: acknowledgementInput.signal},
              );
              return response.status;
            } finally {
              prepared.acknowledgement.selectedCoordinateDigest.fill(0);
              prepared.acknowledgement.orderedResultSetDigest.fill(0);
              prepared.acknowledgement.signature.fill(0);
              prepared.bytes.fill(0);
              prepared.acknowledgementDigest.fill(0);
            }
          } finally {
            destroyOpenedClientDeviceProfileV4(profile);
          }
        },
      );
    } finally {
      selectedDigest.fill(0);
      computedSelection.fill(0);
      orderedResultSetDigest?.fill(0);
    }
  };
  return Object.freeze({
    ...reader,
    readerDeviceId: clientIdentity.coordinates.deviceId,
    acknowledge,
  });
}
