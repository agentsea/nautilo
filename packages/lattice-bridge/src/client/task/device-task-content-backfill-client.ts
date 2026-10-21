import type {
  DeviceAdmissionStatus,
  TaskContentBackfillAckRequest,
  TaskContentBackfillAckResponse,
  TaskContentBackfillClaim,
  TaskContentBackfillClaimRequest,
  TaskContentBackfillClaimResponse,
  TaskContentBackfillDiscoverResponse,
  TaskContentBackfillOutcome,
  TaskContentBackfillPublicationPlan,
  TaskContentBackfillPublishRequest,
  TaskContentBackfillPublishResponse,
  TaskContentBackfillRecoverResponse,
  TaskContentBackfillReleaseRequest,
  TaskContentBackfillReleaseResponse,
  TaskContentBackfillSourceResponse,
} from "@nautilo/api-client/browser";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  encryptObjectPayload,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareHumanExistingTaskRepresentationPublicationRequest,
  prepareHumanObjectAccessManifestGenesisSet,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import { withClientNamespaceKeyring } from
  "../../device/client-namespace-keyring.ts";
import {
  deriveTaskHistoricalContentCryptoObjectIdV1,
} from "../../task/task-historical-content-identity.ts";
import {
  taskContentObjectTypeV1,
} from "../../task/task-content-repository.ts";
import {
  decodeTaskDefinitionContent,
  decodeTaskRunResultPayloadV1,
  encodeTaskDefinitionContent,
  encodeTaskRunResultPayloadV1,
} from "../../task/task-payload-v1.ts";
import {
  ClassifiedDataOperationError,
  classifyDataOperationFailure,
  type EncryptionDataOperationOwner,
} from "../../transition/encryption-data-operation-owner.ts";
import type { NamespaceAuthorityClient } from
  "../message/namespace-authority-client.ts";
import type { TaskContentBackfillBatchResult } from
  "./task-content-backfill-worker.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const PLAN_DIGEST_DOMAIN =
  "nautilo/task-content-backfill-publication-plan/v1\n";
const SIGNED_REQUEST_TTL_MS = 30_000;

// Historical repair has no ordinary publication fallback. Preserve the
// original classified failure for the lease state machine instead of allowing
// Shadow fallback to turn it into an inactive Plain callback.
const noOrdinaryFallback = (): "unknown" => "unknown";

