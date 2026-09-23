import { prepareVaultHumanMessageEdit } from "./vault-human-message-edit.ts";
import { isRoomPendingAttentionEventForViewer } from "@nautilo/api-client/browser";
import type {
  LiveShadowMessagePreparedRequestV1,
  FullEncryptionMessagePreparedRequestV2,
  LiveShadowMessageSendAttemptV1,
  NautiloApiClient,
  RoomPendingAttentionChallenge,
  RoomPendingAttentionPageResponse,
} from "@nautilo/api-client/browser";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  decodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  decodeLiveShadowMessagePlanV4,
  decodeHumanPeerLiveShadowMessagePlanV1,
  decodeSharedAgentLiveShadowMessagePlanV1,
  destroyDomainForegroundAuthorizationPlanV2,
  deriveHumanMessageEditCryptoObjectIdV1,
  parseDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import {
  parseLiveShadowMessageRealtimeEventV1,
  type ProtectedMessageDtoV2,
  type ServerEvent,
} from "@nautilo/types";

import type { ClientProfileCoordinates, ClientProfileVault } from
  "../../client-vault/types.ts";
import { decodeMessagePayloadV2, encodeMessagePayloadV2 } from
  "../../message/message-payload-v2.ts";
import {
  prepareVaultHumanLiveShadowMessageV4,
} from
  "./vault-human-live-shadow-message.ts";
import { prepareVaultHumanPeerLiveShadowMessage } from
  "./vault-human-peer-live-shadow-message.ts";
import { prepareVaultSharedAgentLiveShadowMessage } from
  "./vault-shared-agent-live-shadow-message.ts";
import { prepareVaultHumanAiReadableLiveShadowMessage } from
  "./vault-human-ai-readable-live-shadow-message.ts";
import { prepareVaultRuntimeForegroundAuthorization } from
  "./vault-runtime-foreground-authorization.ts";
import type { NamespaceAuthorityClient } from
  "./namespace-authority-client.ts";
import type { DomainForegroundAuthorityClientV2 } from
  "./domain-foreground-authority-client.ts";
import type { createPreparedMutationJournal } from
  "../memory/prepared-mutation-journal.ts";
import { PREPARED_MUTATION_JOURNAL_LIMITS } from
  "../memory/prepared-mutation-journal-limits.ts";
import { isOwnedHumanPublication, matchesHumanPublicationReceipt } from
  "./live-shadow-human-publication-receipt.ts";

type RoomSendBody = Parameters<NautiloApiClient["sendRoomMessage"]>[1];
type RoomSendResult = Awaited<ReturnType<NautiloApiClient["sendRoomMessage"]>>;
type PreparedJournal = ReturnType<typeof createPreparedMutationJournal>;

// A Grant-Domain plan deliberately reveals missing Namespace bundles in
// bounded batches. A fresh account may therefore need more than one
// prepare/replan pass: first the Room Namespace, then the rest of the Agent's
// exact readable set. This is a per-send work bound, not an authority cap;
// later sends resume from the durable Namespace/Domain publications.
const MAX_INLINE_NAMESPACE_READINESS_ROUNDS = 64;

function isPlanResponseValidationError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "ZodError";
}

function reportRuntimeAuthorizationDiagnostic(
  callback: CreateAuthorizedHumanLiveShadowMessageClientInput["onUnavailable"],
  reason: string,
): void {
  try {
    callback?.({ stage: "runtime_authorization", reason });
  } catch {
    // Diagnostics are observational and cannot alter authorization or cleanup.
  }
}

export interface HumanLiveShadowMessageApiPort {
  planLiveShadowRoomMessage:
    NautiloApiClient["planLiveShadowRoomMessage"];
  sendRoomMessage: NautiloApiClient["sendRoomMessage"];
  planProtectedHumanMessageEdit?: NautiloApiClient["planProtectedHumanMessageEdit"];
  publishProtectedHumanMessageEdit?: NautiloApiClient["publishProtectedHumanMessageEdit"];
  recoverLiveShadowRoomMessage?:
    NautiloApiClient["recoverLiveShadowRoomMessage"];
  authorizeSharedAgentExecution?:
    NautiloApiClient["authorizeSharedAgentExecution"];
  authorizeRuntimeInvocation?: NautiloApiClient["authorizeRuntimeInvocation"];
  getRoomPendingAttention?: NautiloApiClient["getRoomPendingAttention"];
  readRoomPendingAttention?: NautiloApiClient["readRoomPendingAttention"];
}

export type RecoveredRoomPendingAttention = Readonly<{
  status: "ready" | "unavailable";
  events: readonly ServerEvent[];
}>;

export interface AuthorizedHumanLiveShadowMessageClient {
  /** Stable device coordinate for this local crypto installation/account. */
  readonly deviceId: string;
  send(roomId: string, body: RoomSendBody): Promise<RoomSendResult>;
  edit(
    roomId: string,
    messageId: string,
    body: Readonly<{
      content: string;
      expectedRevision: number;
      clientIdempotencyKey?: string;
    }>,
  ): Promise<Readonly<{ content: string; editRevision: number }>>;
  recoverPending(): Promise<number>;
  completePending(operationId: string): Promise<boolean>;
  /**
   * Best-effort Human-recipient convergence after a server-authored Room
   * membership hint. Ordinary membership has already committed; this must
   * never make the Room unusable when custody is absent.
   */
  synchronizeHumanPeerRecipients(
    roomId: string,
    namespaceId: string,
  ): Promise<boolean>;
  serviceDomainKeyRequests(
    roomId: string,
    namespaceId: string,
    keyClass: "human" | "ai",
  ): Promise<boolean>;
  serviceDomainKeyBacklog(): Promise<boolean>;
  receiveDomainKeyDelivery(
    roomId: string,
    namespaceId: string,
    keyClass: "human" | "ai",
  ): Promise<boolean>;
  authorizeSharedAgentExecution(event: unknown): Promise<boolean>;
  /**
   * Recover canonical awaiting-checkpoint events without reserving or resuming
   * Agent execution. The caller fence must remain current across every page.
   */
  recoverRoomPendingAttention(input: Readonly<{
    roomId: string;
    clientActionSessionId: string;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
  }>): Promise<RecoveredRoomPendingAttention>;
}