export interface DeviceTaskContentBackfillApiPort {
  discoverTaskContentBackfill(options?: Readonly<{ signal?: AbortSignal }> ):
    Promise<TaskContentBackfillDiscoverResponse>;
  claimTaskContentBackfill(
    input: TaskContentBackfillClaimRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<TaskContentBackfillClaimResponse>;
  readTaskContentBackfillSource(
    input: Readonly<{ claimId: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<TaskContentBackfillSourceResponse>;
  publishTaskContentBackfill(
    input: TaskContentBackfillPublishRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<TaskContentBackfillPublishResponse>;
  recoverTaskContentBackfill(
    input: Readonly<{ claimId: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<TaskContentBackfillRecoverResponse>;
  releaseTaskContentBackfill(
    input: TaskContentBackfillReleaseRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<TaskContentBackfillReleaseResponse>;
  acknowledgeTaskContentBackfill(
    input: TaskContentBackfillAckRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<TaskContentBackfillAckResponse>;
}

function base64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function bytes(label: string, value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new ClassifiedDataOperationError(
      "integrity",
      `${label} is not canonical base64url`,
    );
  }
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  const result = Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  );
  if (base64url(result) !== value) {
    result.fill(0);
    throw new ClassifiedDataOperationError(
      "integrity",
      `${label} is not canonical base64url`,
    );
  }
  return result;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function fail(
  failureClass: ConstructorParameters<typeof ClassifiedDataOperationError>[0],
  message: string,
): never {
  throw new ClassifiedDataOperationError(failureClass, message);
}

const waiting = (resumeAt: number | null = null): TaskContentBackfillBatchResult =>
  Object.freeze({ state: "waiting" as const, resumeAt });

const more = (now: number): TaskContentBackfillBatchResult =>
  Object.freeze({ state: "more" as const, resumeAt: now });

function sameCandidate(
  claim: TaskContentBackfillClaim,
  plan: TaskContentBackfillPublicationPlan,
): boolean {
  const candidate = claim.candidate;
  const coordinate = plan.coordinate;
  return coordinate.taskId === candidate.taskId
    && coordinate.contentRevision === 1
    && (candidate.kind === "definition"
      ? coordinate.kind === "definition"
      : coordinate.kind === "run_result"
        && coordinate.taskRunId === candidate.taskRunId);
}

function planDigest(
  crypto: LatticeCrypto,
  plan: TaskContentBackfillPublicationPlan,
): Uint8Array {
  const { planDigestBase64url: _digest, expiresAt: _expiry, ...coordinates } = plan;
  return crypto.hash(new TextEncoder().encode(
    PLAN_DIGEST_DOMAIN + JSON.stringify(coordinates),
  ));
}

function canonicalPayload(
  source: Extract<TaskContentBackfillSourceResponse, { status: "source" }>,
  sourceBytes: Uint8Array,
): Uint8Array {
  try {
    if (source.plan.coordinate.kind !== "definition") {
      return encodeTaskRunResultPayloadV1(decodeTaskRunResultPayloadV1(sourceBytes));
    }
    const content = decodeTaskDefinitionContent(sourceBytes);
    return encodeTaskDefinitionContent(content.retainedHistoricalError === null
      ? content.payload
      : {
          formatVersion: 2,
          prompt: content.payload.prompt,
          expectedOutput: content.payload.expectedOutput,
          protectedMetadata: content.payload.protectedMetadata,
          retainedHistoricalError: content.retainedHistoricalError,
        });
  } catch (error) {
    throw new ClassifiedDataOperationError(
      "integrity",
      "Historical Task source payload is invalid",
      { cause: error },
    );
  }
}

type PreparedUpload = TaskContentBackfillPublishRequest;

/**
 * Current-device client for one sequential historical Task repair batch.
 * Plain and Full never discover work or open local custody.
 */
export function createDeviceTaskContentBackfillClient(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  api: DeviceTaskContentBackfillApiPort;
  namespaceAuthority: NamespaceAuthorityClient;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  crypto: LatticeCrypto;
  resolveDeviceAdmissionStatus(): Promise<DeviceAdmissionStatus>;
  now(): number;
}>) {
  const active = (
    claim: TaskContentBackfillClaim,
    signal: AbortSignal,
  ): void => {
    if (signal.aborted) fail("cancelled", "Task repair was cancelled");
    if (
      claim.humanActorId !== input.coordinates.humanActorId
      || claim.requesterUserId !== input.coordinates.userId
      || claim.deviceId !== input.coordinates.deviceId
      || claim.expiresAt <= input.now()
    ) fail("stale", "Task repair claim is no longer current");
  };

  const runShadow = <Value>(use: () => Promise<Value>): Promise<Value> =>
    input.owner.runMutation({
      ordinary: () => fail("stale", "Task repair is inactive in Plain mode"),
      protected: () => fail("stale", "Task repair is inactive in Full mode"),
      dual: use,
      classifyFailure: noOrdinaryFallback,
    });

  const release = async (
    claim: TaskContentBackfillClaim,
    signal: AbortSignal,
    advance = false,
  ): Promise<TaskContentBackfillBatchResult> => {
    active(claim, signal);
    const response = await runShadow(() => input.api.releaseTaskContentBackfill(
      { claimId: claim.claimId, advance },
      { signal },
    ));
    if (response.status !== "ready" || !response.value) return waiting();
    return advance ? more(input.now()) : waiting(claim.expiresAt);
  };

  const acknowledge = async (
    claim: TaskContentBackfillClaim,
    outcome: TaskContentBackfillOutcome,
    signal: AbortSignal,
  ): Promise<TaskContentBackfillBatchResult> => {
    active(claim, signal);
    const response = await runShadow(() => input.api.acknowledgeTaskContentBackfill(
      { claimId: claim.claimId, outcome },
      { signal },
    ));
    if (response.status !== "ready") return waiting();
    return response.value === "acknowledged"
      || response.value === "lease_lost"
      || response.value === "source_changed"
      ? more(input.now())
      : waiting();
  };

  const withProfile = async <Value>(
    claim: TaskContentBackfillClaim,
    signal: AbortSignal,
    use: (
      profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>,
      admission: Extract<DeviceAdmissionStatus, { status: "admitted" }>,
    ) => Promise<Value>,
  ): Promise<Value> => {
    active(claim, signal);
    let availability = await input.vault.availability();
    if (availability.status === "locked") {
      availability = await input.vault.unlock();
    }
    if (availability.status !== "available") {
      fail("key_waiting", "Task repair device custody is unavailable");
    }
    const admission = await input.resolveDeviceAdmissionStatus();
    if (
      admission.status !== "admitted"
      || admission.deviceId !== input.coordinates.deviceId
      || admission.expiresAt <= input.now()
    ) fail("key_waiting", "Task repair device admission is unavailable");
    active(claim, signal);
    return input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
      const profile = await authenticateClientDeviceProfileV4({
        crypto: input.crypto,
        profileBytes,
        expectedDeviceId: input.coordinates.deviceId,
      });
      try {
        active(claim, signal);
        return await use(profile, admission);
      } finally {
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });
  };

  const prepare = async (
    claim: TaskContentBackfillClaim,
    source: Extract<TaskContentBackfillSourceResponse, { status: "source" }>,
    signal: AbortSignal,
  ): Promise<PreparedUpload> => {
    active(claim, signal);
    const plan = source.plan;
    if (
      plan.claimId !== claim.claimId
      || plan.requesterHumanId !== claim.humanActorId
      || plan.deviceId !== claim.deviceId
      || plan.expectedPolicyRevision !== claim.policyRevision
      || plan.expectedAccessRevision < 0
      || plan.expiresAt > claim.expiresAt
      || plan.expiresAt <= input.now()
      || !sameCandidate(claim, plan)
    ) fail("stale", "Task repair plan does not match the current claim");

    const sourceBytes = bytes("Historical Task source payload", source.payloadBytesBase64url);
    const sourceDigest = bytes("Historical Task source digest", plan.sourceDigestBase64url);
    const sourcePayloadHash = bytes(
      "Historical Task source payload hash",
      plan.sourcePayloadHashBase64url,
    );
    const expectedPlanDigest = bytes(
      "Historical Task plan digest",
      plan.planDigestBase64url,
    );
    const bindingHash = bytes(
      "Historical Task Namespace binding hash",
      plan.bindingHashBase64url,
    );
    const operationalFieldsDigest = bytes(
      "Historical Task operational fields digest",
      plan.operationalFieldsDigestBase64url,
    );
    let canonical: Uint8Array | undefined;
    try {
      canonical = canonicalPayload(source, sourceBytes);
      if (
        !equal(canonical, sourceBytes)
        || !equal(input.crypto.hash(sourceBytes), sourcePayloadHash)
        || !equal(planDigest(input.crypto, plan), expectedPlanDigest)
        || deriveTaskHistoricalContentCryptoObjectIdV1({
          coordinate: plan.coordinate,
          sourceDigest,
          namespaceId: plan.namespaceId,
        }) !== plan.objectId
      ) fail("integrity", "Historical Task source proof is inconsistent");

      const ensured = await input.namespaceAuthority.ensure({
        sourceRoomId: source.sourceRoomId,
        namespaceId: plan.namespaceId,
        operationId: plan.operationId,
        idempotencyKey: plan.operationId,
        keyClass: "ai",
        signal,
      });
      if (ensured.status !== "ready") {
        fail("key_waiting", "Task repair Namespace authority is unavailable");
      }
      active(claim, signal);

      return await withProfile(claim, signal, async (profileV4, admission) => {
        const profile = profileV4.baseProfile.baseProfile;
        if (
          profile.deviceId !== claim.deviceId
          || profile.trustedHostAuthorizationRevision
            !== plan.hostAuthorizationRevision
        ) fail("stale", "Task repair device authority changed");

        let dek: Uint8Array | undefined;
        let payloadBytes: Uint8Array | undefined;
        let envelopeBytes: Uint8Array | undefined;
        let manifestBytes: Uint8Array | undefined;
        let requestBytes: Uint8Array | undefined;
        try {
          const encrypted = encryptObjectPayload(input.crypto, {
            objectId: objectId(plan.objectId),
            keyClass: "ai",
            objectType: taskContentObjectTypeV1(plan.coordinate),
            createdAt: unixTimestamp(input.now()),
          }, sourceBytes);
          dek = encrypted.dek;
          payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
          try {
            envelopeBytes = await withClientNamespaceKeyring({
              profile,
              namespaceId: plan.namespaceId,
              keyClass: "ai",
              requiredAccessRevision: plan.expectedAccessRevision,
              requiredGeneration: plan.keyGeneration,
              signal,
              operation: (keyring) => {
                if (keyring.domainId !== plan.domainId) {
                  return fail("stale", "Task repair Namespace Domain changed");
                }
                if (keyring.accessRevision !== plan.expectedAccessRevision) {
                  return fail("stale", "Task repair Namespace access changed");
                }
                if (keyring.currentGeneration !== plan.keyGeneration) {
                  return fail("stale", "Task repair Namespace generation changed");
                }
                if (!equal(keyring.bindingHash, bindingHash)) {
                  return fail("stale", "Task repair Namespace binding changed");
                }
                const generation = keyring.generations.find(
                  (entry) => entry.generation === plan.keyGeneration,
                );
                if (generation === undefined) {
                  return fail("key_waiting", "Task repair Namespace key is unavailable");
                }
                return encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
                  input.crypto,
                  generation.key,
                  {
                    objectId: objectId(plan.objectId),
                    namespaceId: namespaceId(plan.namespaceId),
                    keyClass: "ai",
                    keyGeneration: namespaceGeneration(generation.generation),
                    bindingRevisionAtWrap: accessRevision(keyring.accessRevision),
                  },
                  dek!,
                ));
              },
            });
          } catch (error) {
            if (error instanceof ClassifiedDataOperationError) throw error;
            throw new ClassifiedDataOperationError(
              "key_waiting",
              "Task repair Namespace key is unavailable",
              { cause: error },
            );
          }
          const access = prepareHumanObjectAccessManifestGenesisSet(
            input.crypto,
            {
              objectId: objectId(plan.objectId),
              payloadHash: input.crypto.hash(payloadBytes),
              envelopeBytes: [envelopeBytes],
              sourceAuthorized: true,
              targetAuthorized: true,
              subjectHumanId: humanId(plan.requesterHumanId),
              committerDeviceId: cryptoDeviceId(profile.deviceId),
              hostAuthorizationRevision: authorizationRevision(
                profile.trustedHostAuthorizationRevision,
              ),
              committerSigningPublicKey: profile.signingPublicKey,
              committerSigningPrivateKey: profile.signingPrivateKey,
            },
          );
          manifestBytes = access.manifestBytes;
          const issuedAt = input.now();
          const deadlineAt = Math.min(
            issuedAt + SIGNED_REQUEST_TTL_MS,
            plan.expiresAt,
            claim.expiresAt,
            admission.expiresAt,
          );
          if (deadlineAt <= issuedAt) {
            return fail("stale", "Task repair signing window expired");
          }
          const signed = prepareHumanExistingTaskRepresentationPublicationRequest(
            input.crypto,
            {
              kind: plan.coordinate.kind,
              entityId: plan.coordinate.kind === "definition"
                ? plan.coordinate.taskId
                : plan.coordinate.taskRunId,
              claimId: claim.claimId,
              sourceDigest,
              sourcePayloadHash,
              operationId: plan.operationId,
              taskId: plan.coordinate.taskId,
              cryptoObjectId: plan.objectId,
              expectedContentRevision: 0,
              nextContentRevision: 1,
              expectedCryptoAccessRevision: 0,
              resultCryptoAccessRevision: 0,
              planDigest: expectedPlanDigest,
              operationalFieldsDigest,
              subjectHumanId: plan.requesterHumanId,
              committerDeviceId: profile.deviceId,
              hostAuthorizationRevision: profile.trustedHostAuthorizationRevision,
              namespaceId: plan.namespaceId,
              domainId: plan.domainId,
              expectedNamespaceAccessRevision: plan.expectedAccessRevision,
              expectedPolicyRevision: plan.expectedPolicyRevision,
              bindingHash,
              keyGeneration: plan.keyGeneration,
              payloadHash: input.crypto.hash(payloadBytes),
              manifestHash: input.crypto.hash(manifestBytes),
              envelopeHash: input.crypto.hash(envelopeBytes),
              issuedAt: unixTimestamp(issuedAt),
              deadlineAt: unixTimestamp(deadlineAt),
              committerSigningPublicKey: profile.signingPublicKey,
              committerSigningPrivateKey: profile.signingPrivateKey,
            },
          );
          requestBytes = signed.bytes;
          active(claim, signal);
          return Object.freeze({
            claimId: claim.claimId,
            requestBytesBase64url: base64url(requestBytes),
            payloadBytesBase64url: base64url(payloadBytes),
            manifestBytesBase64url: base64url(manifestBytes),
            envelopeBytesBase64url: base64url(envelopeBytes),
          });
        } finally {
          dek?.fill(0);
          payloadBytes?.fill(0);
          envelopeBytes?.fill(0);
          manifestBytes?.fill(0);
          requestBytes?.fill(0);
        }
      });
    } finally {
      sourceBytes.fill(0);
      sourceDigest.fill(0);
      sourcePayloadHash.fill(0);
      expectedPlanDigest.fill(0);
      bindingHash.fill(0);
      operationalFieldsDigest.fill(0);
      canonical?.fill(0);
    }
  };

  const retry = (claim?: TaskContentBackfillClaim): TaskContentBackfillBatchResult =>
    claim !== undefined && claim.expiresAt > input.now()
      ? waiting(claim.expiresAt)
      : more(input.now());

  const processClaim = async (
    claim: TaskContentBackfillClaim,
    signal: AbortSignal,
  ): Promise<TaskContentBackfillBatchResult> => {
    active(claim, signal);
    const recovery = await runShadow(() => input.api.recoverTaskContentBackfill(
      { claimId: claim.claimId },
      { signal },
    ));
    active(claim, signal);
    if (recovery.status === "inactive") return waiting();
    if (recovery.status === "mapped") {
      return acknowledge(claim, "mapped", signal);
    }
    if (recovery.status === "stale") return retry(claim);
    if (recovery.status === "waiting_for_authority") {
      return release(claim, signal);
    }
    if (recovery.status === "integrity") {
      return acknowledge(claim, "integrity", signal);
    }

    // `pending` means either no durable stage yet or a stage whose product
    // mapping is still unavailable. The publish endpoint adopts the latter
    // without comparing newly randomized ciphertext, so source preparation is
    // safe and gives an unstaged claim its only forward path.
    const source = await runShadow(() => input.api.readTaskContentBackfillSource(
      { claimId: claim.claimId },
      { signal },
    ));
    active(claim, signal);
    if (source.status === "inactive") return waiting();
    if (source.status === "stale") return retry(claim);
    if (source.status === "waiting_for_authority") {
      return release(claim, signal);
    }
    if (source.status === "unsupported"
      || source.status === "no_content"
      || source.status === "waiting_parent"
      || source.status === "integrity") {
      return acknowledge(claim, source.status, signal);
    }
    if (source.status !== "source") {
      return fail("integrity", "Task repair source response is invalid");
    }

    const upload = await prepare(claim, source, signal);
    active(claim, signal);
    const published = await runShadow(() => input.api.publishTaskContentBackfill(
      upload,
      { signal },
    ));
    active(claim, signal);
    if (published.status === "inactive") return waiting();
    if (published.status === "stale") return retry(claim);
    if (published.status === "waiting_for_authority") {
      return release(claim, signal);
    }
    if (published.status === "integrity") {
      return acknowledge(claim, "integrity", signal);
    }
    const mapped = await runShadow(() => input.api.recoverTaskContentBackfill(
      { claimId: claim.claimId },
      { signal },
    ));
    active(claim, signal);
    if (mapped.status === "inactive") return waiting();
    if (mapped.status === "mapped") return acknowledge(claim, "mapped", signal);
    if (mapped.status === "integrity") {
      return acknowledge(claim, "integrity", signal);
    }
    return mapped.status === "stale" ? retry(claim) : release(claim, signal);
  };

  return Object.freeze({
    async runBatch(
      { signal }: Readonly<{ signal: AbortSignal }>,
    ): Promise<TaskContentBackfillBatchResult> {
      let claim: TaskContentBackfillClaim | undefined;
      try {
        return await input.owner.runMutation({
          ordinary: () => Promise.resolve(waiting()),
          protected: () => Promise.resolve(waiting()),
          classifyFailure: noOrdinaryFallback,
          dual: async () => {
            if (signal.aborted) return waiting();
            const discovered = await input.api.discoverTaskContentBackfill({ signal });
            if (signal.aborted || discovered.status !== "ready") return waiting();
            const value = discovered.value;
            if (value.status === "disabled" || value.status === "full_wait") {
              return waiting();
            }
            if (value.status === "waiting") return waiting(value.resumeAt);
            if (value.status === "swept") {
              return Object.freeze({
                state: "caught_up" as const,
                resumeAt: value.resumeAt,
              });
            }
            if (value.status === "more") return more(input.now());
            if (value.status === "claimed") claim = value.claim;
            else {
              if (value.status !== "candidate") {
                return fail("integrity", "Task repair discovery response is invalid");
              }
              const claimed = await input.api.claimTaskContentBackfill({
                candidate: value.candidate,
                policyRevision: value.policyRevision,
              }, { signal });
              if (signal.aborted || claimed.status !== "ready") return waiting();
              if (claimed.value.status !== "claimed") {
                return claimed.value.status === "held"
                  ? waiting()
                  : more(input.now());
              }
              claim = claimed.value.claim;
            }
            return processClaim(claim, signal);
          },
        });
      } catch (error) {
        if (signal.aborted) return waiting();
        const failure = classifyDataOperationFailure(error);
        if (failure === "unknown") throw error;
        if (claim === undefined || failure === "cancelled") return waiting();
        if (failure === "stale") return retry(claim);
        if (failure === "integrity" || failure === "unsupported") {
          return acknowledge(
            claim,
            failure === "integrity" ? "integrity" : "unsupported",
            signal,
          );
        }
        return release(claim, signal);
      }
    },
  });
}