export interface CreateAuthorizedHumanLiveShadowMessageClientInput {
  /** Explicit modern Browser/Desktop protocol opt-in; legacy callers stay V1. */
  readonly planRequestVersion?: 1 | 2;
  readonly api: HumanLiveShadowMessageApiPort;
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly coordinates: ClientProfileCoordinates;
  readonly journal: PreparedJournal;
  readonly ensureJournalAvailable: () => Promise<boolean>;
  readonly now: () => number;
  readonly createIdempotencyKey: () => string;
  readonly normalizeContent: (content: string) => string;
  /**
   * Repairs stale local Human-device MLS membership before one bounded retry.
   * The ordinary send remains available when repair cannot reach ready state.
   */
  readonly ensureDeviceMembershipReady?: () => Promise<boolean>;
  readonly namespaceAuthority?:
    NamespaceAuthorityClient;
  readonly domainForegroundAuthority?: DomainForegroundAuthorityClientV2;
  readonly onUnavailable?: (diagnostic: Readonly<{
    stage: "plan" | "plan_decode" | "journal" | "human_prepare" | "runtime_authorization";
    reason: string;
  }>) => void;
  /** Register the Human transcript in the legacy foreground-turn receiver.
   * Shared/peer receivers consume self-contained events and do not use it. */
  readonly onHumanVerified?: (input: Readonly<{
    operationId: string;
    planBytes: Uint8Array;
    ordinaryPayloadBytes: Uint8Array;
    protectedMessage: ProtectedMessageDtoV2;
    recovery?: true;
  }>) => Promise<void> | void;
  readonly onDurableRecovery?: (event: unknown) => Promise<boolean>;
  readonly synchronizeHumanPeerRecipients?: (
    roomId: string,
    namespaceId: string,
  ) => Promise<boolean>;
  readonly serviceDomainKeyRequests?: (
    roomId: string,
    namespaceId: string,
    keyClass: "human" | "ai",
  ) => Promise<boolean>;
  readonly serviceDomainKeyBacklog?: () => Promise<boolean>;
  readonly receiveDomainKeyDelivery?: (
    roomId: string,
    namespaceId: string,
    keyClass: "human" | "ai",
  ) => Promise<boolean>;
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
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function hasValues(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined
    && value !== null && value !== false;
}

/** Keep the first milestone's denominator exact: text-only, top-level sends. */
function requestHasEligibleShape(body: RoomSendBody): boolean {
  const raw = body as RoomSendBody & Record<string, unknown>;
  return typeof body.clientActionSessionId === "string"
    && body.clientActionSessionId.length > 0
    && !hasValues(body.attachments)
    && !hasValues(body.mentionedHumanUserIds)
    && !hasValues(body.replyToMessageId)
    && !hasValues(body.artifactRefs)
    && !hasValues(body.cardContinuation)
    && !hasValues(body.resumeTurnId)
    && !hasValues(body.resumeMessageId)
    && !hasValues(body.activeMiniApp)
    && !hasValues(body.voiceMode)
    && !hasValues(raw["focusedResources"])
    && !hasValues(raw["liveMiniAppSession"]);
}

function unavailableAttempt(
  operationId: string,
  planBytesBase64url: string,
  reason: Extract<LiveShadowMessageSendAttemptV1, {
    status: "client_unavailable";
  }>["reason"],
): LiveShadowMessageSendAttemptV1 {
  return Object.freeze({
    requestVersion: 1,
    status: "client_unavailable",
    operationId,
    planBytesBase64url,
    reason,
  });
}

function destroyForegroundPlan(
  plan: ReturnType<typeof decodeLiveShadowMessagePlanV4>,
): void {
  plan.agentSignerPublicKey.fill(0);
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
  plan.grantDomainParticipantDigest.fill(0);
  plan.grantDomainHeadDigest.fill(0);
  plan.grantDomainPublicationDigest.fill(0);
  plan.namespaceBundleDigest.fill(0);
  if (plan.authorization.disposition === "authorization_required") {
    plan.authorization.authorizationPlanBytes.fill(0);
    plan.authorization.authorizationPlanDigest.fill(0);
    plan.authorization.recipientPublicKey.fill(0);
  } else {
    plan.authorization.authorizationDigest.fill(0);
  }
}

function destroySharedAgentPlan(
  plan: ReturnType<typeof decodeSharedAgentLiveShadowMessagePlanV1>
    | ReturnType<typeof decodeHumanAiReadableLiveShadowMessagePlan>,
): void {
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
}

function isCurrentPendingAttentionRecovery(input: Readonly<{
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}>): boolean {
  if (input.signal?.aborted) return false;
  try {
    return input.isCurrent?.() ?? true;
  } catch {
    return false;
  }
}

function areExactPendingAttentionEvents(
  events: readonly ServerEvent[],
  roomId: string,
  userId: string,
  humanActorId: string,
): boolean {
  return events.every((event) => {
    if (event.type !== "approval.ask"
      && event.type !== "prove_it.challenge"
      && event.type !== "identity.challenge") return false;
    return isRoomPendingAttentionEventForViewer(event, {
      roomId,
      userId,
      humanActorId,
    });
  });
}

function isExactPendingAttentionPlan(input: Readonly<{
  challenge: RoomPendingAttentionChallenge;
  planBytes: Uint8Array;
  roomId: string;
  clientActionSessionId: string;
  coordinates: ClientProfileCoordinates;
  now: number;
}>): boolean {
  const plan = parseDomainForegroundAuthorizationPlanV2(input.planBytes);
  if (plan === null) return false;
  try {
    return plan.authorizationId === input.challenge.challengeId
      && plan.sessionId === input.clientActionSessionId
      && plan.roomId === input.roomId
      && input.challenge.roomId === input.roomId
      && plan.subjectHumanId === input.coordinates.humanActorId
      && plan.committerDeviceId === input.coordinates.deviceId
      && plan.recipientKind === "runtime"
      && plan.recipientPrincipalId === "nautilo_foreground_runtime"
      && plan.recipientAuthorizationRevision === 0
      && plan.recipientRuntimeGeneration === 0
      && plan.operations.length === 1
      && plan.operations[0] === "decrypt"
      && plan.deadlineAt === input.challenge.deadlineAt
      && input.now >= plan.issuedAt
      && input.now < plan.deadlineAt;
  } finally {
    destroyDomainForegroundAuthorizationPlanV2(plan);
  }
}

const unavailablePendingAttention = Object.freeze({
  status: "unavailable" as const,
  events: Object.freeze([]) as readonly ServerEvent[],
});

export function createAuthorizedHumanLiveShadowMessageClient(
  input: CreateAuthorizedHumanLiveShadowMessageClientInput,
): AuthorizedHumanLiveShadowMessageClient {
  let recovering = false;
  // A retry-expired Human publication still deserves a proof-only startup
  // check. Never reopen its mutation retry lifecycle or repeatedly poll it.
  const reconciledExpired = new Set<string>();
  const client: AuthorizedHumanLiveShadowMessageClient = {
    deviceId: input.coordinates.deviceId,
    async edit(roomId, messageId, body) {
      if (input.namespaceAuthority === undefined) {
        throw new Error("protected_edit_namespace_unavailable");
      }
      if (
        input.api.planProtectedHumanMessageEdit === undefined ||
        input.api.publishProtectedHumanMessageEdit === undefined
      ) {
        throw new Error("protected_edit_api_unavailable");
      }
      const targetMessageId = Number(messageId);
      const content = input.normalizeContent(body.content);
      if (
        content.length < 1 ||
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 0 ||
        !Number.isSafeInteger(targetMessageId) ||
        targetMessageId < 1 ||
        String(targetMessageId) !== messageId
      ) {
        throw new TypeError("protected_edit_input_invalid");
      }
      const planned = await input.api.planProtectedHumanMessageEdit(
        roomId,
        messageId,
        {
          requestVersion: 1,
          clientDeviceId: input.coordinates.deviceId,
          expectedRevision: body.expectedRevision,
          clientIdempotencyKey:
            body.clientIdempotencyKey ?? input.createIdempotencyKey(),
        },
      );
      if (planned.status !== "planned") {
        throw new Error(`protected_edit_${planned.reason}`);
      }
      const planBytes = fromBase64url(planned.planBytesBase64url);
      const prepared = await prepareVaultHumanMessageEdit({
        crypto: input.crypto,
        vault: input.vault,
        coordinates: input.coordinates,
        namespaceAuthority: input.namespaceAuthority,
        planBytes,
        roomId,
        messageId: targetMessageId,
        expectedRevision: body.expectedRevision,
        normalizedContent: content,
        now: input.now(),
      });
      if (prepared.status !== "prepared") {
        planBytes.fill(0);
        throw new Error(`protected_edit_${prepared.reason}`);
      }
      try {
        const request = Object.freeze({
          requestVersion: 1,
          representationMode: "full_encryption",
          planBytesBase64url: toBase64url(prepared.value.planBytes),
          signedRequestBytesBase64url: toBase64url(prepared.value.requestBytes),
          preparedTargets: prepared.value.targets.map((target) => ({
            sessionId: target.sessionId,
            messageId: target.messageId,
            encryptedPayloadBytesBase64url: toBase64url(
              target.encryptedPayloadBytes,
            ),
            accessManifestBytesBase64url: toBase64url(
              target.accessManifestBytes,
            ),
            namespaceEnvelopeBytesBase64url: toBase64url(
              target.namespaceEnvelopeBytes,
            ),
          })),
        } as const);
        let published;
        try {
          published = await input.api.publishProtectedHumanMessageEdit(
            roomId,
            messageId,
            request,
          );
        } catch {
          // Response loss is replayed with the exact signed/ciphertext bytes.
          // This never replans and never enters the ordinary edit endpoint.
          published = await input.api.publishProtectedHumanMessageEdit(
            roomId,
            messageId,
            request,
          );
        }
        if (
          published.editRevision !== body.expectedRevision + 1 ||
          published.targets.length !== prepared.value.targets.length ||
          published.targets.some((target, index) => {
            const expected = prepared.value.targets[index];
            return (
              expected === undefined ||
              target.sessionId !== expected.sessionId ||
              target.messageId !== expected.messageId ||
              target.cryptoObjectId !== deriveHumanMessageEditCryptoObjectIdV1({
                operationId: prepared.value.operationId,
                sessionId: expected.sessionId,
                messageId: expected.messageId,
                revision: published.editRevision,
              })
            );
          })
        )
          throw new Error("protected_edit_response_invalid");
        return Object.freeze({ content, editRevision: published.editRevision });
      } finally {
        planBytes.fill(0);
        prepared.value.planBytes.fill(0);
        prepared.value.requestBytes.fill(0);
        for (const target of prepared.value.targets) {
          target.encryptedPayloadBytes.fill(0);
          target.accessManifestBytes.fill(0);
          target.namespaceEnvelopeBytes.fill(0);
        }
      }
    },
    async recoverRoomPendingAttention(request) {
      const page = input.api.getRoomPendingAttention;
      const read = input.api.readRoomPendingAttention;
      if (page === undefined || !isCurrentPendingAttentionRecovery(request)) {
        return unavailablePendingAttention;
      }
      const events: ServerEvent[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      try {
        for (;;) {
          if (!isCurrentPendingAttentionRecovery(request)) {
            return unavailablePendingAttention;
          }
          const response: RoomPendingAttentionPageResponse = await page.call(
            input.api,
            request.roomId,
            {
              clientActionSessionId: request.clientActionSessionId,
              authorizationDeviceId: input.coordinates.deviceId,
              ...(cursor === undefined ? {} : { cursor }),
            },
            request.signal === undefined ? undefined : { signal: request.signal },
          );
          if (response.status !== "ready"
            || !isCurrentPendingAttentionRecovery(request)
            || !areExactPendingAttentionEvents(
              response.events,
              request.roomId,
              input.coordinates.userId,
              input.coordinates.humanActorId,
            )) {
            return unavailablePendingAttention;
          }
          events.push(...response.events);
          const challenge = response.challenge;
          if (challenge !== undefined) {
            if (read === undefined || input.domainForegroundAuthority === undefined) {
              return unavailablePendingAttention;
            }
            let authorizationPlanBytes: Uint8Array | undefined;
            let recipientPublicKey: Uint8Array | undefined;
            try {
              authorizationPlanBytes = fromBase64url(
                challenge.authorizationPlanBytesBase64url,
              );
              recipientPublicKey = fromBase64url(
                challenge.recipientPublicKeyBase64url,
              );
              const now = input.now();
              if (!isExactPendingAttentionPlan({
                challenge,
                planBytes: authorizationPlanBytes,
                roomId: request.roomId,
                clientActionSessionId: request.clientActionSessionId,
                coordinates: input.coordinates,
                now,
              }) || !isCurrentPendingAttentionRecovery(request)) {
                return unavailablePendingAttention;
              }
              const prepared = await prepareVaultRuntimeForegroundAuthorization({
                crypto: input.crypto,
                vault: input.vault,
                coordinates: input.coordinates,
                domainForegroundAuthority: input.domainForegroundAuthority,
                authorizationPlanBytes,
                recipientPublicKey,
                browserSessionId: request.clientActionSessionId,
                now,
              });
              if (prepared.status !== "prepared") {
                return unavailablePendingAttention;
              }
              try {
                if (!isCurrentPendingAttentionRecovery(request)) {
                  return unavailablePendingAttention;
                }
                const opened = await read.call(input.api, request.roomId, {
                  clientActionSessionId: request.clientActionSessionId,
                  authorizationDeviceId: input.coordinates.deviceId,
                  challengeId: challenge.challengeId,
                  authorizationBytesBase64url:
                    toBase64url(prepared.authorizationBytes),
                }, request.signal === undefined
                  ? undefined
                  : { signal: request.signal });
                if (opened.status !== "read"
                  || !isCurrentPendingAttentionRecovery(request)
                  || !areExactPendingAttentionEvents(
                    opened.events,
                    request.roomId,
                    input.coordinates.userId,
                    input.coordinates.humanActorId,
                  )) {
                  return unavailablePendingAttention;
                }
                events.push(...opened.events);
              } finally {
                prepared.authorizationBytes.fill(0);
                prepared.authorizationDigest.fill(0);
              }
            } finally {
              authorizationPlanBytes?.fill(0);
              recipientPublicKey?.fill(0);
            }
          }
          const nextCursor = response.nextCursor;
          if (nextCursor === null) {
            return Object.freeze({
              status: "ready" as const,
              events: Object.freeze(events.slice()),
            });
          }
          if (seenCursors.has(nextCursor)) return unavailablePendingAttention;
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
      } catch {
        return unavailablePendingAttention;
      }
    },
    async authorizeSharedAgentExecution(candidate) {
      if (input.domainForegroundAuthority === undefined) {
        reportRuntimeAuthorizationDiagnostic(
          input.onUnavailable,
          "domain_authority_unavailable",
        );
        return false;
      }
      let event;
      try {
        event = parseLiveShadowMessageRealtimeEventV1(candidate);
      } catch {
        reportRuntimeAuthorizationDiagnostic(input.onUnavailable, "event_invalid");
        return false;
      }
      if (event.type === "message.runtime_invocation_authorization_required") {
        if (input.api.authorizeRuntimeInvocation === undefined) {
          reportRuntimeAuthorizationDiagnostic(input.onUnavailable, "api_unavailable");
          return false;
        }
        let authorizationPlanBytes: Uint8Array | undefined;
        let sourceHumanPlanBytes: Uint8Array | undefined;
        let recipientPublicKey: Uint8Array | undefined;
        try {
          authorizationPlanBytes = fromBase64url(
            event.authorizationPlanBytesBase64url,
          );
          sourceHumanPlanBytes = fromBase64url(
            event.sourceHumanPlanBytesBase64url,
          );
          recipientPublicKey = fromBase64url(
            event.recipientPublicKeyBase64url,
          );
          if (
            event.userId !== input.coordinates.userId
            || event.laneKey !== `room:${event.roomId}`
            || input.now() >= event.deadlineAt
          ) {
            reportRuntimeAuthorizationDiagnostic(input.onUnavailable, "event_stale");
            return false;
          }
          reportRuntimeAuthorizationDiagnostic(input.onUnavailable, "prepare_started");
          const prepared = await prepareVaultRuntimeForegroundAuthorization({
            crypto: input.crypto,
            vault: input.vault,
            coordinates: input.coordinates,
            domainForegroundAuthority: input.domainForegroundAuthority,
            authorizationPlanBytes,
            sourceHumanPlanBytes,
            recipientPublicKey,
            browserSessionId: event.clientActionSessionId,
            now: input.now(),
          });
          reportRuntimeAuthorizationDiagnostic(
            input.onUnavailable,
            prepared.status === "prepared"
              ? "prepare_complete_prepared"
              : "prepare_complete_unavailable",
          );
          if (prepared.status !== "prepared") {
            reportRuntimeAuthorizationDiagnostic(input.onUnavailable, prepared.reason);
            return false;
          }
          try {
            reportRuntimeAuthorizationDiagnostic(input.onUnavailable, "request_started");
            const result = await input.api.authorizeRuntimeInvocation(
              event.roomId,
              event.invocationId,
              {
                requestVersion: 1,
                status: "prepared",
                operationId: event.invocationId,
                clientActionSessionId: event.clientActionSessionId,
                authorizationScheme: "runtime_foreground_v1",
                authorizationPlanBytesBase64url:
                  toBase64url(authorizationPlanBytes),
                authorizationBytesBase64url:
                  toBase64url(prepared.authorizationBytes),
              },
            );
            const accepted = result.status === "authorized"
              || result.status === "replayed";
            if (accepted) {
              reportRuntimeAuthorizationDiagnostic(
                input.onUnavailable,
                result.status === "authorized" ? "request_authorized" : "request_replayed",
              );
            }
            if (!accepted) {
              reportRuntimeAuthorizationDiagnostic(input.onUnavailable, "result_rejected");
            }
            return accepted;
          } finally {
            prepared.authorizationBytes.fill(0);
            prepared.authorizationDigest.fill(0);
          }
        } catch {
          reportRuntimeAuthorizationDiagnostic(input.onUnavailable, "request_failed");
          return false;
        } finally {
          authorizationPlanBytes?.fill(0);
          sourceHumanPlanBytes?.fill(0);
          recipientPublicKey?.fill(0);
        }
      }
      if (event.type !== "message.shared_agent_authorization_required") {
        return false;
      }
      if (input.api.authorizeSharedAgentExecution === undefined) return false;
      if (
        event.authorizationScheme === "runtime_foreground_v1"
      ) {
        let authorizationPlanBytes: Uint8Array | undefined;
        let sourceHumanPlanBytes: Uint8Array | undefined;
        let recipientPublicKey: Uint8Array | undefined;
        try {
          if (
            event.authorizationPlanBytesBase64url === undefined
            || event.recipientPublicKeyBase64url === undefined
          ) return false;
          authorizationPlanBytes = fromBase64url(
            event.authorizationPlanBytesBase64url,
          );
          sourceHumanPlanBytes = event.sourceHumanPlanBytesBase64url === undefined
            ? undefined
            : fromBase64url(event.sourceHumanPlanBytesBase64url);
          recipientPublicKey = fromBase64url(
            event.recipientPublicKeyBase64url,
          );
          if (
            event.userId !== input.coordinates.userId
            || event.laneKey !== `room:${event.roomId}`
            || input.now() >= event.deadlineAt
          ) return false;
          const prepared = await prepareVaultRuntimeForegroundAuthorization({
            crypto: input.crypto,
            vault: input.vault,
            coordinates: input.coordinates,
            domainForegroundAuthority: input.domainForegroundAuthority,
            authorizationPlanBytes,
            ...(sourceHumanPlanBytes === undefined
              ? {}
              : { sourceHumanPlanBytes }),
            recipientPublicKey,
            browserSessionId: event.clientActionSessionId,
            now: input.now(),
          });
          if (prepared.status !== "prepared") return false;
          try {
            const result = await input.api.authorizeSharedAgentExecution(
              event.roomId,
              event.executionId,
              {
                requestVersion: 1,
                status: "prepared",
                operationId: event.executionId,
                clientActionSessionId: event.clientActionSessionId,
                authorizationScheme: "runtime_foreground_v1",
                authorizationPlanBytesBase64url:
                  toBase64url(authorizationPlanBytes),
                authorizationBytesBase64url:
                  toBase64url(prepared.authorizationBytes),
              },
            );
            return result.status === "authorized"
              || result.status === "replayed";
          } finally {
            prepared.authorizationBytes.fill(0);
            prepared.authorizationDigest.fill(0);
          }
        } catch {
          return false;
        } finally {
          authorizationPlanBytes?.fill(0);
          sourceHumanPlanBytes?.fill(0);
          recipientPublicKey?.fill(0);
        }
      }
      let planBytes: Uint8Array | undefined;
      let ordinaryPayloadBytes: Uint8Array | undefined;
      let plan: ReturnType<typeof decodeLiveShadowMessagePlanV4> | undefined;
      try {
        if (
          event.planBytesBase64url === undefined
          || event.ordinaryPayloadBytesBase64url === undefined
        ) return false;
        planBytes = fromBase64url(event.planBytesBase64url);
        ordinaryPayloadBytes = fromBase64url(
          event.ordinaryPayloadBytesBase64url,
        );
        plan = decodeLiveShadowMessagePlanV4(planBytes);
        const payload = decodeMessagePayloadV2(ordinaryPayloadBytes);
        if (
          plan.operationId !== event.executionId
          || plan.roomId !== event.roomId
          || event.userId !== input.coordinates.userId
          || event.laneKey !== `room:${event.roomId}`
          || plan.subjectHumanId !== input.coordinates.humanActorId
          || plan.committerDeviceId !== input.coordinates.deviceId
          || payload.role !== "user"
          || payload.toolCalls !== undefined
          || input.now() >= event.deadlineAt
        ) return false;
        const prepared = await prepareVaultHumanLiveShadowMessageV4({
          crypto: input.crypto,
          vault: input.vault,
          coordinates: input.coordinates,
          domainForegroundAuthority: input.domainForegroundAuthority,
          planBytes,
          normalizedContent: payload.content,
          now: input.now(),
        });
        if (prepared.status !== "prepared") return false;
        const value = prepared.value;
        try {
          const result = await input.api.authorizeSharedAgentExecution(
            event.roomId,
            event.executionId,
            {
              requestVersion: 1,
              status: "prepared",
              operationId: event.executionId,
              clientActionSessionId: event.clientActionSessionId,
              authorizationScheme: "foreground_session_v1",
              planBytesBase64url: toBase64url(value.planBytes),
              signedRequestBytesBase64url: toBase64url(value.requestBytes),
              ordinaryPayloadBytesBase64url:
                toBase64url(ordinaryPayloadBytes),
              encryptedPayloadBytesBase64url:
                toBase64url(value.encryptedPayloadBytes),
              accessManifestBytesBase64url:
                toBase64url(value.accessManifestBytes),
              namespaceEnvelopeBytesBase64url:
                toBase64url(value.namespaceEnvelopeBytes),
            },
          );
          return result.status === "authorized" || result.status === "replayed";
        } finally {
          value.planBytes.fill(0);
          value.requestBytes.fill(0);
          if ("grantBytes" in value) value.grantBytes.fill(0);
          value.encryptedPayloadBytes.fill(0);
          value.accessManifestBytes.fill(0);
          value.namespaceEnvelopeBytes.fill(0);
          value.requestDigest.fill(0);
        }
      } catch {
        return false;
      } finally {
        if (plan !== undefined) destroyForegroundPlan(plan);
        planBytes?.fill(0);
        ordinaryPayloadBytes?.fill(0);
      }
    },
    async synchronizeHumanPeerRecipients(roomId, namespaceId) {
      return input.synchronizeHumanPeerRecipients?.(roomId, namespaceId)
        .catch(() => false) ?? false;
    },
    async serviceDomainKeyRequests(roomId, namespaceId, keyClass) {
      return input.serviceDomainKeyRequests?.(roomId, namespaceId, keyClass)
        .catch(() => false) ?? false;
    },
    async serviceDomainKeyBacklog() {
      return input.serviceDomainKeyBacklog?.().catch(() => false) ?? false;
    },
    async receiveDomainKeyDelivery(roomId, namespaceId, keyClass) {
      return input.receiveDomainKeyDelivery?.(roomId, namespaceId, keyClass)
        .catch(() => false) ?? false;
    },
    async completePending(operationId) {
      const entry = (await input.journal.listStatus()).find((candidate) =>
        candidate.kind === "live_shadow_message"
        && candidate.operationId === operationId
      );
      if (entry === undefined) return false;
      await input.journal.recordOutcome({
        operationId,
        authenticatedRequestDigestBase64url:
          entry.authenticatedRequestDigestBase64url,
        outcome: "completed",
      });
      return true;
    },
    async recoverPending() {
      if (input.api.recoverLiveShadowRoomMessage === undefined) return 0;
      if (recovering) return 0;
      recovering = true;
      try {
      if (!await input.ensureJournalAvailable().catch(() => false)) return 0;
      const recover = input.api.recoverLiveShadowRoomMessage.bind(input.api);
      const status = await input.journal.listStatus();
      const currentIds = new Set(status.map((entry) => entry.operationId));
      for (const operationId of reconciledExpired) {
        if (!currentIds.has(operationId)) reconciledExpired.delete(operationId);
      }
      // Use the journal's existing batch/rate budget for proof-only GETs too.
      const recentAttempts = status.reduce((sum, entry) => sum
        + (entry.attemptWindowStartedAt !== null
          && input.now() - entry.attemptWindowStartedAt
            < PREPARED_MUTATION_JOURNAL_LIMITS.attemptRateWindowMs
          ? entry.attemptsInWindow : 0), 0);
      const budget = Math.min(PREPARED_MUTATION_JOURNAL_LIMITS.maxBatch,
        Math.max(0, PREPARED_MUTATION_JOURNAL_LIMITS.maxAttemptsPerMinute - recentAttempts));
      let requests = 0;
      let recovered = 0;
      for (const candidate of status) {
        if (requests >= budget) break;
        if (candidate.kind !== "live_shadow_message") continue;
        const expired = candidate.state === "terminal_expired";
        const due = (candidate.state === "pending" || candidate.state === "retryable")
          && candidate.nextAttemptAt <= input.now();
        if (!due
          && (!expired || reconciledExpired.has(candidate.operationId))) continue;
        let queried = false;
        try {
          const outcome = await input.journal.withPrepared(
            candidate.operationId,
            async (mutation): Promise<"completed" | "retryable" | null> => {
            if (mutation.kind !== "live_shadow_message") return null;
            const authorizationScheme = "authorizationScheme" in mutation.request
              ? mutation.request.authorizationScheme : undefined;
            const sharedHuman = authorizationScheme === "human_peer_v1"
              || authorizationScheme === "shared_agent_v1"
              || authorizationScheme === "human_ai_readable_v1"
              || authorizationScheme === "human_ai_readable_v2";
            if (sharedHuman && !isOwnedHumanPublication({
              ...mutation, coordinates: input.coordinates,
            })) return null;
            if (expired) {
              if (!sharedHuman) return null;
            }
            requests++;
            queried = true;
            const response = await recover(
              mutation.roomId,
              candidate.operationId,
            );
            if (expired) reconciledExpired.add(candidate.operationId);
            if (sharedHuman) {
              // The retained request is authenticated local custody. A remote
              // completion must name those exact accepted bytes, not merely
              // an operation ID or an Agent terminal state.
              if (response.status !== "human_published"
                || response.operationId !== mutation.request.operationId
                || response.authorizationScheme !== authorizationScheme
                || !matchesHumanPublicationReceipt({
                  ...mutation, coordinates: input.coordinates,
                  protectedMessage: response.human.protectedMessage,
                })) return "retryable";
              const signedBytes = fromBase64url(mutation.request.signedRequestBytesBase64url);
              try {
                if (response.acceptedHumanRequestDigestBase64url !== toBase64url(sha256(signedBytes))) {
                  return "retryable";
                }
              } finally {
                signedBytes.fill(0);
              }
            } else if (response.status === "human_published") return "retryable";
            if (
              !sharedHuman
              && response.status !== "absent"
              && response.human !== undefined
              && input.onHumanVerified !== undefined
              && mutation.request.requestVersion === 1
            ) {
              await input.onHumanVerified({
                operationId: candidate.operationId,
                planBytes: fromBase64url(
                  mutation.request.planBytesBase64url,
                ),
                ordinaryPayloadBytes: fromBase64url(
                  mutation.request.ordinaryPayloadBytesBase64url,
                ),
                protectedMessage: response.human.protectedMessage,
                recovery: true,
              });
            }
            if (response.status === "human_published") return "completed";
            if (response.status === "completed") {
              if (input.onDurableRecovery !== undefined) {
                for (const event of response.durableEvents) {
                  if (!await input.onDurableRecovery(event)) {
                    throw new TypeError(
                      "Live Shadow durable recovery verification failed",
                    );
                  }
                }
              }
              return "completed";
            }
            if (response.status === "fallback") {
              return "completed";
            }
            return "retryable";
          });
          if (outcome === null) continue;
          // `withPrepared` may hold an exclusive file-vault lease for the
          // duration of its callback. Recording the outcome from inside that
          // callback queues a second operation on the same vault and deadlocks
          // Electron startup recovery. Release opened custody first, then
          // mutate the journal index/removal in a separate vault operation.
          await input.journal.recordOutcome({
            operationId: candidate.operationId,
            authenticatedRequestDigestBase64url:
              candidate.authenticatedRequestDigestBase64url,
            outcome,
          });
          if (outcome === "completed") recovered++;
        } catch {
          if (queried) await input.journal.recordOutcome({
            operationId: candidate.operationId,
            authenticatedRequestDigestBase64url:
              candidate.authenticatedRequestDigestBase64url,
            outcome: "retryable",
          }).catch(() => undefined);
        }
      }
      return recovered;
      } finally {
        recovering = false;
      }
    },
    async send(roomId: string, body: RoomSendBody) {
      // The room audience already includes every explicit Human recipient.
      // Keep protected text-only admission independent of an expanded ID list.
      if (body.mentionEveryone === true) {
        const { mentionedHumanUserIds: _individualMentions, ...audienceBody } = body;
        body = audienceBody;
      }
      const sendPlanUnavailable = (reason: Extract<LiveShadowMessageSendAttemptV1,
        { status: "plan_unavailable" }>["reason"]) => input.api.sendRoomMessage(roomId, {
          ...body,
          liveShadow: { requestVersion: 1, status: "plan_unavailable", reason },
        });
      if (!requestHasEligibleShape(body)) {
        return input.api.sendRoomMessage(roomId, body);
      }
      const clientActionSessionId = body.clientActionSessionId;
      if (clientActionSessionId === undefined) {
        return input.api.sendRoomMessage(roomId, body);
      }
      const createPlanRequest = () => Object.freeze({
        requestVersion: input.planRequestVersion ?? 1,
        clientActionSessionId,
        clientDeviceId: input.coordinates.deviceId,
        idempotencyKey: input.createIdempotencyKey(),
        requestShape: "text_only",
        ...(body.mentionEveryone === true ? { mentionEveryone: true as const } : {}),
      });
      let planRequest = createPlanRequest();
      let plan;
      try {
        plan = await input.api.planLiveShadowRoomMessage(roomId, planRequest);
      } catch (error) {
        if (body.mentionEveryone === true || isPlanResponseValidationError(error)
          || (planRequest.requestVersion === 2 && typeof error === "object"
            && error !== null && "status" in error && error.status === 400)) {
          // An endpoint that answered with an unknown policy/plan shape is not
          // unavailable: silently retrying the mutation as plaintext would let
          // a version mismatch downgrade protected traffic.
          throw error;
        }
        // Preserve the failure for the server's current policy: fallback may
        // persist ordinary bytes, while Strict must reject without consuming them.
        input.onUnavailable?.({
          stage: "plan",
          reason: typeof error === "object"
              && error !== null
              && "status" in error
              && typeof error.status === "number"
            ? `request_failed_${error.status}`
            : "invalid_response",
        });
        return sendPlanUnavailable("request_failed");
      }
      const synchronizedNamespaceIds = new Set<string>();
      for (
        let readinessRound = 0;
        readinessRound < MAX_INLINE_NAMESPACE_READINESS_ROUNDS
          && plan.status === "unavailable"
          && (plan.reason === "namespace_unavailable"
            || plan.reason === "recipient_sync_required");
        readinessRound++
      ) {
        let roundReady = false;
        if (input.namespaceAuthority !== undefined) {
          const requiredNamespaceIds = plan.requiredNamespaceIds;
          const pendingNamespaceIds = (requiredNamespaceIds ?? []).filter(
            (namespaceId) => !synchronizedNamespaceIds.has(namespaceId),
          );
          // A fresh plan may widen its exact authority set while retaining
          // Namespaces repaired by an earlier round. Process only the newly
          // revealed coordinates; overlap is expected and is not evidence of
          // a stalled loop. A repeated set with no new coordinate still stops
          // here, preserving bounded fail-closed convergence.
          roundReady = pendingNamespaceIds.length > 0;
          for (const requiredNamespaceId of pendingNamespaceIds) {
            const requiredKeyClass = "authorizationScheme" in plan
              && plan.authorizationScheme === "human_peer_v1"
              ? { keyClass: "human" as const } : {};
            let result = plan.reason === "recipient_sync_required"
              ? await input.namespaceAuthority
                .synchronizeRecipients({
                  sourceRoomId: roomId,
                  namespaceId: requiredNamespaceId,
                  ...requiredKeyClass,
                }).catch(() => Object.freeze({
                  status: "unavailable" as const,
                  reason: "request_failed",
                }))
              : await input.namespaceAuthority.ensure({
                sourceRoomId: roomId,
                namespaceId: requiredNamespaceId,
                ...requiredKeyClass,
                operationId: input.createIdempotencyKey(),
                idempotencyKey: input.createIdempotencyKey(),
              }).catch(() => Object.freeze({
                status: "unavailable" as const,
                reason: "request_failed",
              }));
            // Recipient synchronization is additive so that newly enrolled
            // devices and recovery keys can recover retained generations.
            // A revoked device or rotated recovery key also leaves an old
            // immutable envelope on the current generation; after the retained
            // sync is complete, ensure() rotates that generation to the exact
            // current recipient set before a Human-peer write is admitted.
            if (
              plan.reason === "recipient_sync_required"
              && result.status === "ready"
            ) {
              result = await input.namespaceAuthority.ensure({
                sourceRoomId: roomId,
                namespaceId: requiredNamespaceId,
                ...requiredKeyClass,
                operationId: input.createIdempotencyKey(),
                idempotencyKey: input.createIdempotencyKey(),
              }).catch(() => Object.freeze({
                status: "unavailable" as const,
                reason: "request_failed",
              }));
            }
            if (result.status !== "ready") {
              roundReady = false;
              continue;
            }
            synchronizedNamespaceIds.add(requiredNamespaceId);
          }
        }
        if (!roundReady) break;
        try {
          // Plan attempts are idempotent terminal records. Once local custody
          // repairs the exact unavailable authority, a fresh request identity
          // is required to observe the new server state instead of replaying
          // the original unavailable attempt forever.
          planRequest = createPlanRequest();
          plan = await input.api.planLiveShadowRoomMessage(roomId, planRequest);
        } catch (error) {
          if (body.mentionEveryone === true || isPlanResponseValidationError(error)
            || (planRequest.requestVersion === 2 && typeof error === "object"
              && error !== null && "status" in error && error.status === 400)) throw error;
          input.onUnavailable?.({ stage: "plan", reason: "replan_failed" });
          return sendPlanUnavailable("request_failed");
        }
      }
      if (plan.status !== "planned") {
        if (planRequest.requestVersion === 2 && plan.status === "ineligible") {
          throw new TypeError("Human AI-readable V2 planning is ineligible");
        }
        input.onUnavailable?.({
          stage: "plan",
          reason: plan.status === "disabled" ? "disabled" : plan.reason,
        });
        return plan.status === "disabled"
          ? input.api.sendRoomMessage(roomId, body)
          : sendPlanUnavailable(plan.reason);
      }
      const full = plan.representationMode === "full_encryption";
      let planBytes: Uint8Array | undefined;
      let operationId: string | undefined;
      let planVersion:
        | 4
        | "human_peer"
        | "shared_agent"
        | "human_ai_readable";
      let normalizedContent: string;
      let plannedMentionEveryone = false;
      try {
        planBytes = fromBase64url(plan.planBytesBase64url);
        try {
          operationId = decodeLiveShadowMessagePlanV4(planBytes).operationId;
          planVersion = 4;
        } catch {
          try {
            const peerPlan = decodeHumanPeerLiveShadowMessagePlanV1(planBytes);
            try {
              operationId = peerPlan.operationId;
              plannedMentionEveryone = peerPlan.mentionEveryone === true;
            } finally {
              peerPlan.namespaceHeadDigest.fill(0);
              peerPlan.namespacePublicationDigest.fill(0);
              peerPlan.namespacePublicationSetDigest.fill(0);
              peerPlan.namespaceAudienceFingerprint.fill(0);
            }
            planVersion = "human_peer";
          } catch {
            try {
              const humanAiPlan =
                decodeHumanAiReadableLiveShadowMessagePlan(planBytes);
              try {
                if (humanAiPlan.formatVersion !== planRequest.requestVersion) {
                  throw new TypeError("Human AI-readable plan version mismatch");
                }
                operationId = humanAiPlan.operationId;
                plannedMentionEveryone = humanAiPlan.mentionEveryone === true;
                planVersion = "human_ai_readable";
              } finally {
                destroySharedAgentPlan(humanAiPlan);
              }
            } catch {
              const sharedPlan =
                decodeSharedAgentLiveShadowMessagePlanV1(planBytes);
              try {
                operationId = sharedPlan.operationId;
                planVersion = "shared_agent";
              } finally {
                destroySharedAgentPlan(sharedPlan);
              }
            }
          }
        }
        // V2 selects either current AI-readable authority or the distinct
        // Human-only protocol. A topology miss must not admit legacy Agent plans.
        if ((plan.authorizationScheme === "human_ai_readable_v2")
          !== (planRequest.requestVersion === 2 && planVersion === "human_ai_readable")) {
          throw new TypeError("Human AI-readable plan negotiation mismatch");
        }
        if (planRequest.requestVersion === 2
          && planVersion !== "human_ai_readable" && planVersion !== "human_peer") {
          throw new TypeError("V2 requires current AI-readable or Human-only authority");
        }
        if (plannedMentionEveryone !== (body.mentionEveryone === true)) {
          throw new TypeError("Protected Room mention intent mismatch");
        }
        normalizedContent = input.normalizeContent(body.content!);
      } catch {
        input.onUnavailable?.({ stage: "plan_decode", reason: "invalid_bytes" });
        planBytes?.fill(0);
        if (full || planRequest.requestVersion === 2 || body.mentionEveryone === true) {
          throw new TypeError("Protected message plan is invalid");
        }
        return sendPlanUnavailable("invalid_plan");
      }

      const journalReady = await input.ensureJournalAvailable().catch(() =>
        false
      );
      const journalCapacity = journalReady
        ? await input.journal.capacity().catch(() => null)
        : null;
      if (journalCapacity === null || journalCapacity.full) {
        input.onUnavailable?.({
          stage: "journal",
          reason: journalCapacity === null ? "unavailable" : "full",
        });
        planBytes.fill(0);
        if (full) throw new Error("Full encryption journal is unavailable");
        return input.api.sendRoomMessage(roomId, {
          ...body,
          content: normalizedContent,
          liveShadow: unavailableAttempt(
            operationId,
            plan.planBytesBase64url,
            journalCapacity?.full === true ? "journal_full" : "journal_unavailable",
          ),
        });
      }

      const prepareCurrentPlan = async () => planVersion === "human_ai_readable"
        ? input.namespaceAuthority === undefined
          ? Object.freeze({
              status: "unavailable" as const,
              reason: "namespace_unavailable" as const,
            })
          : await prepareVaultHumanAiReadableLiveShadowMessage({
              crypto: input.crypto,
              vault: input.vault,
              coordinates: input.coordinates,
              namespaceAuthority: input.namespaceAuthority,
              planBytes,
              normalizedContent,
              now: input.now(),
            })
        : planVersion === "shared_agent"
        ? input.namespaceAuthority === undefined
          ? Object.freeze({
              status: "unavailable" as const,
              reason: "namespace_unavailable" as const,
            })
          : await prepareVaultSharedAgentLiveShadowMessage({
              crypto: input.crypto,
              vault: input.vault,
              coordinates: input.coordinates,
              namespaceAuthority: input.namespaceAuthority,
              planBytes,
              normalizedContent,
              now: input.now(),
            })
        : planVersion === "human_peer"
        ? input.namespaceAuthority === undefined
          ? Object.freeze({
              status: "unavailable" as const,
              reason: "namespace_unavailable" as const,
            })
          : await prepareVaultHumanPeerLiveShadowMessage({
              crypto: input.crypto,
              vault: input.vault,
              coordinates: input.coordinates,
              namespaceAuthority: input.namespaceAuthority,
              planBytes,
              normalizedContent,
              now: input.now(),
            })
        : planVersion === 4
        ? input.domainForegroundAuthority === undefined
          ? Object.freeze({
              status: "unavailable" as const,
              reason: "domain_unavailable" as const,
            })
          : await prepareVaultHumanLiveShadowMessageV4({
              crypto: input.crypto,
              vault: input.vault,
              coordinates: input.coordinates,
              domainForegroundAuthority: input.domainForegroundAuthority,
              planBytes,
              normalizedContent,
              now: input.now(),
            })
        : Object.freeze({
            status: "unavailable" as const,
            reason: "plan_stale" as const,
          });
      let prepared = await prepareCurrentPlan();
      if (
        prepared.status === "unavailable"
        && prepared.reason === "plan_stale"
        && input.ensureDeviceMembershipReady !== undefined
        && await input.ensureDeviceMembershipReady().catch(() => false)
      ) {
        prepared = await prepareCurrentPlan();
      }
      if (prepared.status !== "prepared") {
        input.onUnavailable?.({
          stage: "human_prepare",
          reason: prepared.reason,
        });
        planBytes.fill(0);
        if (full) throw new Error("Full encryption preparation is unavailable");
        return input.api.sendRoomMessage(roomId, {
          ...body,
          content: normalizedContent,
          liveShadow: unavailableAttempt(
            operationId,
            plan.planBytesBase64url,
            prepared.reason,
          ),
        });
      }

      const ordinaryPayloadBytes = encodeMessagePayloadV2({
        role: "user",
        content: normalizedContent,
      });
      const value = prepared.value;
      const requestBase = {
        status: "prepared",
        operationId,
        planBytesBase64url: toBase64url(value.planBytes),
        signedRequestBytesBase64url: toBase64url(value.requestBytes),
        encryptedPayloadBytesBase64url: toBase64url(
          value.encryptedPayloadBytes,
        ),
        accessManifestBytesBase64url: toBase64url(value.accessManifestBytes),
        namespaceEnvelopeBytesBase64url: toBase64url(
          value.namespaceEnvelopeBytes,
        ),
      } as const;
      const representation = full ? {
        requestVersion: 2 as const,
        representationMode: "full_encryption" as const,
      } : {
        requestVersion: 1 as const,
        ordinaryPayloadBytesBase64url: toBase64url(ordinaryPayloadBytes),
      };
      const request: LiveShadowMessagePreparedRequestV1 | FullEncryptionMessagePreparedRequestV2 =
        planVersion === "human_ai_readable"
          ? Object.freeze({
            ...requestBase, ...representation,
            authorizationScheme: planRequest.requestVersion === 2
              ? "human_ai_readable_v2" as const : "human_ai_readable_v1" as const,
          })
          : planVersion === "shared_agent"
          ? Object.freeze({
            ...requestBase, ...representation,
            authorizationScheme: "shared_agent_v1" as const,
          })
          : planVersion === "human_peer"
          ? Object.freeze({
            ...requestBase, ...representation,
            authorizationScheme: "human_peer_v1" as const,
          })
          : planVersion === 4
          ? Object.freeze({
            ...requestBase, ...representation,
            authorizationScheme: "foreground_session_v1" as const,
          })
          : Object.freeze({ ...requestBase, ...representation, authorizationScheme: "human_peer_v1" as const });
      try {
        let custody;
        try {
          custody = await input.journal.putBeforeSend({
            kind: "live_shadow_message",
            roomId,
            request,
          });
        } catch {
          if (full) throw new Error("Full encryption journal is unavailable");
          return await input.api.sendRoomMessage(roomId, {
            ...body,
            content: normalizedContent,
            liveShadow: unavailableAttempt(
              operationId,
              plan.planBytesBase64url,
              "journal_unavailable",
            ),
          });
        }
        const { content: _transientContent, ...structuralBody } = body;
        const result = await input.api.sendRoomMessage(roomId, full ? {
          ...structuralBody, liveShadow: request,
        } : {
          ...body, content: normalizedContent, liveShadow: request,
        });
        if (result.liveShadow?.status === "ordinary_fallback") {
          await input.journal.recordOutcome({
            operationId,
            authenticatedRequestDigestBase64url:
              custody.index.authenticatedRequestDigestBase64url,
            outcome: "completed",
          });
        }
        if (
          result.liveShadow?.status === "human_verified"
          && result.liveShadow.operationId === operationId
        ) {
          const protectedMessage = result.liveShadow.protectedMessage;
          if (planVersion === 4) {
            await Promise.resolve().then(() => input.onHumanVerified?.({
              operationId,
              planBytes: value.planBytes.slice(),
              ordinaryPayloadBytes: ordinaryPayloadBytes.slice(),
              protectedMessage,
            })).catch(() => undefined);
          } else if (matchesHumanPublicationReceipt({
            request, roomId, coordinates: input.coordinates,
            protectedMessage: result.liveShadow.protectedMessage,
          })) {
            await input.journal.recordOutcome({
              operationId,
              authenticatedRequestDigestBase64url:
                custody.index.authenticatedRequestDigestBase64url,
              outcome: "completed",
            }).catch(() => {
              input.onUnavailable?.({ stage: "journal", reason: "publication_reconciliation_pending" });
            });
          }
        }
        return result;
      } finally {
        planBytes.fill(0);
        ordinaryPayloadBytes.fill(0);
        value.planBytes.fill(0);
        value.requestBytes.fill(0);
        if ("grantBytes" in value) value.grantBytes.fill(0);
        if ("ordinaryPayloadBytes" in value) {
          value.ordinaryPayloadBytes.fill(0);
        }
        value.encryptedPayloadBytes.fill(0);
        value.accessManifestBytes.fill(0);
        value.namespaceEnvelopeBytes.fill(0);
        value.requestDigest.fill(0);
      }
    },
  };
  return Object.freeze(client);
}
