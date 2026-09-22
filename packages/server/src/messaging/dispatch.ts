/**
 * D174 Phase 11.1–11.2 — canonical `POST /api/rooms/:roomId/messages` dispatcher.
 *
 * **Agent-mediated branch:** `executeAgentMediatedRoomMessage` (extracted legacy
 * `/api/chat` job enqueue) — MR1 canonical JSON; optional `aliasHttpContract`
 * rewrites success payloads to deprecated `SendMessageResponse` for `POST /api/chat`.
 *
 * **Human-only branch:** `peer-broadcast.ts` persists + recipient_state +
 * `message.new` emit.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import {
  liveShadowMessageSendAttemptV1Schema,
} from "@nautilo/api-client";
import {
  decodePreparedLiveShadowAttempt,
  preparedAuthorizationSchemeMatchesWireFormat,
} from "./decode-prepared-message";
import {
  LatticeCrypto,
  decodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanPeerLiveShadowMessagePlanV1,
  decodeLiveShadowMessagePlanV4,
  decodeSharedAgentLiveShadowMessagePlanV1,
} from "@nautilo/lattice-crypto/wire";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
  fullEncryptionDurableEventDigestV2,
  liveShadowDurableEventDigestV1,
} from "@nautilo/lattice-bridge";
import { runWithTurn } from "@nautilo/logger";
import {
  getSharedDirectDb,
  getCachedServerModelConfigRow,
  getRoomNamespaceId,
  kickServerModelConfigRefresh,
  getSessionMessageFingerprintById,
  stampTurnIdOnAttachments,
} from "@nautilo/db";
import { log } from "@nautilo/logger";
import type { RoomDetailPayload } from "@nautilo/trust";
import {
  AgentInvocationDeniedError,
  assertCanInvokeAgent,
  createAcceptedInvocationAuthority,
  findReplyTargetAgentActorId,
  findRoomAgentResponseModes,
  isUuidString,
  loadActiveSilenceForRoom,
  loadActiveFoci,
  openOrExtendFocus,
  parseAgentMentions,
  toActionCapabilityHttpDenial,
  type AcceptedInvocationAuthority,
  type AgentInvocationAdmissionInput,
  directHumanPeerUserId,
  humanPairIsBlocked,
} from "@nautilo/trust";
import {
  botThreadId,
  routeRoomMessage,
  searchRoomHistoryRelaxed,
  loadRoutingPacket,
  latestRoomMessageId,
  runFloorManager,
  createConductorModelInvoker,
  createLiveShadowDataOperationPolicyBinding,
  isExplicitConductorSource,
  resolveRoomSideModelId,
  buildRoutingView,
  eventBus,
  InMemoryLaneLock,
  turnContextKey,
  type ConductorDecision,
  type RoomHistoryHit,
  type RoomMemberView,
} from "@nautilo/runtime";
import { fromRuntimeConfig } from "@nautilo/config";
import type {
  ChatAttachmentStatus,
  SendMessageResponse,
  ActiveMiniAppRequestContext,
  ChatArtifactRef,
  ChatFocusedResourceRef,
  LiveMiniAppSessionCapability,
  TrustedLiveMiniAppSessionContext,
  ConductorDecisionReceiptEvent,
} from "@nautilo/types";
import { normalizeHumanMessageText } from "@nautilo/types";
import {
  envelopeReadableNamespaces,
  envelopeWritableNamespaces,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";
import {
  defaultChatRoutesDeps,
  defaultReplyToMessageInRoom,
  type ChatRoutesDeps,
} from "../routes/chat";
import {
  normalizeChatAttachments,
  parseChatAttachmentRefs,
  retainedAttachmentIdsFromStatuses,
  validateClientPathSafe,
} from "./attachments";
import { parseChatArtifactRefs, collectWorkspaceArtifactExternalIds } from "./artifact-refs";
import { parseChatFocusedResourceRefs } from "./focused-resources";
import { sanitizeActiveMiniAppContextSafe } from "./active-mini-app-context";
import { resolveTrustedLiveMiniAppSession } from "./live-mini-app-session-context";
import {
  executeAgentMediatedRoomMessage,
  AgentMediatedSendError,
} from "./agent-mediated";
import { resolveSubthreadRootAffinity } from "../lib/subthread-root-affinity";
import {
  clearPendingAgentRedirect,
  isRedirectAllowedForConductorWake,
  registerPendingAgentRedirect,
  type PendingAgentRedirectContext,
} from "./agent-redirect-handler";
import { finalizeProtectedHumanPeerMessage, peerBroadcastHumanMessage, roomIsArchived, roomRowExists } from "./peer-broadcast";
import { resolveSkillSlashCommandContent } from "./skill-slash-command";
import { resolveCommandSlashCommandContent } from "./command-slash-command";
import {
  hasAwaitingTaskReply,
  maybeResumeAwaitingTask,
} from "./await-resume";
import {
  classifyConductorDecision,
  classifyRoutingError,
  type SafeDecisionOutcome,
} from "../realtime/ws-publisher";
import { sanitizeRoutingTrace } from "./conductor-observability";
import {
  ConductorCoalescer,
  type CoalescedConductorRoutingItem,
  type ConductorRoutingItem,
} from "./conductor-coalescer";
import {
  getMaintenanceGate,
  type MaintenanceGate,
  type MaintenanceAcceptanceAuthority,
  createMaintenanceAcceptanceAuthority,
} from "@nautilo/runtime";
import type { ForegroundTurnCandidate } from "@nautilo/runtime";
import {
  isMaintenanceDrainError,
  replyMaintenanceRejection,
} from "../lib/maintenance-rejection";
import { getClientActionBindingRegistry } from "../realtime/client-action-binding-registry";
import {
  parseMentionEveryone,
  parseStructuredHumanMentionIds,
  StructuredHumanMentionError,
} from "./structured-human-mentions";
import type { VerifiedOrdinaryOrigin } from "@nautilo/types";
import {
  getProductionLiveShadowMessageComposition,
  type ProductionLiveShadowMessageComposition,
} from "../routes/live-shadow-message-composition";
import {
  classifyLiveShadowBoundaryFailure,
  currentStrictShadowPolicy,
  enforceRegisteredStrictShadowBoundary,
  rejectChangedStrictShadowPolicy,
  StrictShadowDispatchError,
  strictShadowHttpBody,
  strictShadowHttpStatus,
} from "../lib/strict-shadow-policy";

export type RoomPostMessageBody = {
  content?: string;
  /** M282 — Browser-prepared protected sibling for the same ordinary text. */
  liveShadow?: unknown;
  /**
   * D513 Phase 3.1 — raw optional session input carried only to the future
   * pre-enqueue binding seam. It is intentionally neither persisted nor
   * model-visible in this transport-only phase.
   */
    clientActionSessionId?: unknown;
  /** M233 — picker-authored stable Human recipient ids; never inferred from content. */
  mentionedHumanUserIds?: unknown;
  /** Structured Room-wide Human mention intent. */
  mentionEveryone?: boolean;
  replyToMessageId?: number | null;
  attachments?: unknown;
  /** D356 — metadata-only "focus on these artifacts" references (validated downstream). */
  artifactRefs?: unknown;
  /**
   * D423 Phase 4 — generic discriminated "focus on these resources" refs
   * (workspace artifact / local file). Shape/bounds validated here; kind
   * resolvers run downstream where the memory envelope is canonical.
   */
  focusedResources?: unknown;
  /** Closed literal used only by the Advanced video workcard. */
  cardContinuation?: unknown;
  voiceMode?: boolean;
  autoApprove?: boolean;
  currentFolder?: string | null;
  currentFolderRelayId?: string | null;
  workspacePath?: string | null;
  activeMiniApp?: ActiveMiniAppRequestContext | null;
  liveMiniAppSession?: LiveMiniAppSessionCapability | TrustedLiveMiniAppSessionContext | null;
  laneKey?: string;
  /**
   * D371 R2 — optional per-turn model override. When a non-empty string that
   * resolves via `getModelById(...)` in the executor, it overrides the agent
   * profile default for THIS turn only (per-thread override, decision A).
   * Otherwise dropped (behavior unchanged). Inert until R3 wires UI to set it.
   */
  model?: string | null;
  /**
   * M087 — IANA timezone auto-detected by the client. Validated +
   * resolved inside `executeAgentMediatedRoomMessage` (reads `request.body`
   * directly); declared here so the canonical room-message body type allows
   * it. Invalid/omitted → `users.timezone ?? "UTC"`.
   */
  userTimezone?: string | null;
  /**
   * M134 Phase 4 — optional UI-selected bot (opens/continues focus without a
   * `@mention`). Must be the actor id of an agent member of the room.
   */
  uiSelectedBotActorId?: string | null;
  /**
   * D302 R13 — ask_user resume: the original message's `humanTurnId` (from the
   * `conductor.ask_user` event). When set on a `uiSelectedBotActorId` send, the
   * wake path reuses it as the bot-turn `sharedTurnId` so the re-sent human row
   * shares the persisted row's fingerprint and the read-time collapse dedupes
   * it (no double-post). Ignored on non-resume sends.
   */
  resumeTurnId?: string | null;
  /** D302 P4 — persisted human message id for an ask_user resume (exclude from context block). */
  resumeMessageId?: number | null;
  /**
   * M135 P7 — explicit "search room history" UI signal. When true the
   * Conductor consults the room-history evidence route regardless of reply
   * structure. Optional; defaults to false.
   */
  searchHistoryFlag?: boolean | null;
};

function decodeCanonicalBase64url(value: string): Uint8Array | null {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length > 0 && decoded.toString("base64url") === value
      ? new Uint8Array(decoded)
      : null;
  } catch {
    return null;
  }
}

/**
 * A prepared Full request has to choose the direct or conductor topology
 * before protected admission runs. Reading this content-free signed-plan bit
 * is only a routing hint: the admission result later replaces it as the
 * authoritative intent before persistence or conductor classification.
 */
function preparedEveryoneRoutingHint(raw: unknown, roomId: string): boolean {
  const parsed = liveShadowMessageSendAttemptV1Schema.safeParse(raw);
  if (
    !parsed.success
    || parsed.data.status !== "prepared"
    || !("authorizationScheme" in parsed.data)
    || (parsed.data.authorizationScheme !== "human_ai_readable_v1"
      && parsed.data.authorizationScheme !== "human_ai_readable_v2")
  ) return false;
  const planBytes = decodeCanonicalBase64url(parsed.data.planBytesBase64url);
  if (planBytes === null) return false;
  try {
    const plan = decodeHumanAiReadableLiveShadowMessagePlan(planBytes);
    try {
      return plan.roomId === roomId && plan.mentionEveryone === true;
    } finally {
      plan.namespaceHeadDigest.fill(0);
      plan.namespacePublicationDigest.fill(0);
      plan.namespacePublicationSetDigest.fill(0);
      plan.namespaceAudienceFingerprint.fill(0);
    }
  } catch {
    return false;
  } finally {
    planBytes.fill(0);
  }
}

const MAX_CURRENT_FOLDER_RELAY_ID_LENGTH = 256;
/**
 * Match the legacy route's bounded, control-free relay-id shape. A
 * well-formed id remains opaque until agent-mediated dispatch verifies the
 * owner-paired live relay; an unpaired id remains explicit and fails stale.
 */
function parseCurrentFolderRelayId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CURRENT_FOLDER_RELAY_ID_LENGTH &&
    ![...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    })
  ) {
    return value;
  }
  return null;
}

function parseAdvancedVideoWorkcardContinuation(args: {
  value: unknown;
  content: string;
  attachmentRefs: readonly string[];
  artifactRefs: readonly ChatArtifactRef[];
  focusedResources: readonly ChatFocusedResourceRef[];
}): { kind: "advanced_video"; referenceCount: number } | null {
  if (args.value === undefined || args.value === null) return null;
  if (args.value !== "advanced_video") {
    throw new TypeError("invalid cardContinuation");
  }
  if (
    !args.content.startsWith("Continue the Advanced Seedance reference-to-video brief from the workcard") ||
    args.attachmentRefs.length !== 0 ||
    args.artifactRefs.length !== 0 ||
    args.focusedResources.length < 1 ||
    args.focusedResources.length > 30 ||
    args.focusedResources.some((resource) => resource.kind !== "workspace-artifact")
  ) {
    throw new TypeError("invalid advanced video workcard continuation");
  }
  return { kind: "advanced_video", referenceCount: args.focusedResources.length };
}

/**
 * M135 P6 — context window bounds for the woken-bot composite block.
 * `WINDOW_CAP` caps the DB fetch of "messages since the bot last spoke";
 * `MAX_LINES` caps the rendered block (oldest-first elision beyond it). The
 * cap keeps a bot that has been silent through a very long burst from pulling
 * unbounded history while still capturing the full recent diff.
 */
/**
 * D271 — build the uploaded-attachment normalize args from the turn's envelope
 * + sender actor. The capability fence is enforced inside
 * `normalizeChatAttachments` against (uploaderActorId, writableNamespaceId).
 */
function uploadedAttachmentArgs(
  attachmentRefs: readonly string[],
  uploaderActorId: string | null | undefined,
  env: MemoryAccessEnvelope | null | undefined,
): {
  attachmentIds: readonly string[];
  uploaderActorId: string;
  writableNamespaceId: string | null;
  readableNamespaceIds: readonly string[];
} {
  return {
    attachmentIds: attachmentRefs,
    uploaderActorId: uploaderActorId ?? "",
    writableNamespaceId: env ? (envelopeWritableNamespaces(env)[0] ?? null) : null,
    readableNamespaceIds: env ? envelopeReadableNamespaces(env) : [],
  };
}

/**
 * D391 — after the human message is persisted, stamp this turn's retained
 * attachments (images + audio) with the M134 `fingerprint` of the just-
 * inserted human row. The room history read joins attachments -> the deduped
 * message by `turn_id` (= fingerprint), so an attachment renders once per
 * turn regardless of how many per-bot copies of the message exist. Best-
 * effort: a stamp failure is logged, never fatal - the message already went
 * out; a missing link just means the image won't render from history, not a
 * send failure.
 */
async function stampRetainedAttachmentTurnId(
  messageId: number | null,
  statuses: readonly ChatAttachmentStatus[],
): Promise<void> {
  if (messageId == null) return;
  const retainedIds = retainedAttachmentIdsFromStatuses(statuses);
  if (retainedIds.length === 0) return;
  const fingerprint = await getSessionMessageFingerprintById(messageId);
  if (!fingerprint) {
    log(`[d391] could not resolve human fingerprint for messageId=${messageId}; ${retainedIds.length} attachment(s) will not be linked to history`);
    return;
  }
  await stampTurnIdOnAttachments({ attachmentIds: retainedIds, turnId: fingerprint });
}

type PersistedHumanForRouting = {
  messageId: number | null;
  humanTurnId: string;
  attachments: ChatAttachmentStatus[];
  coalesced: boolean;
  routingView?: ReturnType<typeof buildRoutingView>;
  representationMode?: "shadow_encryption" | "full_encryption";
  sharedAgentOperationId?: string;
  sharedAgentProtectedMessage?: import("@nautilo/types").ProtectedMessageDtoV2;
  sharedAgentFallback?: Readonly<{
    operationId: string;
    reason:
      | "request_invalid"
      | "authority_stale"
      | "human_parity_failed"
      | "human_persistence_failed"
      | "deadline_expired"
      | "integrity_conflict";
    messageId: number | null;
  }>;
};

type GroupRoomConductorAfterPersistArgs = {
  detail: RoomDetailPayload;
  chatDeps: ChatRoutesDeps;
  request: FastifyRequest;
  sessionUserId: string;
  sessionActorId: string;
  ordinaryOrigin?: VerifiedOrdinaryOrigin;
  content?: string;
  representationMode?: "shadow_encryption" | "full_encryption";
  voiceMode: boolean;
  autoApprove: boolean;
  currentFolder: string | null;
  currentFolderRelayId: string | null;
  workspacePath: string | null;
  activeMiniApp: ActiveMiniAppRequestContext | null;
  liveMiniAppSession: TrustedLiveMiniAppSessionContext | null;
  attachmentRefs: string[];
  artifactRefs: ChatArtifactRef[];
  /**
   * D423 Phase 4 — generic focus refs (workspace artifact / local file).
   * Unioned (kind-specific dedupe) on coalesce; resolved into the common
   * manifest inside `executeAgentMediatedRoomMessage`.
   */
  focusedResources: ChatFocusedResourceRef[];
  mentionedHumanUserIds: string[];
  mentionEveryone: boolean;
  replyToMessageId?: number;
  uiSelectedBotActorId: string | null;
  resumeTurnId?: string;
  searchHistoryFlag: boolean;
  /**
   * D371 R2 — per-turn model override (nullable string). Forwarded to the
   * agent-mediated send and the executor; null means "no override" (behavior
   * unchanged). See {@link RoomPostMessageBody.model}.
   */
  model?: string | null;
  burstHint?: {
    count: number;
    coveredMessageIds?: Array<number | null>;
    coveredSharedAgentOperationIds?: string[];
  };
  buildEnvelopeForRoom: NonNullable<ChatRoutesDeps["buildEnvelopeForRoom"]>;
  persistedHuman: PersistedHumanForRouting;
  /**
   * D420 (Wave 2 task 2.2.1) — acceptance authority minted at the HTTP
   * boundary. Carried through the async conductor wake so the drain gate
   * inside `createForegroundJob` bypasses a turn accepted before drain.
   */
  acceptanceAuthority?: MaintenanceAcceptanceAuthority;
  /** M254 — Human invocation admission for this accepted Room turn. */
  invocationAuthority: AcceptedInvocationAuthority;
  /** D513 — same process-local registry that created the opaque handle. */
  clientActionBindingRegistry?: ReturnType<typeof getClientActionBindingRegistry>;
  /** One reservation's private surface context; never enters routing items or persistence. */
  foregroundTurnCoalescingContext?: NonNullable<ForegroundTurnCandidate["coalescingContext"]>;
  clientActionSessionId?: string;
};

type ConductorWakeBot = { actorId: string; agentId: string };

/**
 * D421 Phase 4.3 — canonical per-bot conductor wake body. Both the initial
 * source wake and the accepted redirect target reuse this exact helper, so
 * the target inherits the original validated payload without a duplicate
 * runner, human persist, or room broadcast.
 */
async function enqueueConductorBotWake(args: {
  source: GroupRoomConductorAfterPersistArgs;
  content: string;
  bot: ConductorWakeBot;
  roster: Awaited<ReturnType<ChatRoutesDeps["loadRoomRoster"]>>;
  envelope: MemoryAccessEnvelope;
  explicitlySelected: boolean;
  redirectAllowed: boolean;
  redirectDepth?: 1;
  sharedAgentAuthorization?: Readonly<{
    executionId: string;
    capability: import("@nautilo/lattice-bridge/server")
      .ForegroundLiveShadowSessionExecutionCapability;
  }>;
}): Promise<void> {
  const { source, bot, roster, envelope } = args;
  const liveShadowPolicy = args.sharedAgentAuthorization === undefined
    ? null
    : await strictShadowPolicyReader(source.chatDeps)();
  const botLaneKey =
    `room:${source.detail.id}:user:${source.sessionActorId}:bot:${bot.agentId}`;
  const botGraphThreadId = botThreadId(source.detail.id, bot.agentId);
  await executeAgentMediatedRoomMessage({
    request: source.request,
    deps: source.chatDeps,
    content: args.content,
    voiceMode: source.voiceMode,
    autoApprove: source.autoApprove,
    currentFolder: source.currentFolder,
    currentFolderRelayId: source.currentFolderRelayId,
    workspacePath: source.workspacePath,
    activeMiniApp: source.activeMiniApp,
    liveMiniAppSession: source.liveMiniAppSession,
    attachmentRefs: source.attachmentRefs,
    artifactRefs: source.artifactRefs,
    focusedResources: source.focusedResources,
    mentionedHumanUserIds: source.mentionedHumanUserIds,
    mentionEveryone: source.mentionEveryone,
    ...(source.ordinaryOrigin ? { ordinaryOrigin: source.ordinaryOrigin } : {}),
    ...(source.model ? { model: source.model } : {}),
    ...(source.replyToMessageId !== undefined
      ? { replyToMessageId: source.replyToMessageId }
      : {}),
    canonicalRoomId: source.detail.id,
    canonicalAgentId: bot.agentId,
    canonicalGraphThreadId: botGraphThreadId,
    canonicalRoomRoster: roster,
    canonicalLaneKey: botLaneKey,
    canonicalMemoryAccessEnvelope: envelope,
    transcriptOwnerId: source.sessionUserId,
    explicitlySelected: args.explicitlySelected,
    sharedTurnId: source.persistedHuman.humanTurnId,
    ...(args.sharedAgentAuthorization
      ? {
          liveShadowOperationId: args.sharedAgentAuthorization.executionId,
          liveShadowCapability: args.sharedAgentAuthorization.capability,
          liveShadowEnforcementPolicy: {
            mode: liveShadowPolicy!.mode,
            shadowBehavior: liveShadowPolicy!.shadowBehavior,
            revision: liveShadowPolicy!.revision,
          },
          liveShadowDataOperationPolicy: createLiveShadowDataOperationPolicyBinding(
            strictShadowPolicyReader(source.chatDeps),
          ),
          liveShadowObserveBoundary: async (decision) => {
            const observed = await strictShadowBoundaryEnforcer(
              source.chatDeps,
            )({
              ...decision,
              boundaryId: decision.boundaryId
                ?? "conversation.write.runtime_persist",
              retryable: decision.retryable ?? false,
            });
            rejectChangedStrictShadowPolicy(liveShadowPolicy!, observed);
          },
          liveShadowRunAgentTurn: <Value>(input: Readonly<{
            operationId: string;
            capability: import("@nautilo/lattice-bridge/server")
              .LiveShadowExecutionCapability;
            entrypointId?: "foreground.main" | "foreground.fork";
            work(
              session: import("@nautilo/lattice-bridge/server")
                .LiveShadowAgentTurnSession,
              openedHumanContent?: string,
              authorizationSignal?: AbortSignal,
            ): Promise<Value>;
          }>) => getProductionLiveShadowMessageComposition(
            source.request.server,
          )!.runAgentTurn({
            ...input,
            ...(source.representationMode === "full_encryption"
              ? { representationMode: "full_encryption" as const }
              : { expectedMergedHumanContent: args.content }),
          }),
        }
      : {}),
    ...(source.foregroundTurnCoalescingContext
      ? { foregroundTurnCoalescingContext: source.foregroundTurnCoalescingContext }
      : {}),
    humanAlreadyPersisted: true,
    memoryReviewSourceMessageIds: [...new Set([
      ...(source.burstHint?.coveredMessageIds ?? []),
      source.persistedHuman.messageId,
    ].filter((id): id is number => id !== null))],
    ...(source.detail.kind === "subthread" && source.detail.parentRoomId
      ? { subthreadParentRoomId: source.detail.parentRoomId }
      : {}),
    ...(source.detail.kind === "subthread" &&
    source.detail.threadRootMessageId != null
      ? { subthreadAnchorMessageId: source.detail.threadRootMessageId }
      : {}),
    ...(source.detail.kind === "subthread" ? { subthreadRoomId: source.detail.id } : {}),
    ...(source.persistedHuman.messageId != null
      ? { currentMessageId: source.persistedHuman.messageId }
      : {}),
    ...(source.acceptanceAuthority
      ? { acceptanceAuthority: source.acceptanceAuthority }
      : {}),
    invocationAuthority: source.invocationAuthority,
    ...(args.redirectAllowed ? { redirectAllowed: true } : {}),
    ...(args.redirectDepth === 1 ? { redirectDepth: 1 as const } : {}),
  });
}

const conductorRoomLock = new InMemoryLaneLock();
const conductorRoutingContexts = new Map<string, GroupRoomConductorAfterPersistArgs>();
const conductorCoalescer = new ConductorCoalescer(
  setTimeout,
  clearTimeout,
  (_key, merged) => {
    void flushCoalescedGroupRoomConductorAfterPersist(merged).catch((err) => {
      log(
        `[conductor] coalesced async route/wake failed for room=${merged.roomId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  },
);

// M171 (Phase H) — the legacy transient context blocks (peer-diff +
// `buildSubthreadContextBlock`, deduped against the checkpoint via
// `readGraphCheckpointText`) were deleted here: every flow now rebuilds the
// full labelled history from the DB transcript in `resolveForegroundHistoryMessages`
// (M168), which subsumes them. Only the live turn message is threaded forward.

/**
 * M135 P8 — one structured log line per Conductor decision. Floor-manager
 * outcomes read distinctly from deterministic routes via the controlled
 * `reasonCode`.
 *
 * D421 Phase 3 (3.1.1/3.1.3) — the always-on log exposes ONLY controlled
 * fields: the terminal decision `kind`, the server-classified `reasonCode`
 * (never the raw `decision.reason`, which for Floor Manager outcomes can
 * carry model-generated semantic detail), the `source`, the selected public
 * `woke` handles, and a sanitized trace reduced to counts/booleans/enums.
 * Raw user content, transcript snippets, the raw search query, raw
 * provider/Floor Manager error text, and any future redirect tool reason
 * cannot reach this line: `classifyConductorDecision` collapses any
 * unrecognized reason to a generic `*_router` code, and
 * `sanitizeRoutingTrace` strips every non-enum string from the trace.
 */
function logConductorDecision(
  roomId: string,
  userActorId: string,
  decision: ConductorDecision,
  woke?: string,
  trace?: Array<{ step: string; detail: Record<string, unknown> }>,
): void {
  const source = decision.kind === "wake" ? decision.source : "-";
  const reasonCode = classifyConductorDecision(decision).reasonCode;
  const sanitized = sanitizeRoutingTrace(trace ?? []);
  const path =
    sanitized.length > 0 ? ` path=${JSON.stringify(sanitized)}` : "";
  log(
    `[conductor] room=${roomId} user=${userActorId} decision=${decision.kind} ` +
      `reasonCode=${reasonCode} source=${source} woke=${woke ?? "-"}${path}`,
  );
}

/**
 * Stack-162 — emit a requester-private `conductor.decision` receipt carrying a
 * privacy-safe explanation of the terminal routing decision. Delivered only to
 * the requester's WS connections (`inferDeliveryScope` routes by `userId`).
 * `displayReason`/`reasonCode` come from the server-side classifier — never
 * from the raw model reason. `selectedHandles` only for wake; `options` only
 * for ask_user.
 */
function emitConductorDecisionReceipt(
  args: {
    detail: RoomDetailPayload;
    sessionUserId: string;
    sessionActorId: string;
    persistedHuman: PersistedHumanForRouting;
    outcome: SafeDecisionOutcome;
    selectedHandles?: string[];
    options?: { botActorId: string; handle: string }[];
  },
): void {
  const event: ConductorDecisionReceiptEvent = {
    type: "conductor.decision",
    laneKey: `room:${args.detail.id}`,
    roomId: args.detail.id,
    userId: args.sessionUserId,
    userActorId: args.sessionActorId,
    messageId:
      args.persistedHuman.messageId != null ? String(args.persistedHuman.messageId) : null,
    humanTurnId: args.persistedHuman.humanTurnId,
    outcome: args.outcome.outcome,
    reasonCode: args.outcome.reasonCode,
    displayReason: args.outcome.displayReason,
    ...(args.selectedHandles ? { selectedHandles: args.selectedHandles } : {}),
    ...(args.options ? { options: args.options } : {}),
  };
  eventBus.emit(event);
}

type ConductorDebugLevel = "off" | "trace" | "prompt";

function conductorDebugLevel(): ConductorDebugLevel {
  const raw = (process.env["NAUTILO_CONDUCTOR_DEBUG"] ?? "").trim().toLowerCase();
  return raw === "trace" || raw === "prompt" ? raw : "off";
}

function conductorDebugRoomMatches(detail: RoomDetailPayload): boolean {
  const raw = (process.env["NAUTILO_CONDUCTOR_DEBUG_ROOM"] ?? "").trim();
  if (!raw) return true;
  return raw === detail.id || raw === detail.label;
}

function conductorDebugLog(
  detail: RoomDetailPayload,
  phase: string,
  payload: Record<string, unknown>,
): void {
  log(`[conductor-debug] room=${detail.id} label=${JSON.stringify(detail.label)} phase=${phase} ${JSON.stringify(payload)}`);
}

function legacyAliasSuccessBody(
  roomId: string,
  attachments: ChatAttachmentStatus[],
  coalesced: boolean,
  jobId: string | null,
): SendMessageResponse {
  return {
    jobId,
    laneKey: `room:${roomId}`,
    accepted: true,
    attachments,
    coalesced,
  };
}

type AppWithChatDeps = FastifyInstance & { nautiloChatDeps?: ChatRoutesDeps };

function resolvedChatRoutesDeps(app: FastifyInstance, optsChatDeps?: ChatRoutesDeps): ChatRoutesDeps {
  return optsChatDeps ?? (app as AppWithChatDeps).nautiloChatDeps ?? defaultChatRoutesDeps;
}

function strictShadowPolicyReader(
  deps: ChatRoutesDeps,
): typeof currentStrictShadowPolicy {
  return deps.currentStrictShadowPolicy ?? currentStrictShadowPolicy;
}

function strictShadowBoundaryEnforcer(
  deps: ChatRoutesDeps,
): typeof enforceRegisteredStrictShadowBoundary {
  return deps.enforceStrictShadowBoundary ?? enforceRegisteredStrictShadowBoundary;
}

export async function routeConductorWithDataOwner<Result>(input: Readonly<{
  readPolicy: () => Promise<Readonly<{
    mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
    shadowBehavior: "fallback" | "strict";
    revision: number;
  }>>;
  ordinary: () => Promise<Result>;
  protected: () => Promise<Result>;
}>): Promise<Result> {
  const owner = bindEncryptionDataOperationOwner({
    policy: {
      async resolve() {
        const policy = await input.readPolicy();
        return { policy, revalidationToken: policy.revision };
      },
      async revalidate(expectedRevision) {
        const current = await input.readPolicy();
        if (current.revision !== expectedRevision) {
          throw new ClassifiedDataOperationError("stale", "Conductor policy changed");
        }
      },
    },
  });
  const routed = await owner.read({
    ordinary: input.ordinary,
    protected: input.protected,
    consumeOrdinary: (value) => value,
    consumeProtected: (value: Result) => value,
  });
  return routed.value;
}

export async function dispatchRoomMessageSend(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  opts: {
    roomId: string;
    body: RoomPostMessageBody;
    getRoomDetailForMember: (
      roomId: string,
      requesterActorId: string,
    ) => Promise<RoomDetailPayload | null>;
    /** Injected in `/api/chat` tests; production defaults to `defaultChatRoutesDeps`. */
    chatDeps?: ChatRoutesDeps;
    /**
     * D420 (Wave 2 task 2.2.1) — maintenance admission gate. Defaults to the
     * runtime singleton (production gate wired by `createApp`). Injected in
     * unit tests so the drain rejection can be exercised DB-free.
     */
    maintenanceGate?: MaintenanceGate;
    /** M254 — injected only by hermetic route tests. */
    assertCanInvokeAgent?: (input: AgentInvocationAdmissionInput) => Promise<void>;
    /**
     * When true (POST `/api/chat` alias only): success responses use HTTP **202** for
     * every branch (including human-only) and JSON matches deprecated `SendMessageResponse`
     * (`laneKey` is always `room:<roomId>` per D174 Phase 11.2 MR3).
     */
    aliasHttpContract?: boolean;
    /** Verified paired-mobile provenance for this exact ordinary send. */
    ordinaryOrigin?: VerifiedOrdinaryOrigin;
    /** M297 — injectable exact-pair admission seam for route tests. */
    humanPairIsBlocked?: (firstUserId: string, secondUserId: string) => Promise<boolean>;
  },
): Promise<void> {
  const gate = opts.maintenanceGate ?? getMaintenanceGate();
  const memoryOwnerId = request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
  const sessionUserId = request.sessionUserId ?? memoryOwnerId;
  const sessionActorId = request.sessionActorId;
  if (!memoryOwnerId || !sessionActorId) {
    return reply.code(401).send({ error: "Authentication required" });
  }

  const roomId = opts.roomId.trim();
  if (!isUuidString(roomId)) {
    return reply.code(400).send({ error: "invalid room id" });
  }

  // Legacy `/api/chat` rejects explicit `body.roomId` that disagrees with the
  // resolver-stamped envelope. Canonical `POST /api/rooms/:id/messages` must not
  // apply this guard — the URL room is authoritative and the envelope may still
  // point at another room until the client refreshes context.
  if (opts.aliasHttpContract === true) {
    const memRoom = request.memoryEnvelope?.roomId ?? "";
    if (memRoom && memRoom !== roomId) {
      return reply.code(404).send({ error: "Room not found or unavailable" });
    }
  }

  const detail = await opts.getRoomDetailForMember(roomId, sessionActorId);
  if (!detail) {
    if (await roomRowExists(roomId)) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    return reply.code(404).send({ error: "Not found" });
  }

  const directHumanPeer = directHumanPeerUserId(detail.members, sessionUserId);
  if (
    detail.members.length === 2 &&
    detail.members.every((member) => member.kind === "user") &&
    directHumanPeer === null
  ) {
    return reply.code(500).send({ error: "direct_human_identity_unavailable" });
  }
  const directPairBlocked = directHumanPeer === null
    ? false
    : opts.humanPairIsBlocked
      ? await opts.humanPairIsBlocked(sessionUserId, directHumanPeer)
      : await humanPairIsBlocked(getSharedDirectDb(), sessionUserId, directHumanPeer);
  if (directPairBlocked) {
    return reply.code(403).send({
      error: "direct_human_interaction_blocked",
      code: "direct_human_interaction_blocked",
    });
  }

  // D298 — archived rooms are frozen/read-only. Reject the message here, which
  // also prevents the agent turns it would trigger (this is the single send
  // chokepoint for human messages + agent replies).
  if (await roomIsArchived(roomId)) {
    return reply
      .code(403)
      .send({ error: "This room is archived (read-only).", code: "room_archived" });
  }

  // A caller that explicitly attempts protected delivery must speak the exact
  // current wire contract. Validate at the shared HTTP entrance, before room
  // topology selects a direct, Human-only, or Conductor path; otherwise one of
  // those branches could mistake an unknown future policy for absent Shadow
  // data and silently persist plaintext.
  const parsedLiveShadowAttempt = opts.body.liveShadow === undefined
    ? null
    : liveShadowMessageSendAttemptV1Schema.safeParse(opts.body.liveShadow);
  if (
    parsedLiveShadowAttempt?.success === false
    || (parsedLiveShadowAttempt?.success === true
      && parsedLiveShadowAttempt.data.status === "prepared"
      && !preparedAuthorizationSchemeMatchesWireFormat(
        parsedLiveShadowAttempt.data,
      ))
  ) {
    return reply.code(400).send({
      error: "invalid_live_shadow_attempt",
      code: "invalid_live_shadow_attempt",
    });
  }

  const voiceMode = opts.body.voiceMode === true;
  // A client boolean is posture, not authority. It only survives for a
  // bearer-authenticated, verified Human. Agent invocation authority is
  // checked independently before any Agent work is accepted.
  const autoApprove =
    opts.body.autoApprove === true &&
    typeof request.sessionUserId === "string" &&
    request.sessionUserId.length > 0 &&
    request.policyContext?.speakerTrust === "verified";
  // D371 R2 — per-turn model override. Trim + non-empty wins; empty/absent
  // drops to null (behavior unchanged). Resolution against `getModelById`
  // happens in the executor (`langgraph-executor.ts`); the server only
  // forwards the raw string here.
  const model =
    typeof opts.body.model === "string" && opts.body.model.trim()
      ? opts.body.model.trim()
      : null;
  let currentFolder: string | null = null;
  let currentFolderRelayId: string | null = null;
  let workspacePath: string | null = null;
  let activeMiniApp: ActiveMiniAppRequestContext | null = null;
  let liveMiniAppSession: TrustedLiveMiniAppSessionContext | null = null;
  let attachmentRefs: string[] = [];
  let artifactRefs: ChatArtifactRef[] = [];
  let focusedResources: ChatFocusedResourceRef[] = [];
  // D304 — currentFolder / workspacePath are advisory prompt context; a bad or
  // blocked value drops to null and never blocks the message. Only attachment
  // refs (a real capability) fail closed.
  currentFolder = validateClientPathSafe(opts.body.currentFolder, "currentFolder");
  currentFolderRelayId = parseCurrentFolderRelayId(opts.body.currentFolderRelayId);
  workspacePath = validateClientPathSafe(opts.body.workspacePath, "workspacePath");
  activeMiniApp = sanitizeActiveMiniAppContextSafe(opts.body.activeMiniApp);
  liveMiniAppSession = await resolveTrustedLiveMiniAppSession({
    raw: opts.body.liveMiniAppSession,
    userId: sessionUserId,
  });
  try {
    attachmentRefs = parseChatAttachmentRefs(opts.body.attachments);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(400).send({ error: msg });
  }
  try {
    // D356 — metadata-only artifact references. Shape/bounds here; namespace
    // resolution happens downstream (executeAgentMediatedRoomMessage) where the
    // memory envelope is canonical.
    artifactRefs = parseChatArtifactRefs(opts.body.artifactRefs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(400).send({ error: msg });
  }
  try {
    // D423 — generic focus refs. Shape/bounds here; kind resolvers run
    // downstream. Local-file refs fail closed this phase (no relay identity).
    focusedResources = parseChatFocusedResourceRefs(opts.body.focusedResources);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(400).send({ error: msg });
  }

  // D424 — ArtifactOpenCard authoring inputs: the external workspace-artifact
  // ids drawn from BOTH focus lanes (legacy `artifactRefs` + `focusedResources`
  // kind `workspace-artifact`; local-file / message-attachment focus never
  // become cards), plus the canonical room namespace id that gates which
  // artifacts become cards. Best-effort: a missing namespace id ⇒ no cards.
  const workspaceArtifactExternalIds = collectWorkspaceArtifactExternalIds({
    artifactRefs,
    focusedResources,
  });
  const canonicalRoomNamespaceId = workspaceArtifactExternalIds.length > 0
    ? await getRoomNamespaceId(detail.id).catch(() => null)
    : null;

  const fullPrepared = typeof opts.body.liveShadow === "object"
    && opts.body.liveShadow !== null
    && "requestVersion" in opts.body.liveShadow
    && opts.body.liveShadow.requestVersion === 2;
  let mentionEveryone: boolean;
  try {
    mentionEveryone = parseMentionEveryone(opts.body.mentionEveryone);
  } catch (err) {
    if (err instanceof StructuredHumanMentionError) {
      return reply.code(400).send({
        error: "invalid_mention_everyone",
        code: "invalid_mention_everyone",
        message: err.message,
      });
    }
    throw err;
  }
  const mentionEveryoneRoutingHint = fullPrepared
    ? preparedEveryoneRoutingHint(opts.body.liveShadow, detail.id)
    : mentionEveryone;
  // Full-encryption intent is accepted only from a successfully verified
  // signed plan later in the protected admission path.
  if (fullPrepared) mentionEveryone = false;
  if (fullPrepared && detail.members.every((member) => member.kind === "user")) {
    if (attachmentRefs.length > 0 || workspaceArtifactExternalIds.length > 0
      || opts.body.replyToMessageId != null || opts.body.cardContinuation != null
      || opts.body.activeMiniApp != null || opts.body.liveMiniAppSession != null) {
      return reply.code(400).send({ error: "full_encryption_payload_unsupported" });
    }
    return dispatchHumanOnlyRoomMessage(request, reply, {
      detail,
      chatDeps: resolvedChatRoutesDeps(app, opts.chatDeps),
      alias: opts.aliasHttpContract === true,
      sessionUserId,
      attachmentRefs: [], mentionedHumanUserIds: [], mentionEveryone,
      workspaceArtifactExternalIds: [],
      liveShadow: opts.body.liveShadow,
    });
  }
  const contentRaw = opts.body.content;
  if (typeof contentRaw !== "string" && !fullPrepared) {
    return reply.code(400).send({ error: "content must be a string" });
  }
  let content: string | undefined = typeof contentRaw === "string"
    ? normalizeHumanMessageText(contentRaw) : undefined;
  let advancedVideoWorkcardContinuation: { kind: "advanced_video"; referenceCount: number } | null;
  try {
    advancedVideoWorkcardContinuation = fullPrepared ? null : parseAdvancedVideoWorkcardContinuation({
      value: opts.body.cardContinuation,
      content: content!,
      attachmentRefs,
      artifactRefs,
      focusedResources,
    });
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : "invalid cardContinuation" });
  }
  let mentionedHumanUserIds: string[];
  try {
    mentionedHumanUserIds = parseStructuredHumanMentionIds(
      opts.body.mentionedHumanUserIds,
      detail,
    );
  } catch (err) {
    if (err instanceof StructuredHumanMentionError) {
      return reply.code(400).send({
        error: "invalid_mentioned_human_user_ids",
        code: "invalid_mentioned_human_user_ids",
        message: err.message,
      });
    }
    throw err;
  }

  const replyRaw = opts.body.replyToMessageId;
  let replyToMessageId: number | undefined;
  if (replyRaw !== undefined && replyRaw !== null) {
    if (typeof replyRaw !== "number" || !Number.isInteger(replyRaw) || replyRaw < 1) {
      return reply.code(400).send({ error: "replyToMessageId must be a positive integer" });
    }
    const inRoom = await defaultReplyToMessageInRoom(replyRaw, detail.id);
    if (!inRoom) {
      return reply.code(400).send({ error: "invalid replyToMessageId" });
    }
    replyToMessageId = replyRaw;
  }

  // M134 — optional UI-selected bot. Must name an agent member of the room.
  let uiSelectedBotActorId: string | null = null;
  const uiSelRaw = opts.body.uiSelectedBotActorId;
  if (uiSelRaw !== undefined && uiSelRaw !== null) {
    if (typeof uiSelRaw !== "string" || !isUuidString(uiSelRaw.trim())) {
      return reply.code(400).send({ error: "uiSelectedBotActorId must be a uuid" });
    }
    const sel = uiSelRaw.trim();
    const isAgentMember = detail.members.some(
      (m) => m.kind === "agent" && m.actorId === sel,
    );
    if (!isAgentMember) {
      return reply
        .code(400)
        .send({ error: "uiSelectedBotActorId must be an agent member of the room" });
    }
    uiSelectedBotActorId = sel;
  }

  // M135 P7 — optional explicit "search room history" UI flag.
  const searchHistoryFlag = opts.body.searchHistoryFlag === true;

  // D302 R13 — ask_user resume turn id (reuse the persisted human row's
  // fingerprint so the re-sent human message collapses, no double-post).
  const resumeTurnId =
    typeof opts.body.resumeTurnId === "string" && isUuidString(opts.body.resumeTurnId.trim())
      ? opts.body.resumeTurnId.trim()
      : undefined;
  const resumeMessageId =
    typeof opts.body.resumeMessageId === "number" &&
    Number.isInteger(opts.body.resumeMessageId) &&
    opts.body.resumeMessageId > 0
      ? opts.body.resumeMessageId
      : undefined;

  const agentMembers = detail.members.filter((m) => m.kind === "agent");
  const hasAgentMember = agentMembers.length > 0;
  const chatDeps = resolvedChatRoutesDeps(app, opts.chatDeps);
  const alias = opts.aliasHttpContract === true;

  // M254 R7 — an exact parked Task reply is ordinary Room history first,
  // including in the strict 1H+1A ask-peer DM shape. Persist it through the
  // shared Human-only path; the post-persist hook independently checks both
  // responder and durable requestor authority (plus maintenance) before the
  // one intended Task continuation. This also avoids a duplicate foreground
  // Agent turn alongside that continuation.
  if (!fullPrepared && hasAgentMember && await hasAwaitingTaskReply(detail.id, sessionUserId)) {
    return dispatchHumanOnlyRoomMessage(request, reply, {
      detail,
      chatDeps,
      alias,
      sessionUserId,
      ...(content === undefined ? {} : { content }),
      attachmentRefs,
      mentionedHumanUserIds,
      mentionEveryone,
      workspaceArtifactExternalIds,
      ...(canonicalRoomNamespaceId ? { canonicalRoomNamespaceId } : {}),
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    });
  }

  if (hasAgentMember) {
    const envelopeAgentId = request.memoryEnvelope?.agentId ?? "";
    const skillAgentId =
      envelopeAgentId && agentMembers.some((m) => m.agentId === envelopeAgentId)
        ? envelopeAgentId
        : (agentMembers[0]?.agentId ?? "");
    const humanCount = detail.members.filter((m) => m.kind === "user").length;
    const isDm = humanCount === 1 && agentMembers.length === 1;
    if (fullPrepared && (attachmentRefs.length > 0 || artifactRefs.length > 0
      || focusedResources.length > 0 || replyToMessageId !== undefined
      || opts.body.cardContinuation != null || opts.body.activeMiniApp != null
      || opts.body.liveMiniAppSession != null)) {
      return reply.code(400).send({ error: "full_encryption_payload_unsupported" });
    }
    let handledAgentSlash = false;
    if (skillAgentId && !fullPrepared) {
      const skillExpanded = await resolveSkillSlashCommandContent(
        content!,
        skillAgentId,
        sessionUserId,
      );
      content = skillExpanded.content;
      handledAgentSlash ||= skillExpanded.handled;
      const commandExpanded = await resolveCommandSlashCommandContent(
        content,
        skillAgentId,
        sessionUserId,
      );
      content = commandExpanded.content;
      handledAgentSlash ||= commandExpanded.handled;
    }
    // M134 §2 — a "DM" for routing is STRICTLY 1 human + 1 agent. Everything
    // else with ≥1 agent is a group room routed by the Conductor.
    if (advancedVideoWorkcardContinuation && !isDm) {
      return reply.code(400).send({ error: "advanced video workcards require a direct Genie room" });
    }

    // M254 R2 — classify validated explicit intent before persistence. Reuse
    // the canonical mention parser, reply-to-Agent lookup, UI validation, and
    // slash resolvers instead of introducing a second free-text grammar.
    const replyTargetActorId = replyToMessageId !== undefined
      ? await findReplyTargetAgentActorId(getSharedDirectDb(), detail.id, replyToMessageId)
      : null;
    const hasExplicitAgentTarget =
      handledAgentSlash ||
      uiSelectedBotActorId !== null ||
      (replyTargetActorId !== null &&
        agentMembers.some((member) => member.actorId === replyTargetActorId)) ||
      (typeof contentRaw === "string" && agentMembers.some(
        (member) =>
          typeof member.handle === "string" &&
          member.handle.length > 0 &&
          !(mentionEveryoneRoutingHint
            && member.handle.trim().toLowerCase() === "everyone") &&
          parseAgentMentions(contentRaw, member.handle).hasMention,
      ));
    const audienceOnlyDm = isDm
      && mentionEveryoneRoutingHint
      && !hasExplicitAgentTarget;

    let canInvokeAgent = true;
    try {
      await (opts.assertCanInvokeAgent ?? assertCanInvokeAgent)({
        humanUserId: sessionUserId,
        origin: "room_message",
        roomId: detail.id,
      });
    } catch (err) {
      if (!(err instanceof AgentInvocationDeniedError)) throw err;
      canInvokeAgent = false;
      if ((isDm && !audienceOnlyDm) || hasExplicitAgentTarget) {
        return reply.code(403).send(toActionCapabilityHttpDenial(err));
      }
    }

    // An incapable Human's ordinary mixed-Room message is still canonical
    // shared history. It takes the exact Human-only writer/realtime path and
    // deliberately bypasses maintenance and every conductor/Agent side effect.
    if (!canInvokeAgent) {
      return dispatchHumanOnlyRoomMessage(request, reply, {
        detail,
        chatDeps,
        alias,
        sessionUserId,
        ...(content === undefined ? {} : { content }),
        attachmentRefs,
        mentionedHumanUserIds,
        mentionEveryone,
        workspaceArtifactExternalIds,
        ...(canonicalRoomNamespaceId ? { canonicalRoomNamespaceId } : {}),
        ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
        liveShadow: opts.body.liveShadow,
      });
    }

    // Invocation Capability and maintenance are independent entrance gates.
    // Mint both opaque authorities only after both current decisions succeed.
    let acceptanceAuthority: MaintenanceAcceptanceAuthority;
    let invocationAuthority: AcceptedInvocationAuthority;
    try {
      await gate.assertAcceptingNewWork();
      acceptanceAuthority = createMaintenanceAcceptanceAuthority();
      invocationAuthority = createAcceptedInvocationAuthority(sessionUserId);
    } catch (err) {
      if (isMaintenanceDrainError(err)) return replyMaintenanceRejection(reply, err);
      throw err;
    }

    if (!isDm || mentionEveryoneRoutingHint) {
      return dispatchGroupRoomMessage(app, request, reply, {
        detail,
        chatDeps,
        alias,
        sessionUserId,
        sessionActorId,
        ...(content === undefined ? {} : { content }),
        ...(fullPrepared ? { representationMode: "full_encryption" as const } : {}),
        voiceMode,
        autoApprove,
        currentFolder,
        currentFolderRelayId,
        workspacePath,
        activeMiniApp,
        liveMiniAppSession,
        attachmentRefs,
        artifactRefs,
        focusedResources,
        mentionedHumanUserIds,
        mentionEveryone,
        ...(opts.ordinaryOrigin ? { ordinaryOrigin: opts.ordinaryOrigin } : {}),
        workspaceArtifactExternalIds,
        ...(canonicalRoomNamespaceId ? { canonicalRoomNamespaceId } : {}),
        ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
        uiSelectedBotActorId,
        searchHistoryFlag,
        ...(model ? { model } : {}),
        ...(resumeTurnId !== undefined ? { resumeTurnId } : {}),
        ...(resumeMessageId !== undefined ? { resumeMessageId } : {}),
        clientActionSessionId: opts.body.clientActionSessionId,
        liveShadow: opts.body.liveShadow,
        // D420 — authority carries through the conductor wake so a drain that
        // begins after this boundary check cannot reject the accepted turn.
        acceptanceAuthority,
        invocationAuthority,
      });
    }

    const canonicalAgentId =
      envelopeAgentId && agentMembers.some((m) => m.agentId === envelopeAgentId)
        ? envelopeAgentId
        : (agentMembers[0]?.agentId ?? "");
    if (!canonicalAgentId) {
      return reply.code(500).send({
        error: "internal_error",
        detail: "agent-mediated room had no resolvable agent member id",
      });
    }
    const canonicalLaneKey = `room:${detail.id}`;
    const canonicalRoomRoster = await chatDeps.loadRoomRoster(detail.id);
    const buildEnvelopeForRoom =
      chatDeps.buildEnvelopeForRoom ?? defaultChatRoutesDeps.buildEnvelopeForRoom;
    if (!buildEnvelopeForRoom) {
      return reply.code(500).send({
        error: "internal_error",
        detail: "canonical room envelope builder unavailable",
      });
    }
    let canonicalMemoryAccessEnvelope;
    try {
      canonicalMemoryAccessEnvelope = await buildEnvelopeForRoom(
        sessionActorId,
        canonicalLaneKey,
        canonicalAgentId,
        detail.id,
      );
    } catch (err) {
      return reply.code(500).send({
        error: "internal_error",
        detail:
          err instanceof Error
            ? err.message
            : "failed to build canonical room envelope",
      });
    }

    let liveShadowResult:
      | NonNullable<import("@nautilo/types").RoomMessageSendResponse["liveShadow"]>
      | undefined;
    let liveShadowCapability:
      import("@nautilo/lattice-bridge/server").LiveShadowExecutionCapability
      | undefined;
    let liveShadowRunAgentTurn:
      ProductionLiveShadowMessageComposition["runAgentTurn"] | undefined;
    let liveShadowPersistedMessageId: number | undefined;
    let liveShadowExistingJobId: string | null = null;
    let liveShadowSharedHuman:
      | Readonly<{
          operationId: string;
          planBytes: Uint8Array;
          requestBytes: Uint8Array;
          ordinaryPayloadBytes?: Uint8Array;
          protectedMessage: import("@nautilo/types").ProtectedMessageDtoV2;
          protectedMessageDigest: Uint8Array;
          senderDeviceSigningPublicKey: Uint8Array;
          messageId: number;
          representationMode: "shadow_encryption" | "full_encryption";
          mentionEveryone?: boolean;
        }>
      | undefined;
    let liveShadowSharedExecutionId: string | undefined;
    let liveShadowBoundaryFailure:
      | ReturnType<typeof classifyLiveShadowBoundaryFailure>
      | undefined;
    const rawLiveShadow = opts.body.liveShadow;
    if (rawLiveShadow !== undefined) {
      const parsed = liveShadowMessageSendAttemptV1Schema.safeParse(
        rawLiveShadow,
      );
      if (parsed.success) {
        if (parsed.data.status === "plan_unavailable") {
          log(`[live-shadow] planning unavailable reason=${parsed.data.reason}`);
          liveShadowBoundaryFailure = classifyLiveShadowBoundaryFailure(
            parsed.data.reason,
          );
        } else if (parsed.data.status === "client_unavailable") {
          log(`[live-shadow] client preparation unavailable reason=${parsed.data.reason}`);
          // Preserve the client's typed authority state for the Strict gate.
          // The legacy v1 response still reports its established fallback
          // reason, but collapsing namespace/domain catch-up into
          // protected_open_failed would incorrectly turn a resumable yellow
          // wait into a terminal red failure.
          liveShadowBoundaryFailure = classifyLiveShadowBoundaryFailure(
            parsed.data.reason,
          );
          const planBytes = decodeCanonicalBase64url(
            parsed.data.planBytesBase64url,
          );
          const composition = getProductionLiveShadowMessageComposition(app);
          if (planBytes !== null && composition !== null) {
            try {
              await composition.recordFallback({
                authority: {
                  userId: sessionUserId,
                  humanActorId: sessionActorId,
                },
                operationId: parsed.data.operationId,
                planBytes,
                stage: "human_admission",
                reason: parsed.data.reason === "plan_stale"
                  ? "stale_authority"
                  : parsed.data.reason === "content_invalid"
                    ? "parity_mismatch"
                    : "protected_unavailable",
                now: Date.now(),
              }).catch(() => false);
            } finally {
              planBytes.fill(0);
            }
          }
          liveShadowResult = {
            responseVersion: 1,
            status: "ordinary_fallback",
            operationId: parsed.data.operationId,
            reason: "protected_open_failed",
          };
        } else {
          const decoded = decodePreparedLiveShadowAttempt(parsed.data);
          const composition = getProductionLiveShadowMessageComposition(app);
          const clientActionSessionId = typeof opts.body.clientActionSessionId === "string"
            ? opts.body.clientActionSessionId
            : null;
          if (decoded === null || composition === null || clientActionSessionId === null) {
            liveShadowResult = {
              responseVersion: 1,
              status: "ordinary_fallback",
              operationId: parsed.data.operationId,
              reason: "request_invalid",
            };
          } else if (decoded.authorizationScheme === "human_peer_v1") {
            liveShadowResult = {
              responseVersion: 1,
              status: "ordinary_fallback",
              operationId: parsed.data.operationId,
              reason: "request_invalid",
            };
          } else if (
            decoded.authorizationScheme === "shared_agent_v1"
            || decoded.authorizationScheme === "human_ai_readable_v1"
            || decoded.authorizationScheme === "human_ai_readable_v2"
          ) {
            try {
              const signedPlan = decoded.authorizationScheme === "human_ai_readable_v1"
                || decoded.authorizationScheme === "human_ai_readable_v2"
                ? decodeHumanAiReadableLiveShadowMessagePlan(decoded.planBytes)
                : decodeSharedAgentLiveShadowMessagePlanV1(decoded.planBytes);
              const planMatchesRequest = signedPlan.operationId === parsed.data.operationId
                && signedPlan.roomId === detail.id;
              signedPlan.namespaceHeadDigest.fill(0);
              signedPlan.namespacePublicationDigest.fill(0);
              signedPlan.namespacePublicationSetDigest.fill(0);
              signedPlan.namespaceAudienceFingerprint.fill(0);
              if (!planMatchesRequest) {
                throw new Error("Protected plan coordinate mismatch");
              }
              const admitted = await composition.admitSharedAgent?.({
                operationId: parsed.data.operationId,
                userId: sessionUserId,
                actorId: sessionActorId,
                ...(decoded.representationMode === "full_encryption"
                  ? { representationMode: "full_encryption" as const }
                  : {
                      expectedContent: normalizeHumanMessageText(contentRaw!),
                      ordinaryPayloadBytes: decoded.ordinaryPayloadBytes,
                    }),
                planBytes: decoded.planBytes,
                requestBytes: decoded.requestBytes,
                encryptedPayloadBytes: decoded.encryptedPayloadBytes,
                manifestBytes: decoded.manifestBytes,
                envelopeBytes: decoded.envelopeBytes,
                now: Date.now(),
              });
              if (admitted === undefined) {
                liveShadowResult = {
                  responseVersion: 1,
                  status: "ordinary_fallback",
                  operationId: parsed.data.operationId,
                  reason: "request_invalid",
                };
              } else if (admitted.status === "ordinary_fallback") {
                if (admitted.messageId !== null) {
                  liveShadowPersistedMessageId = admitted.messageId;
                }
                liveShadowResult = {
                  responseVersion: 1,
                  status: "ordinary_fallback",
                  operationId: admitted.operationId,
                  reason: admitted.reason,
                };
              } else {
                if (
                  admitted.protectedMessage.projection.sessionId
                    !== signedPlan.sessionId
                  || admitted.protectedMessage.projection.roomId !== detail.id
                ) {
                  throw new Error("Protected message coordinate mismatch");
                }
                liveShadowPersistedMessageId = admitted.messageId;
                liveShadowSharedHuman = Object.freeze({
                  operationId: admitted.operationId,
                  planBytes: decoded.planBytes.slice(),
                  requestBytes: decoded.requestBytes.slice(),
                  ...(decoded.representationMode === "shadow_encryption"
                    ? {
                        ordinaryPayloadBytes:
                          decoded.ordinaryPayloadBytes.slice(),
                      }
                    : {}),
                  protectedMessage: admitted.protectedMessage,
                  protectedMessageDigest:
                    admitted.protectedMessageDigest.slice(),
                  senderDeviceSigningPublicKey:
                    admitted.senderDeviceSigningPublicKey.slice(),
                  messageId: admitted.messageId,
                  representationMode: decoded.representationMode,
                  ...("mentionEveryone" in admitted
                    && admitted.mentionEveryone === true
                    ? { mentionEveryone: true }
                    : {}),
                });
                mentionEveryone = "mentionEveryone" in admitted
                  && admitted.mentionEveryone === true;
                if (decoded.representationMode === "full_encryption") {
                  // The foreground candidate replaces this content-free
                  // transient placeholder with the authenticated device-opened
                  // payload before the executor starts. Full Job durability
                  // persists only its protected operation reference.
                  content = "";
                }
                liveShadowResult = {
                  responseVersion: 1,
                  status: "human_verified",
                  operationId: admitted.operationId,
                  protectedMessage: admitted.protectedMessage,
                };
                admitted.protectedMessageDigest.fill(0);
                admitted.senderDeviceSigningPublicKey.fill(0);
              }
            } catch {
              if (decoded.representationMode === "full_encryption") {
                liveShadowBoundaryFailure = {
                  state: "failed",
                  reason: "integrity_failure",
                  retryable: true,
                };
              } else {
                liveShadowResult = {
                  responseVersion: 1,
                  status: "ordinary_fallback",
                  operationId: parsed.data.operationId,
                  reason: "protected_open_failed",
                };
              }
            } finally {
              decoded.planBytes.fill(0);
              decoded.requestBytes.fill(0);
              decoded.ordinaryPayloadBytes?.fill(0);
              decoded.encryptedPayloadBytes.fill(0);
              decoded.manifestBytes.fill(0);
              decoded.envelopeBytes.fill(0);
              decoded.grantBytes?.fill(0);
            }
          } else {
            try {
              if (decoded.representationMode === "full_encryption") {
                const signedPlan = decodeLiveShadowMessagePlanV4(decoded.planBytes);
                try {
                  if (signedPlan.roomId !== detail.id) {
                    throw new TypeError("Full encryption plan Room is stale");
                  }
                } finally {
                  signedPlan.namespaceHeadDigest.fill(0);
                  signedPlan.namespacePublicationDigest.fill(0);
                  signedPlan.namespacePublicationSetDigest.fill(0);
                  signedPlan.namespaceAudienceFingerprint.fill(0);
                }
              }
              const preparedAttemptBase = {
                operationId: parsed.data.operationId,
                clientActionSessionId,
                userId: sessionUserId,
                actorId: sessionActorId,
                ...(decoded.representationMode === "full_encryption"
                  ? { representationMode: "full_encryption" as const }
                  : { expectedContent: normalizeHumanMessageText(contentRaw!),
                      ordinaryPayloadBytes: decoded.ordinaryPayloadBytes }),
                planBytes: decoded.planBytes,
                requestBytes: decoded.requestBytes,
                encryptedPayloadBytes: decoded.encryptedPayloadBytes,
                manifestBytes: decoded.manifestBytes,
                envelopeBytes: decoded.envelopeBytes,
                now: Date.now(),
              };
              const admitted = await composition.admitPrepared({
                ...preparedAttemptBase,
                grantBytes: decoded.grantBytes,
                authorizationScheme: decoded.authorizationScheme,
              });
              if (
                admitted.status === "human_verified"
                || admitted.status === "human_replayed"
              ) {
                mentionEveryone = "mentionEveryone" in admitted
                  && admitted.mentionEveryone === true;
                if (decoded.representationMode === "full_encryption") {
                  const signedPlan = decodeLiveShadowMessagePlanV4(decoded.planBytes);
                  try {
                    if (admitted.protectedMessage.projection.roomId !== detail.id
                      || admitted.protectedMessage.projection.sessionId !== signedPlan.sessionId) {
                      throw new TypeError("Full encryption publication projection is stale");
                    }
                  } finally {
                    signedPlan.namespaceHeadDigest.fill(0);
                    signedPlan.namespacePublicationDigest.fill(0);
                    signedPlan.namespacePublicationSetDigest.fill(0);
                    signedPlan.namespaceAudienceFingerprint.fill(0);
                  }
                }
                // Re-derive Agent-facing command expansion from the opened
                // protected content. The earlier ordinary expansion remains
                // useful for routing, but it is never the protected Agent's
                // input authority.
                if (decoded.representationMode === "full_encryption") {
                  content = admitted.content;
                } else {
                  const skillExpanded = await resolveSkillSlashCommandContent(
                    admitted.content, canonicalAgentId, sessionUserId,
                  );
                  const commandExpanded = await resolveCommandSlashCommandContent(
                    skillExpanded.content, canonicalAgentId, sessionUserId,
                  );
                  content = commandExpanded.content;
                }
                if (admitted.status === "human_verified") {
                  liveShadowCapability = admitted.capability;
                  liveShadowRunAgentTurn = (input) =>
                    composition.runAgentTurn(input);
                } else {
                  liveShadowExistingJobId = admitted.jobId;
                }
                liveShadowPersistedMessageId = admitted.messageId;
                liveShadowResult = {
                  responseVersion: 1,
                  status: "human_verified",
                  operationId: admitted.operationId,
                  protectedMessage: admitted.protectedMessage,
                };
              } else {
                if (admitted.messageId !== null) {
                  liveShadowPersistedMessageId = admitted.messageId;
                }
                liveShadowResult = {
                  responseVersion: 1,
                  status: "ordinary_fallback",
                  operationId: admitted.operationId,
                  reason: admitted.reason,
                };
              }
            } catch {
              // Shadow admission is subordinate to the existing ordinary
              // product path. Unexpected crypto/authority infrastructure
              // failure must not turn the one Human send into an HTTP 500 or
              // schedule a second Agent run.
              liveShadowResult = {
                responseVersion: 1,
                status: "ordinary_fallback",
                operationId: parsed.data.operationId,
                reason: "protected_open_failed",
              };
            } finally {
              decoded.planBytes.fill(0);
              decoded.requestBytes.fill(0);
              decoded.ordinaryPayloadBytes?.fill(0);
              decoded.encryptedPayloadBytes.fill(0);
              decoded.manifestBytes.fill(0);
              decoded.envelopeBytes.fill(0);
              decoded.grantBytes?.fill(0);
            }
          }
        }
      }
    }

    if (liveShadowSharedHuman !== undefined) {
      const sharedHuman = liveShadowSharedHuman;
      const plan = (() => {
        try {
          return decodeHumanAiReadableLiveShadowMessagePlan(
            sharedHuman.planBytes,
          );
        } catch {
          return decodeSharedAgentLiveShadowMessagePlanV1(
            sharedHuman.planBytes,
          );
        }
      })();
      const crypto = new LatticeCrypto();
      const eventDigest = sharedHuman.representationMode === "full_encryption"
        ? fullEncryptionDurableEventDigestV2(crypto, {
            operationId: sharedHuman.operationId,
            policyRevision: plan.policyRevision,
            transcriptOrdinal: plan.transcriptOrdinal,
            protectedMessage: sharedHuman.protectedMessage,
          })
        : liveShadowDurableEventDigestV1(crypto, {
            operationId: sharedHuman.operationId,
            policyRevision: plan.policyRevision,
            transcriptOrdinal: plan.transcriptOrdinal,
            ordinaryPayloadBytes: sharedHuman.ordinaryPayloadBytes!,
            protectedMessage: sharedHuman.protectedMessage,
          });
      try {
        const composition = getProductionLiveShadowMessageComposition(app);
        const published = await composition?.recordSharedAgentPublished?.({
          operationId: sharedHuman.operationId,
          messageId: sharedHuman.messageId,
          protectedMessageDigest: sharedHuman.protectedMessageDigest,
          finalEventDigest: eventDigest,
          now: Date.now(),
        });
        if (published === "published" || published === "replayed") {
          const commonEvent = {
            type: "message.shared_agent_shadow",
            laneKey: `room:${detail.id}`,
            operationId: sharedHuman.operationId,
            policyRevision: plan.policyRevision,
            transcriptOrdinal: plan.transcriptOrdinal,
            logicalMessageKey: `turn:${sharedHuman.operationId}`,
            planBytesBase64url:
              Buffer.from(sharedHuman.planBytes).toString("base64url"),
            requestBytesBase64url:
              Buffer.from(sharedHuman.requestBytes).toString("base64url"),
            protectedMessage: sharedHuman.protectedMessage,
            protectedMessageDigestBase64url:
              Buffer.from(sharedHuman.protectedMessageDigest)
                .toString("base64url"),
            senderDeviceSigningPublicKeyBase64url: Buffer.from(
              sharedHuman.senderDeviceSigningPublicKey,
            ).toString("base64url"),
            durableEventDigestBase64url:
              Buffer.from(eventDigest).toString("base64url"),
          } as const;
          eventBus.emit(sharedHuman.representationMode === "full_encryption"
            ? { ...commonEvent, wireVersion: 2 as const }
            : {
                ...commonEvent,
                wireVersion: 1 as const,
                ordinaryPayloadBytesBase64url: Buffer.from(
                  sharedHuman.ordinaryPayloadBytes!,
                ).toString("base64url"),
              });
        }

        const clientActionSessionId = typeof opts.body.clientActionSessionId
            === "string"
          ? opts.body.clientActionSessionId
          : undefined;
        if (
          composition !== null
          && clientActionSessionId !== undefined
        ) {
          const reservation = await composition
            .reserveSharedAgentRuntimeInvocation?.({
              operationIds: [sharedHuman.operationId],
              roomId: detail.id,
              subjectHumanId: sessionActorId,
              clientActionSessionId,
              now: Date.now(),
            });
          if (reservation !== undefined && reservation !== null) {
            const invocationCapability =
              await authorizeRuntimeInvocationForForeground({
                composition,
                invocation: reservation,
                operationIds: [sharedHuman.operationId],
                userId: sessionUserId,
                humanActorId: sessionActorId,
              });
            const attachment = invocationCapability === null
              ? null
              : await composition
                .attachSharedAgentRuntimeInvocationExecutions?.({
                  invocationId: reservation.invocationId,
                  operationIds: [sharedHuman.operationId],
                  roomId: detail.id,
                  subjectUserId: sessionUserId,
                  subjectHumanId: sessionActorId,
                  agents: [Object.freeze({
                    agentId: canonicalAgentId,
                    agentThreadId: detail.graphThreadId,
                  })],
                  now: Date.now(),
                });
            const execution = attachment?.executions[0];
            if (execution !== undefined) {
              let planned: Awaited<ReturnType<NonNullable<
                typeof composition.planSharedAgentExecutionAuthorization
              >>> | undefined;
              try {
                planned = await composition
                  .planSharedAgentExecutionAuthorization?.({
                    authority: {
                      userId: sessionUserId,
                      humanActorId: sessionActorId,
                    },
                    executionId: execution.executionId,
                    roomId: reservation.roomId,
                    agentId: execution.agentId,
                    clientActionSessionId: reservation.clientActionSessionId,
                    clientDeviceId: reservation.invokingDeviceId,
                    now: Date.now(),
                  });
              } finally {
                invocationCapability?.authorizationDigest.fill(0);
                invocationCapability?.scope.domainAuthoritySetDigest.fill(0);
              }
              let authorized:
                | Readonly<{
                    capability: import("@nautilo/lattice-bridge/server")
                      .ForegroundLiveShadowSessionExecutionCapability;
                    planBytes: Uint8Array;
                  }>
                | null
                | undefined;
              if (planned?.status === "authorized") {
                authorized = Object.freeze({
                  capability: Object.freeze({
                    kind: "foreground_session" as const,
                    sessionReference: planned.sessionReference,
                    authorizationDigest: planned.authorizationDigest,
                    scope: planned.scope,
                  }),
                  planBytes: planned.planBytes,
                });
              }
              if (authorized !== null && authorized !== undefined) {
                authorized.planBytes.fill(0);
                liveShadowSharedExecutionId = execution.executionId;
                liveShadowCapability = authorized.capability;
                liveShadowRunAgentTurn = <Value>(input: Readonly<{
                  operationId: string;
                  capability: import("@nautilo/lattice-bridge/server")
                    .LiveShadowExecutionCapability;
                  entrypointId?: "foreground.main" | "foreground.fork";
                  work(
                    session: import("@nautilo/lattice-bridge/server")
                      .LiveShadowAgentTurnSession,
                    openedHumanContent?: string,
                    authorizationSignal?: AbortSignal,
                  ): Promise<Value>;
                  }>) => composition.runAgentTurn({
                    ...input,
                    ...(sharedHuman.representationMode === "full_encryption"
                      ? { representationMode: "full_encryption" as const }
                      : {
                          expectedMergedHumanContent:
                            normalizeHumanMessageText(contentRaw!),
                        }),
                  });
              } else {
                const reason = planned !== undefined && "reason" in planned
                  ? planned.reason
                  : "agent_authorization_unavailable";
                log(
                  `[m298] Direct Runtime authorization unavailable room=${detail.id} agent=${execution.agentId} reason=${reason}`,
                );
                await composition.recordSharedAgentExecutionUnavailable?.({
                  executionId: execution.executionId,
                  reason,
                  now: Date.now(),
                }).catch(() => undefined);
              }
            } else {
              invocationCapability?.authorizationDigest.fill(0);
              invocationCapability?.scope.domainAuthoritySetDigest.fill(0);
            }
          }
        }
      } finally {
        eventDigest.fill(0);
        plan.namespaceHeadDigest.fill(0);
        plan.namespacePublicationDigest.fill(0);
        plan.namespacePublicationSetDigest.fill(0);
        plan.namespaceAudienceFingerprint.fill(0);
        sharedHuman.planBytes.fill(0);
        sharedHuman.requestBytes.fill(0);
        sharedHuman.ordinaryPayloadBytes?.fill(0);
        sharedHuman.protectedMessageDigest.fill(0);
        sharedHuman.senderDeviceSigningPublicKey.fill(0);
      }
    }

    if (
      liveShadowSharedHuman?.representationMode === "full_encryption"
      && (liveShadowCapability === undefined || liveShadowRunAgentTurn === undefined)
      && liveShadowResult !== undefined
    ) {
      // The protected Human publication is durable, but no Agent Job may be
      // created until an execution grant exists: doing so would persist or
      // execute the content-free transport placeholder.
      return reply.code(202).send({
        messageId: liveShadowPersistedMessageId ?? null,
        jobId: null,
        accepted: true,
        attachments: [],
        coalesced: false,
        liveShadow: liveShadowResult,
        agent: { status: "waiting_authorization" },
      });
    }

    const directStrictDecision = await strictShadowBoundaryEnforcer(chatDeps)({
      boundaryId: "conversation.write.foreground",
      ...(liveShadowResult?.status === "human_verified"
        ? { state: "verified" as const, reason: "none" as const, retryable: false }
        : liveShadowBoundaryFailure !== undefined
        ? liveShadowBoundaryFailure
        : liveShadowResult?.status === "ordinary_fallback"
        ? classifyLiveShadowBoundaryFailure(liveShadowResult.reason)
        : {
          state: "unsupported" as const,
          reason: "unsupported_operation" as const,
          retryable: false,
        }),
    });
    if (
      directStrictDecision.result.disposition === "withhold"
      || directStrictDecision.result.disposition === "reject"
    ) {
      return reply.code(strictShadowHttpStatus(directStrictDecision.result))
        .send(strictShadowHttpBody(directStrictDecision.result));
    }

    if (liveShadowExistingJobId !== null && liveShadowResult !== undefined) {
      return reply.code(202).send({
        messageId: null,
        jobId: liveShadowExistingJobId,
        accepted: true,
        attachments: [],
        coalesced: false,
        liveShadow: liveShadowResult,
      });
    }

    let result;
    try {
      // Strict 1-human/1-agent Rooms always wake their only Genie. They do not
      // need response-mode or mention arbitration; group Rooms retain their
      // existing Conductor routing, while this reuses the direct executor path.
      const reservedLiveShadowJobId = liveShadowCapability
          && liveShadowSharedExecutionId === undefined
        ? randomUUID()
        : undefined;
      const runAgentMessage = async () => {
        if (reservedLiveShadowJobId !== undefined && liveShadowResult !== undefined) {
          const composition = getProductionLiveShadowMessageComposition(app);
          const bound = await composition?.bindJob({
            authority: {
              userId: sessionUserId,
              humanActorId: sessionActorId,
            },
            operationId: liveShadowResult.operationId,
            jobId: reservedLiveShadowJobId,
            now: Date.now(),
          });
          if (bound !== true) {
            throw new Error("Live Shadow Job reservation conflicted");
          }
        }
        return executeAgentMediatedRoomMessage({
        request,
        deps: chatDeps,
        content: content!,
        voiceMode,
        autoApprove,
        currentFolder,
        currentFolderRelayId,
        workspacePath,
        activeMiniApp,
        liveMiniAppSession,
        attachmentRefs,
        artifactRefs,
        focusedResources,
        mentionedHumanUserIds,
        mentionEveryone,
        ...(opts.ordinaryOrigin ? { ordinaryOrigin: opts.ordinaryOrigin } : {}),
        ...(model ? { model } : {}),
        ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
        ...(opts.body.laneKey !== undefined ? { clientLaneKey: opts.body.laneKey } : {}),
        clientActionSessionId: opts.body.clientActionSessionId,
        canonicalRoomId: detail.id,
        canonicalAgentId,
        canonicalGraphThreadId: detail.graphThreadId,
        canonicalRoomRoster,
        canonicalLaneKey,
        ...(canonicalMemoryAccessEnvelope ? { canonicalMemoryAccessEnvelope } : {}),
        transcriptOwnerId: sessionUserId,
        ...(liveShadowResult
          ? { sharedTurnId: liveShadowResult.operationId }
          : {}),
        ...(liveShadowPersistedMessageId !== undefined
          ? {
              humanAlreadyPersisted: true,
              currentMessageId: liveShadowPersistedMessageId,
            }
          : {}),
        ...(liveShadowCapability
          ? {
              liveShadowOperationId:
                liveShadowSharedExecutionId ?? liveShadowResult!.operationId,
              liveShadowCapability,
              liveShadowEnforcementPolicy: {
                mode: directStrictDecision.policy.mode,
                shadowBehavior: directStrictDecision.policy.shadowBehavior,
                revision: directStrictDecision.policy.revision,
              },
              liveShadowDataOperationPolicy: createLiveShadowDataOperationPolicyBinding(
                strictShadowPolicyReader(chatDeps),
              ),
              liveShadowObserveBoundary: async (decision) => {
                const observed = await strictShadowBoundaryEnforcer(chatDeps)({
                  ...decision,
                  boundaryId: decision.boundaryId
                    ?? "conversation.write.runtime_persist",
                  retryable: decision.retryable ?? false,
                });
                rejectChangedStrictShadowPolicy(
                  directStrictDecision.policy,
                  observed,
                );
              },
              ...(reservedLiveShadowJobId === undefined
                ? {}
                : { preferredVirtualJobId: reservedLiveShadowJobId }),
              ...(liveShadowRunAgentTurn === undefined
                ? {}
                : { liveShadowRunAgentTurn }),
            }
          : {}),
        // M168 — DM-subthread: anchor the transcript rebuild to the parent
        // window. No `currentMessageId` (the DM path persists its human row
        // AFTER history is built, so there is nothing to exclude).
        ...(detail.kind === "subthread" && detail.parentRoomId
          ? { subthreadParentRoomId: detail.parentRoomId }
          : {}),
        ...(detail.kind === "subthread" && detail.threadRootMessageId != null
          ? { subthreadAnchorMessageId: detail.threadRootMessageId }
          : {}),
        // D426 — the direct 1:1 route uses the same child-row / root-summary
        // persistence contract as conductor wakes.
        ...(detail.kind === "subthread" ? { subthreadRoomId: detail.id } : {}),
        // M135 P6 — DM bots get a server-time prefix on the human turn.
        serverTimePrefixIso: `${new Date().toISOString().slice(0, 19)}Z`,
        invocationAuthority,
        ...(advancedVideoWorkcardContinuation
          ? { metadata: { originatedBy: "advanced_video_workcard", ...advancedVideoWorkcardContinuation } }
          : {}),
        });
      };
      const composition = getProductionLiveShadowMessageComposition(app);
      result = liveShadowResult !== undefined && composition !== null
        ? await composition.runDispatchOnce({
            operationId: liveShadowResult.operationId,
            now: Date.now(),
            work: runAgentMessage,
          })
        : await runAgentMessage();
    } catch (err) {
      if (err instanceof AgentMediatedSendError) {
        return reply
          .code(err.httpStatus)
          .send({ error: err.code, code: err.code, message: err.message });
      }
      // D420 — the createForegroundJob seam gate rejected (drain began in the
      // window between the boundary check and acceptance). Render the typed
      // retryable 503; no human row was persisted.
      if (isMaintenanceDrainError(err)) {
        return replyMaintenanceRejection(reply, err);
      }
      throw err;
    }
    // The reply hook is downstream of successful send admission. The Task
    // seam performs its own dual-subject capability checks before resuming.
    if (!fullPrepared) {
      void maybeResumeAwaitingTask(detail.id, sessionUserId, content!);
    }
    const canonical = {
      messageId: result.messageId,
      jobId: result.jobId,
      accepted: true as const,
      attachments: result.attachments,
      coalesced: result.coalesced,
      ...(liveShadowResult ? { liveShadow: liveShadowResult } : {}),
    };
    if (alias) {
      return reply
        .code(202)
        .send(legacyAliasSuccessBody(detail.id, canonical.attachments, canonical.coalesced, canonical.jobId));
    }
    return reply.code(202).send(canonical);
  }

  return dispatchHumanOnlyRoomMessage(request, reply, {
    detail,
    chatDeps,
    alias,
    sessionUserId,
    ...(content === undefined ? {} : { content }),
    attachmentRefs,
    mentionedHumanUserIds,
    mentionEveryone,
    workspaceArtifactExternalIds,
    liveShadow: opts.body.liveShadow,
    ...(canonicalRoomNamespaceId ? { canonicalRoomNamespaceId } : {}),
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
  });
}

/** Shared zero-Agent / incapable-mixed-Room transcript and realtime path. */
async function dispatchHumanOnlyRoomMessage(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: {
    detail: RoomDetailPayload;
    chatDeps: ChatRoutesDeps;
    alias: boolean;
    sessionUserId: string;
    content?: string;
    attachmentRefs: string[];
    mentionedHumanUserIds: string[];
    mentionEveryone: boolean;
    workspaceArtifactExternalIds: string[];
    canonicalRoomNamespaceId?: string;
    replyToMessageId?: number;
    liveShadow?: unknown;
  },
): Promise<void> {
  const turnId = randomUUID();
  const out = await runWithTurn(turnId, async () => {
    const normalizedAttachments =
      opts.attachmentRefs.length > 0
        ? await normalizeChatAttachments(
            uploadedAttachmentArgs(
              opts.attachmentRefs,
              request.sessionActorId,
              request.memoryEnvelope,
            ),
          )
        : { textBlocks: [] as string[], mediaParts: [], statuses: [] as ChatAttachmentStatus[] };

    let humanPeer:
      | Readonly<{
          operationId: string;
          planBytes: Uint8Array;
          requestBytes: Uint8Array;
          ordinaryPayloadBytes?: Uint8Array;
          protectedMessage: import("@nautilo/types").ProtectedMessageDtoV2;
          protectedMessageDigest: Uint8Array;
          senderDeviceSigningPublicKey: Uint8Array;
          messageId: number;
          content?: string;
          representationMode: "shadow_encryption" | "full_encryption";
          mentionEveryone?: boolean;
        }>
      | undefined;
    let humanPeerFallback:
      | Readonly<{
          operationId: string;
          reason:
            | "request_invalid"
            | "authority_stale"
            | "human_parity_failed"
            | "human_persistence_failed"
            | "deadline_expired"
            | "integrity_conflict";
          messageId: number | null;
        }>
      | undefined;
    let sharedAgent: typeof humanPeer;
    let sharedAgentFallback: typeof humanPeerFallback;
    let effectiveMentionEveryone = opts.mentionEveryone;
    const parsed = liveShadowMessageSendAttemptV1Schema.safeParse(
      opts.liveShadow,
    );
    if (
      parsed.success
      && parsed.data.status === "prepared"
      && "authorizationScheme" in parsed.data
      && parsed.data.authorizationScheme === "human_peer_v1"
      && request.sessionActorId !== null
    ) {
      const decoded = decodePreparedLiveShadowAttempt(parsed.data);
      const composition = getProductionLiveShadowMessageComposition(
        request.server,
      );
      if (decoded !== null && composition !== null) {
        try {
          const admitted = await composition.admitHumanPeer({
            operationId: parsed.data.operationId,
            userId: opts.sessionUserId,
            actorId: request.sessionActorId,
            ...(decoded.representationMode === "full_encryption"
              ? { representationMode: "full_encryption" as const }
              : { expectedContent: normalizeHumanMessageText(opts.content!),
                  ordinaryPayloadBytes: decoded.ordinaryPayloadBytes }),
            planBytes: decoded.planBytes,
            requestBytes: decoded.requestBytes,
            encryptedPayloadBytes: decoded.encryptedPayloadBytes,
            manifestBytes: decoded.manifestBytes,
            envelopeBytes: decoded.envelopeBytes,
            now: Date.now(),
          });
          if (
            admitted.status === "human_verified"
            || admitted.status === "human_replayed"
          ) {
            humanPeer = Object.freeze({
              operationId: admitted.operationId,
              planBytes: decoded.planBytes.slice(),
              requestBytes: decoded.requestBytes.slice(),
              ...(decoded.representationMode === "shadow_encryption"
                ? { ordinaryPayloadBytes: decoded.ordinaryPayloadBytes.slice() }
                : {}),
              protectedMessage: admitted.protectedMessage,
              protectedMessageDigest: admitted.protectedMessageDigest.slice(),
              senderDeviceSigningPublicKey:
                admitted.senderDeviceSigningPublicKey.slice(),
              messageId: admitted.messageId,
              ...(admitted.representationMode === "full_encryption"
                ? {} : { content: admitted.content }),
              representationMode: decoded.representationMode,
              ...("mentionEveryone" in admitted
                && admitted.mentionEveryone === true
                ? { mentionEveryone: true }
                : {}),
            });
            effectiveMentionEveryone = "mentionEveryone" in admitted
              && admitted.mentionEveryone === true;
          } else if (admitted.status === "ordinary_fallback") {
            humanPeerFallback = Object.freeze({
              operationId: admitted.operationId,
              reason: admitted.reason,
              messageId: admitted.messageId,
            });
          }
          if (admitted.status !== "ordinary_fallback") {
            admitted.protectedMessageDigest.fill(0);
            admitted.senderDeviceSigningPublicKey.fill(0);
          }
        } finally {
          decoded.planBytes.fill(0);
          decoded.requestBytes.fill(0);
          decoded.ordinaryPayloadBytes?.fill(0);
          decoded.encryptedPayloadBytes.fill(0);
          decoded.manifestBytes.fill(0);
          decoded.envelopeBytes.fill(0);
          decoded.grantBytes.fill(0);
        }
      }
    }
    if (
      parsed.success
      && parsed.data.status === "prepared"
      && "authorizationScheme" in parsed.data
      && (parsed.data.authorizationScheme === "shared_agent_v1"
        || parsed.data.authorizationScheme === "human_ai_readable_v1"
        || parsed.data.authorizationScheme === "human_ai_readable_v2")
      && request.sessionActorId !== null
    ) {
      const decoded = decodePreparedLiveShadowAttempt(parsed.data);
      const composition = getProductionLiveShadowMessageComposition(
        request.server,
      );
      if (decoded !== null && decoded.representationMode === "shadow_encryption" && composition?.admitSharedAgent !== undefined) {
        try {
          const admitted = await composition.admitSharedAgent({
            operationId: parsed.data.operationId,
            userId: opts.sessionUserId,
            actorId: request.sessionActorId,
            expectedContent: normalizeHumanMessageText(opts.content!),
            planBytes: decoded.planBytes,
            requestBytes: decoded.requestBytes,
            ordinaryPayloadBytes: decoded.ordinaryPayloadBytes,
            encryptedPayloadBytes: decoded.encryptedPayloadBytes,
            manifestBytes: decoded.manifestBytes,
            envelopeBytes: decoded.envelopeBytes,
            now: Date.now(),
          });
          if (admitted.status === "ordinary_fallback") {
            sharedAgentFallback = Object.freeze({
              operationId: admitted.operationId,
              reason: admitted.reason,
              messageId: admitted.messageId,
            });
          } else {
            if (!("content" in admitted)) throw new Error("Protected-only receipt cannot become an ordinary shared message");
            sharedAgent = Object.freeze({
              operationId: admitted.operationId,
              planBytes: decoded.planBytes.slice(),
              requestBytes: decoded.requestBytes.slice(),
              ordinaryPayloadBytes: decoded.ordinaryPayloadBytes.slice(),
              protectedMessage: admitted.protectedMessage,
              protectedMessageDigest: admitted.protectedMessageDigest.slice(),
              senderDeviceSigningPublicKey:
                admitted.senderDeviceSigningPublicKey.slice(),
              messageId: admitted.messageId,
              content: admitted.content,
              representationMode: "shadow_encryption",
              ...("mentionEveryone" in admitted
                && admitted.mentionEveryone === true
                ? { mentionEveryone: true }
                : {}),
            });
            effectiveMentionEveryone = "mentionEveryone" in admitted
              && admitted.mentionEveryone === true;
            admitted.protectedMessageDigest.fill(0);
            admitted.senderDeviceSigningPublicKey.fill(0);
          }
        } finally {
          decoded.planBytes.fill(0);
          decoded.requestBytes.fill(0);
          decoded.ordinaryPayloadBytes.fill(0);
          decoded.encryptedPayloadBytes.fill(0);
          decoded.manifestBytes.fill(0);
          decoded.envelopeBytes.fill(0);
          decoded.grantBytes.fill(0);
        }
      }
    }

    const protectedHuman = sharedAgent ?? humanPeer;
    const protectedFallback = sharedAgentFallback ?? humanPeerFallback;
    if (parsed.success && parsed.data.status !== "prepared") {
      log(`[live-shadow] client preparation unavailable reason=${parsed.data.reason}`);
    }

    const peerStrictDecision = await strictShadowBoundaryEnforcer(opts.chatDeps)({
      boundaryId: "conversation.write.human_peer",
      ...(protectedHuman !== undefined
        ? { state: "verified" as const, reason: "none" as const, retryable: false }
        : protectedFallback !== undefined
        ? classifyLiveShadowBoundaryFailure(protectedFallback.reason)
        : parsed.success && parsed.data.status !== "prepared"
        ? classifyLiveShadowBoundaryFailure(parsed.data.reason)
        : {
          state: "unsupported" as const,
          reason: "unsupported_operation" as const,
          retryable: false,
        }),
    });
    if (
      peerStrictDecision.result.disposition === "withhold"
      || peerStrictDecision.result.disposition === "reject"
    ) {
      return Object.freeze({
        strictShadowFailure: peerStrictDecision.result,
      });
    }

    const persisted = protectedHuman?.representationMode === "full_encryption"
      ? await finalizeProtectedHumanPeerMessage({
          room: opts.detail,
          senderUserId: opts.sessionUserId,
          messageId: protectedHuman.messageId,
          operationId: protectedHuman.operationId,
          attachmentStatuses: normalizedAttachments.statuses,
        })
      : await peerBroadcastHumanMessage({
      room: opts.detail,
      senderUserId: opts.sessionUserId,
      content: opts.content!,
      attachmentTextBlocks: normalizedAttachments.textBlocks,
      multimodalImages: normalizedAttachments.mediaParts,
      replyToMessageId: opts.replyToMessageId,
      attachmentStatuses: normalizedAttachments.statuses,
      workspaceArtifactExternalIds: opts.workspaceArtifactExternalIds,
      mentionedHumanUserIds: opts.mentionedHumanUserIds,
      mentionEveryone: effectiveMentionEveryone,
      ...(opts.canonicalRoomNamespaceId
        ? { canonicalRoomNamespaceId: opts.canonicalRoomNamespaceId }
        : {}),
      ...(protectedHuman === undefined && protectedFallback?.messageId == null
        ? {}
        : {
            persistedMessage: {
              ...(protectedHuman ? { createdAt: protectedHuman.protectedMessage.projection.createdAt } : {}),
              messageId: protectedHuman?.messageId
                ?? protectedFallback!.messageId!,
              content: protectedHuman?.content
                ?? normalizeHumanMessageText(opts.content!),
              fingerprint: protectedHuman?.operationId
                ?? protectedFallback!.operationId,
              humanTurnId: protectedHuman?.operationId
                ?? protectedFallback!.operationId,
            },
          }),
        });
    if (humanPeerFallback !== undefined && request.sessionActorId !== null) {
      const terminal = humanPeerFallback.reason === "authority_stale"
        ? { stage: "human_admission" as const, reason: "stale_authority" as const }
        : humanPeerFallback.reason === "human_parity_failed"
          ? { stage: "human_admission" as const, reason: "parity_mismatch" as const }
          : humanPeerFallback.reason === "deadline_expired"
            ? { stage: "human_admission" as const, reason: "deadline_expired" as const }
            : humanPeerFallback.reason === "human_persistence_failed"
              ? { stage: "protected_completion" as const, reason: "storage_failure" as const }
              : humanPeerFallback.reason === "integrity_conflict"
                ? { stage: "product_mapping" as const, reason: "product_conflict" as const }
                : { stage: "human_admission" as const, reason: "integrity_failure" as const };
      try {
        const composition = getProductionLiveShadowMessageComposition(
          request.server,
        );
        const recorded = await composition?.recordHumanPeerFallback({
          actorId: request.sessionActorId,
          operationId: humanPeerFallback.operationId,
          ...terminal,
          now: Date.now(),
        });
        if (recorded === "conflict") {
          log(
            `[m295] Human-peer fallback receipt conflicted operation=${humanPeerFallback.operationId}`,
          );
        }
      } catch (error) {
        log(
          `[m295] Human-peer fallback receipt failed operation=${humanPeerFallback.operationId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (humanPeer !== undefined && request.sessionActorId !== null) {
      const plan = decodeHumanPeerLiveShadowMessagePlanV1(humanPeer.planBytes);
      const crypto = new LatticeCrypto();
      const eventDigest = humanPeer.representationMode === "full_encryption"
        ? fullEncryptionDurableEventDigestV2(crypto, {
            operationId: humanPeer.operationId,
            policyRevision: plan.policyRevision,
            transcriptOrdinal: plan.transcriptOrdinal,
            protectedMessage: humanPeer.protectedMessage,
          })
        : liveShadowDurableEventDigestV1(crypto, {
        operationId: humanPeer.operationId,
        policyRevision: plan.policyRevision,
        transcriptOrdinal: plan.transcriptOrdinal,
        ordinaryPayloadBytes: humanPeer.ordinaryPayloadBytes!,
        protectedMessage: humanPeer.protectedMessage,
      });
      try {
        const composition = getProductionLiveShadowMessageComposition(
          request.server,
        );
        const published = await composition?.recordHumanPeerPublished({
          userId: opts.sessionUserId,
          actorId: request.sessionActorId,
          operationId: humanPeer.operationId,
          planBytes: humanPeer.planBytes,
          messageId: humanPeer.messageId,
          protectedMessageDigest: humanPeer.protectedMessageDigest,
          finalEventDigest: eventDigest,
          now: Date.now(),
        });
        if (published === "published" || published === "replayed") {
          const commonEvent = {
            type: "message.human_peer_shadow",
            laneKey: `room:${opts.detail.id}`,
            operationId: humanPeer.operationId,
            policyRevision: plan.policyRevision,
            transcriptOrdinal: plan.transcriptOrdinal,
            logicalMessageKey: `turn:${humanPeer.operationId}`,
            planBytesBase64url:
              Buffer.from(humanPeer.planBytes).toString("base64url"),
            requestBytesBase64url:
              Buffer.from(humanPeer.requestBytes).toString("base64url"),
            protectedMessage: humanPeer.protectedMessage,
            protectedMessageDigestBase64url:
              Buffer.from(humanPeer.protectedMessageDigest).toString("base64url"),
            senderDeviceSigningPublicKeyBase64url: Buffer.from(
              humanPeer.senderDeviceSigningPublicKey,
            ).toString("base64url"),
            durableEventDigestBase64url:
              Buffer.from(eventDigest).toString("base64url"),
          } as const;
          eventBus.emit(humanPeer.representationMode === "full_encryption"
            ? { ...commonEvent, wireVersion: 2 as const }
            : { ...commonEvent, wireVersion: 1 as const,
                ordinaryPayloadBytesBase64url:
                  Buffer.from(humanPeer.ordinaryPayloadBytes!).toString("base64url") });
        }
      } finally {
        eventDigest.fill(0);
        plan.namespaceHeadDigest.fill(0);
        plan.namespacePublicationDigest.fill(0);
        plan.namespacePublicationSetDigest.fill(0);
        plan.namespaceAudienceFingerprint.fill(0);
        humanPeer.planBytes.fill(0);
        humanPeer.requestBytes.fill(0);
        humanPeer.ordinaryPayloadBytes?.fill(0);
        humanPeer.protectedMessageDigest.fill(0);
        humanPeer.senderDeviceSigningPublicKey.fill(0);
      }
    }
    if (sharedAgentFallback !== undefined && request.sessionActorId !== null) {
      const terminal = sharedAgentFallback.reason === "authority_stale"
        ? { stage: "human_admission" as const, reason: "stale_authority" as const }
        : sharedAgentFallback.reason === "human_parity_failed"
          ? { stage: "human_admission" as const, reason: "parity_mismatch" as const }
          : sharedAgentFallback.reason === "deadline_expired"
            ? { stage: "human_admission" as const, reason: "deadline_expired" as const }
            : sharedAgentFallback.reason === "human_persistence_failed"
              ? { stage: "protected_completion" as const, reason: "storage_failure" as const }
              : sharedAgentFallback.reason === "integrity_conflict"
                ? { stage: "product_mapping" as const, reason: "product_conflict" as const }
                : { stage: "human_admission" as const, reason: "integrity_failure" as const };
      await getProductionLiveShadowMessageComposition(request.server)
        ?.recordSharedAgentFallback?.({
          actorId: request.sessionActorId,
          operationId: sharedAgentFallback.operationId,
          ...terminal,
          now: Date.now(),
        }).catch((error) => {
          log(
            `[m296] incapable shared-Room fallback receipt failed operation=${sharedAgentFallback.operationId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    if (sharedAgent !== undefined && request.sessionActorId !== null) {
      const plan = (() => {
        try {
          return decodeHumanAiReadableLiveShadowMessagePlan(
            sharedAgent.planBytes,
          );
        } catch {
          return decodeSharedAgentLiveShadowMessagePlanV1(
            sharedAgent.planBytes,
          );
        }
      })();
      const crypto = new LatticeCrypto();
      const eventDigest = liveShadowDurableEventDigestV1(crypto, {
        operationId: sharedAgent.operationId,
        policyRevision: plan.policyRevision,
        transcriptOrdinal: plan.transcriptOrdinal,
        ordinaryPayloadBytes: sharedAgent.ordinaryPayloadBytes!,
        protectedMessage: sharedAgent.protectedMessage,
      });
      try {
        const published = await getProductionLiveShadowMessageComposition(
          request.server,
        )?.recordSharedAgentPublished?.({
          operationId: sharedAgent.operationId,
          messageId: sharedAgent.messageId,
          protectedMessageDigest: sharedAgent.protectedMessageDigest,
          finalEventDigest: eventDigest,
          now: Date.now(),
        });
        if (published === "published" || published === "replayed") {
          await getProductionLiveShadowMessageComposition(request.server)
            ?.recordSharedAgentConductorResolution?.({
              operationIds: [sharedAgent.operationId],
              roomId: opts.detail.id,
              subjectHumanId: request.sessionActorId,
              state: "not_selected",
              reason: "invocation_not_permitted",
              now: Date.now(),
            });
          eventBus.emit({
            wireVersion: 1,
            type: "message.shared_agent_shadow",
            laneKey: `room:${opts.detail.id}`,
            operationId: sharedAgent.operationId,
            policyRevision: plan.policyRevision,
            transcriptOrdinal: plan.transcriptOrdinal,
            logicalMessageKey: `turn:${sharedAgent.operationId}`,
            planBytesBase64url:
              Buffer.from(sharedAgent.planBytes).toString("base64url"),
            requestBytesBase64url:
              Buffer.from(sharedAgent.requestBytes).toString("base64url"),
            ordinaryPayloadBytesBase64url:
              Buffer.from(sharedAgent.ordinaryPayloadBytes!).toString("base64url"),
            protectedMessage: sharedAgent.protectedMessage,
            protectedMessageDigestBase64url:
              Buffer.from(sharedAgent.protectedMessageDigest)
                .toString("base64url"),
            senderDeviceSigningPublicKeyBase64url: Buffer.from(
              sharedAgent.senderDeviceSigningPublicKey,
            ).toString("base64url"),
            durableEventDigestBase64url:
              Buffer.from(eventDigest).toString("base64url"),
          });
        }
      } finally {
        eventDigest.fill(0);
        plan.namespaceHeadDigest.fill(0);
        plan.namespacePublicationDigest.fill(0);
        plan.namespacePublicationSetDigest.fill(0);
        plan.namespaceAudienceFingerprint.fill(0);
        sharedAgent.planBytes.fill(0);
        sharedAgent.requestBytes.fill(0);
        sharedAgent.ordinaryPayloadBytes!.fill(0);
        sharedAgent.protectedMessageDigest.fill(0);
        sharedAgent.senderDeviceSigningPublicKey.fill(0);
      }
    }
    await stampRetainedAttachmentTurnId(persisted.messageId, normalizedAttachments.statuses);
    return {
      ...persisted,
      humanPeerOperationId: humanPeer?.operationId,
      humanPeerProtectedMessage: humanPeer?.protectedMessage,
      humanPeerFallback,
      sharedAgentOperationId: sharedAgent?.operationId,
      sharedAgentProtectedMessage: sharedAgent?.protectedMessage,
      sharedAgentFallback,
    };
  });

  if ("strictShadowFailure" in out) {
    return reply.code(strictShadowHttpStatus(out.strictShadowFailure))
      .send(strictShadowHttpBody(out.strictShadowFailure));
  }

  // M254 R2/R7 — the Task reply hook sees only admitted, persisted messages.
  if (opts.content !== undefined) {
    void maybeResumeAwaitingTask(opts.detail.id, opts.sessionUserId, opts.content);
  }

  const canonical = {
    messageId: out.messageId,
    jobId: null as string | null,
    accepted: true as const,
    attachments: out.attachments,
    coalesced: out.coalesced,
    ...(out.humanPeerOperationId
      ? {
          liveShadow: {
            responseVersion: 1 as const,
            status: "human_verified" as const,
            operationId: out.humanPeerOperationId,
            protectedMessage: out.humanPeerProtectedMessage!,
          },
        }
      : {}),
    ...(!out.humanPeerOperationId && out.humanPeerFallback
      ? {
          liveShadow: {
            responseVersion: 1 as const,
            status: "ordinary_fallback" as const,
            operationId: out.humanPeerFallback.operationId,
            reason: out.humanPeerFallback.reason,
          },
        }
      : {}),
    ...(out.sharedAgentOperationId && out.sharedAgentProtectedMessage
      ? {
          liveShadow: {
            responseVersion: 1 as const,
            status: "human_verified" as const,
            operationId: out.sharedAgentOperationId,
            protectedMessage: out.sharedAgentProtectedMessage,
          },
        }
      : {}),
    ...(!out.sharedAgentOperationId && out.sharedAgentFallback
      ? {
          liveShadow: {
            responseVersion: 1 as const,
            status: "ordinary_fallback" as const,
            operationId: out.sharedAgentFallback.operationId,
            reason: out.sharedAgentFallback.reason,
          },
        }
      : {}),
  };
  if (opts.alias) {
    return reply
      .code(202)
      .send(
        legacyAliasSuccessBody(
          opts.detail.id,
          canonical.attachments,
          canonical.coalesced,
          canonical.jobId,
        ),
      );
  }
  return reply.code(201).send(canonical);
}

/**
 * M134 Phase 2/3 — group-room dispatch via the Room Conductor.
 *
 * A group room is anything with ≥1 agent that is NOT a strict 1-human-1-agent
 * DM. The Conductor decides which 0..N bots to wake deterministically; each
 * woken bot runs on its own per-`(room, bot)` thread id (P0) and per-single-
 * user lane key (P3). Focus is written once per woken bot when the decision
 * sets `writeFocus`. When no bot is woken the human message is still persisted
 * + broadcast (no LLM).
 */
async function dispatchGroupRoomMessage(
  _app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  opts: {
    detail: RoomDetailPayload;
    chatDeps: ChatRoutesDeps;
    alias: boolean;
    sessionUserId: string;
    sessionActorId: string;
    content?: string;
    representationMode?: "full_encryption";
    voiceMode: boolean;
    autoApprove: boolean;
    currentFolder: string | null;
    currentFolderRelayId: string | null;
    workspacePath: string | null;
    activeMiniApp: ActiveMiniAppRequestContext | null;
    liveMiniAppSession: TrustedLiveMiniAppSessionContext | null;
    attachmentRefs: string[];
    artifactRefs: ChatArtifactRef[];
    focusedResources: ChatFocusedResourceRef[];
    mentionedHumanUserIds: string[];
    mentionEveryone: boolean;
    ordinaryOrigin?: VerifiedOrdinaryOrigin;
    /** D424 — external workspace-artifact ids that may become cards. */
    workspaceArtifactExternalIds: string[];
    /** D424 — canonical room namespace id gating card authoring. */
    canonicalRoomNamespaceId?: string;
    replyToMessageId?: number;
    uiSelectedBotActorId: string | null;
    searchHistoryFlag: boolean;
    /**
     * D371 R2 — per-turn model override (nullable string). Forwarded to the
     * conductor wake path and the executor; null means "no override".
     */
    model?: string | null;
    /** D302 R13 — ask_user resume: reuse this turn id as the bot-turn sharedTurnId. */
    resumeTurnId?: string;
    /** D302 P4 — persisted human message id (filter from bot context block). */
    resumeMessageId?: number;
    /**
     * D420 — acceptance authority minted at the HTTP boundary; carried through
     * the conductor wake so the drain gate bypasses this accepted turn.
     */
    acceptanceAuthority?: MaintenanceAcceptanceAuthority;
    /** M254 — Human invocation admission for this accepted Room turn. */
    invocationAuthority: AcceptedInvocationAuthority;
  clientActionSessionId?: unknown;
    liveShadow?: unknown;
  },
): Promise<void> {
  const {
    detail,
    chatDeps,
    alias,
    sessionUserId,
    sessionActorId,
    content,
    representationMode,
    voiceMode,
    autoApprove,
    currentFolder,
    currentFolderRelayId,
    workspacePath,
    activeMiniApp,
    liveMiniAppSession,
    attachmentRefs,
    artifactRefs,
    focusedResources,
    mentionedHumanUserIds,
    mentionEveryone: bodyMentionEveryone,
    workspaceArtifactExternalIds,
    searchHistoryFlag,
    uiSelectedBotActorId,
  } = opts;
  let mentionEveryone = bodyMentionEveryone;
  const replyToMessageId = opts.replyToMessageId;
  const model = opts.model ?? null;
  const canonicalRoomNamespaceId = opts.canonicalRoomNamespaceId;
  const clientActionBindingRegistry = getClientActionBindingRegistry();

  const buildEnvelopeForRoom =
    chatDeps.buildEnvelopeForRoom ?? defaultChatRoutesDeps.buildEnvelopeForRoom;
  if (!buildEnvelopeForRoom) {
    return reply.code(500).send({
      error: "internal_error",
      detail: "canonical room envelope builder unavailable",
    });
  }

  let out: PersistedHumanForRouting;
  let clientActionBindingHandle: string | undefined;
  let foregroundTurnCoalescingContext: NonNullable<ForegroundTurnCandidate["coalescingContext"]> | undefined;
  if (opts.resumeTurnId) {
    if (content === undefined) {
      return reply.code(400).send({ error: "full_encryption_resume_unsupported" });
    }
    // D302 P4 — ask_user resume. The original human row was already persisted
    // before the picker appeared; do not write/broadcast it again.
    out = {
      messageId: opts.resumeMessageId ?? null,
      humanTurnId: opts.resumeTurnId,
      attachments: [],
      coalesced: true,
      routingView: buildRoutingView(content),
      // If the original turn was protected, its operation id is the canonical
      // Human turn id. The planner revalidates this before any transition.
      sharedAgentOperationId: opts.resumeTurnId,
    };
  } else {
    clientActionBindingHandle = clientActionBindingRegistry?.reserve({
      clientActionSessionId: opts.clientActionSessionId,
      actorId: sessionActorId,
    }) ?? undefined;
    // D302 P4 — optimistic delivery: persist + broadcast the human message
    // before any conductor/FM work, so send never waits on routing.
    const turnId = randomUUID();
    try {
      out = await runWithTurn(turnId, async () => {
      const normalizedAttachments =
        attachmentRefs.length > 0
          ? await normalizeChatAttachments(
              uploadedAttachmentArgs(attachmentRefs, request.sessionActorId, request.memoryEnvelope),
            )
          : { textBlocks: [] as string[], mediaParts: [], statuses: [] as ChatAttachmentStatus[] };
      let sharedAgent:
        | Readonly<{
            operationId: string;
            planBytes: Uint8Array;
            requestBytes: Uint8Array;
            ordinaryPayloadBytes?: Uint8Array;
            protectedMessage: import("@nautilo/types").ProtectedMessageDtoV2;
            protectedMessageDigest: Uint8Array;
            senderDeviceSigningPublicKey: Uint8Array;
            messageId: number;
            content?: string;
            representationMode?: "shadow_encryption" | "full_encryption";
            mentionEveryone?: boolean;
          }>
        | undefined;
      let sharedAgentFallback:
        | Readonly<{
            operationId: string;
            reason:
              | "request_invalid"
              | "authority_stale"
              | "human_parity_failed"
              | "human_persistence_failed"
              | "deadline_expired"
              | "integrity_conflict";
            messageId: number | null;
          }>
        | undefined;
      const parsed = liveShadowMessageSendAttemptV1Schema.safeParse(
        opts.liveShadow,
      );
      if (
        parsed.success
        && parsed.data.status === "prepared"
        && "authorizationScheme" in parsed.data
        && (parsed.data.authorizationScheme === "shared_agent_v1"
          || parsed.data.authorizationScheme === "human_ai_readable_v1"
          || parsed.data.authorizationScheme === "human_ai_readable_v2")
      ) {
        const decoded = decodePreparedLiveShadowAttempt(parsed.data);
        const composition = getProductionLiveShadowMessageComposition(
          request.server,
        );
        if (
          decoded !== null
          && (decoded.representationMode !== "full_encryption"
            || parsed.data.authorizationScheme === "human_ai_readable_v1"
            || parsed.data.authorizationScheme === "human_ai_readable_v2")
          && composition?.admitSharedAgent !== undefined
        ) {
          try {
            const plan = parsed.data.authorizationScheme === "human_ai_readable_v1"
              || parsed.data.authorizationScheme === "human_ai_readable_v2"
              ? decodeHumanAiReadableLiveShadowMessagePlan(decoded.planBytes)
              : decodeSharedAgentLiveShadowMessagePlanV1(decoded.planBytes);
            const planMatchesRoom = plan.roomId === detail.id;
            plan.namespaceHeadDigest.fill(0);
            plan.namespacePublicationDigest.fill(0);
            plan.namespacePublicationSetDigest.fill(0);
            plan.namespaceAudienceFingerprint.fill(0);
            if (!planMatchesRoom) throw new Error("Protected plan Room mismatch");
            const admitted = await composition.admitSharedAgent({
              operationId: parsed.data.operationId,
              userId: sessionUserId,
              actorId: sessionActorId,
              ...(decoded.representationMode === "full_encryption"
                ? { representationMode: "full_encryption" as const }
                : {
                    expectedContent: normalizeHumanMessageText(content!),
                    ordinaryPayloadBytes: decoded.ordinaryPayloadBytes,
                  }),
              planBytes: decoded.planBytes,
              requestBytes: decoded.requestBytes,
              encryptedPayloadBytes: decoded.encryptedPayloadBytes,
              manifestBytes: decoded.manifestBytes,
              envelopeBytes: decoded.envelopeBytes,
              now: Date.now(),
            });
            if (admitted.status === "ordinary_fallback") {
              sharedAgentFallback = Object.freeze({
                operationId: admitted.operationId,
                reason: admitted.reason,
                messageId: admitted.messageId,
              });
            } else {
              sharedAgent = Object.freeze({
                operationId: admitted.operationId,
                planBytes: decoded.planBytes.slice(),
                requestBytes: decoded.requestBytes.slice(),
                ...(decoded.representationMode === "full_encryption" ? {
                  representationMode: "full_encryption" as const,
                } : {
                  ordinaryPayloadBytes: decoded.ordinaryPayloadBytes.slice(),
                  ...("content" in admitted ? { content: admitted.content } : {}),
                }),
                protectedMessage: admitted.protectedMessage,
                protectedMessageDigest:
                  admitted.protectedMessageDigest.slice(),
                senderDeviceSigningPublicKey:
                  admitted.senderDeviceSigningPublicKey.slice(),
                messageId: admitted.messageId,
                ...("mentionEveryone" in admitted
                  && admitted.mentionEveryone === true
                  ? { mentionEveryone: true }
                  : {}),
              });
              mentionEveryone = "mentionEveryone" in admitted
                && admitted.mentionEveryone === true;
            }
            if (admitted.status !== "ordinary_fallback") {
              admitted.protectedMessageDigest.fill(0);
              admitted.senderDeviceSigningPublicKey.fill(0);
            }
          } finally {
            decoded.planBytes.fill(0);
            decoded.requestBytes.fill(0);
            decoded.ordinaryPayloadBytes?.fill(0);
            decoded.encryptedPayloadBytes.fill(0);
            decoded.manifestBytes.fill(0);
            decoded.envelopeBytes.fill(0);
            decoded.grantBytes.fill(0);
          }
        }
      }
      if (parsed.success && parsed.data.status !== "prepared") {
        log(`[live-shadow] client preparation unavailable reason=${parsed.data.reason}`);
      }
      const groupStrictDecision = await strictShadowBoundaryEnforcer(chatDeps)({
        boundaryId: "conversation.write.human_peer",
        ...(sharedAgent !== undefined
          ? { state: "verified" as const, reason: "none" as const, retryable: false }
          : sharedAgentFallback !== undefined
          ? classifyLiveShadowBoundaryFailure(sharedAgentFallback.reason)
          : parsed.success && parsed.data.status !== "prepared"
          ? classifyLiveShadowBoundaryFailure(parsed.data.reason)
          : {
            state: "unsupported" as const,
            reason: "unsupported_operation" as const,
            retryable: false,
          }),
      });
      if (
        groupStrictDecision.result.disposition === "withhold"
        || groupStrictDecision.result.disposition === "reject"
      ) throw new StrictShadowDispatchError(groupStrictDecision.result);
      const persisted = sharedAgent?.representationMode === "full_encryption"
        ? await finalizeProtectedHumanPeerMessage({
            room: detail,
            senderUserId: sessionUserId,
            messageId: sharedAgent.messageId,
            operationId: sharedAgent.operationId,
            attachmentStatuses: [],
          })
        : await peerBroadcastHumanMessage({
        room: detail,
        senderUserId: sessionUserId,
        content: content!,
        attachmentTextBlocks: normalizedAttachments.textBlocks,
        multimodalImages: normalizedAttachments.mediaParts,
        replyToMessageId,
        attachmentStatuses: normalizedAttachments.statuses,
        workspaceArtifactExternalIds,
        mentionedHumanUserIds,
        mentionEveryone,
        ...(canonicalRoomNamespaceId ? { canonicalRoomNamespaceId } : {}),
        ...(sharedAgent === undefined && sharedAgentFallback?.messageId == null
          ? {}
          : {
              persistedMessage: {
                ...(sharedAgent ? { createdAt: sharedAgent.protectedMessage.projection.createdAt } : {}),
                messageId: sharedAgent?.messageId
                  ?? sharedAgentFallback!.messageId!,
                content: sharedAgent?.content
                  ?? normalizeHumanMessageText(content!),
                fingerprint: sharedAgent?.operationId
                  ?? sharedAgentFallback!.operationId,
                humanTurnId: sharedAgent?.operationId
                  ?? sharedAgentFallback!.operationId,
              },
            }),
      });
      if (sharedAgentFallback !== undefined) {
        const terminal = sharedAgentFallback.reason === "authority_stale"
          ? { stage: "human_admission" as const, reason: "stale_authority" as const }
          : sharedAgentFallback.reason === "human_parity_failed"
            ? { stage: "human_admission" as const, reason: "parity_mismatch" as const }
            : sharedAgentFallback.reason === "deadline_expired"
              ? { stage: "human_admission" as const, reason: "deadline_expired" as const }
              : sharedAgentFallback.reason === "human_persistence_failed"
                ? { stage: "protected_completion" as const, reason: "storage_failure" as const }
                : sharedAgentFallback.reason === "integrity_conflict"
                  ? { stage: "product_mapping" as const, reason: "product_conflict" as const }
                  : { stage: "human_admission" as const, reason: "integrity_failure" as const };
        await getProductionLiveShadowMessageComposition(request.server)
          ?.recordSharedAgentFallback?.({
            actorId: sessionActorId,
            operationId: sharedAgentFallback.operationId,
            ...terminal,
            now: Date.now(),
          }).catch((error) => {
            log(
              `[m296] Shared-Agent fallback receipt failed operation=${sharedAgentFallback.operationId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      if (sharedAgent !== undefined) {
        const plan = (() => {
          try {
            return decodeHumanAiReadableLiveShadowMessagePlan(
              sharedAgent.planBytes,
            );
          } catch {
            return decodeSharedAgentLiveShadowMessagePlanV1(
              sharedAgent.planBytes,
            );
          }
        })();
        const crypto = new LatticeCrypto();
        const eventDigest = sharedAgent.representationMode === "full_encryption"
          ? fullEncryptionDurableEventDigestV2(crypto, {
              operationId: sharedAgent.operationId,
              policyRevision: plan.policyRevision,
              transcriptOrdinal: plan.transcriptOrdinal,
              protectedMessage: sharedAgent.protectedMessage,
            })
          : liveShadowDurableEventDigestV1(crypto, {
              operationId: sharedAgent.operationId,
              policyRevision: plan.policyRevision,
              transcriptOrdinal: plan.transcriptOrdinal,
              ordinaryPayloadBytes: sharedAgent.ordinaryPayloadBytes!,
              protectedMessage: sharedAgent.protectedMessage,
            });
        try {
          const published = await getProductionLiveShadowMessageComposition(
            request.server,
          )?.recordSharedAgentPublished?.({
            operationId: sharedAgent.operationId,
            messageId: sharedAgent.messageId,
            protectedMessageDigest: sharedAgent.protectedMessageDigest,
            finalEventDigest: eventDigest,
            now: Date.now(),
          });
          if (published === "published" || published === "replayed") {
            const commonEvent = {
              type: "message.shared_agent_shadow",
              laneKey: `room:${detail.id}`,
              operationId: sharedAgent.operationId,
              policyRevision: plan.policyRevision,
              transcriptOrdinal: plan.transcriptOrdinal,
              logicalMessageKey: `turn:${sharedAgent.operationId}`,
              planBytesBase64url:
                Buffer.from(sharedAgent.planBytes).toString("base64url"),
              requestBytesBase64url:
                Buffer.from(sharedAgent.requestBytes).toString("base64url"),
              protectedMessage: sharedAgent.protectedMessage,
              protectedMessageDigestBase64url:
                Buffer.from(sharedAgent.protectedMessageDigest)
                  .toString("base64url"),
              senderDeviceSigningPublicKeyBase64url: Buffer.from(
                sharedAgent.senderDeviceSigningPublicKey,
              ).toString("base64url"),
              durableEventDigestBase64url:
                Buffer.from(eventDigest).toString("base64url"),
            } as const;
            eventBus.emit(sharedAgent.representationMode === "full_encryption"
              ? { ...commonEvent, wireVersion: 2 as const }
              : { ...commonEvent, wireVersion: 1 as const,
                  ordinaryPayloadBytesBase64url: Buffer.from(
                    sharedAgent.ordinaryPayloadBytes!,
                  ).toString("base64url") });
          }
        } finally {
          eventDigest.fill(0);
          plan.namespaceHeadDigest.fill(0);
          plan.namespacePublicationDigest.fill(0);
          plan.namespacePublicationSetDigest.fill(0);
          plan.namespaceAudienceFingerprint.fill(0);
          sharedAgent.planBytes.fill(0);
          sharedAgent.requestBytes.fill(0);
          sharedAgent.ordinaryPayloadBytes?.fill(0);
          sharedAgent.protectedMessageDigest.fill(0);
          sharedAgent.senderDeviceSigningPublicKey.fill(0);
        }
      }
      // D391 — link this turn's retained attachments to the human message
      // fingerprint so they render from room history (once, not per-bot).
      await stampRetainedAttachmentTurnId(persisted.messageId, normalizedAttachments.statuses);
      return {
        messageId: persisted.messageId,
        humanTurnId: persisted.humanTurnId,
        attachments: persisted.attachments,
        coalesced: persisted.coalesced,
        ...(sharedAgent?.representationMode === "full_encryption" ? {
          representationMode: "full_encryption" as const,
        } : { routingView: buildRoutingView(content!, {
          attachments: persisted.attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            decision: a.decision,
            ...(a.kind ? { kind: a.kind } : {}),
            ...(a.reason ? { reason: a.reason } : {}),
          })),
        }) }),
        ...(sharedAgent === undefined
          ? {}
          : {
              sharedAgentOperationId: sharedAgent.operationId,
              sharedAgentProtectedMessage: sharedAgent.protectedMessage,
            }),
        ...(sharedAgentFallback === undefined
          ? {}
          : { sharedAgentFallback }),
      };
      });
    } catch (error) {
      if (clientActionBindingHandle) clientActionBindingRegistry?.cancel(clientActionBindingHandle);
      if (error instanceof StrictShadowDispatchError) {
        return reply.code(strictShadowHttpStatus(error.result))
          .send(strictShadowHttpBody(error.result));
      }
      throw error;
    }
    if (clientActionBindingHandle) {
      clientActionBindingRegistry?.holdGroupTurn(clientActionBindingHandle, out.humanTurnId);
      foregroundTurnCoalescingContext = clientActionBindingRegistry
        ?.coalescingContextForHandle(clientActionBindingHandle);
    }
  }

  if (!opts.resumeTurnId && content !== undefined) {
    // M254 R2/R7 — only a newly admitted, persisted Human message may attempt
    // the independently gated awaiting-Task resume.
    void maybeResumeAwaitingTask(detail.id, sessionUserId, content);
  }

  const conductorArgs: GroupRoomConductorAfterPersistArgs = {
    detail,
    chatDeps,
    request,
    sessionUserId,
    sessionActorId,
    ...(content === undefined ? {} : { content }),
    ...(representationMode === undefined ? {} : { representationMode }),
    voiceMode,
    autoApprove,
    currentFolder,
    currentFolderRelayId,
    workspacePath,
    activeMiniApp,
    liveMiniAppSession,
    attachmentRefs,
    artifactRefs,
    focusedResources,
    mentionedHumanUserIds,
    mentionEveryone,
    ...(opts.ordinaryOrigin ? { ordinaryOrigin: opts.ordinaryOrigin } : {}),
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    uiSelectedBotActorId,
    ...(opts.resumeTurnId ? { resumeTurnId: opts.resumeTurnId } : {}),
    searchHistoryFlag,
    ...(model ? { model } : {}),
    buildEnvelopeForRoom,
    persistedHuman: out,
    // D420 — carry the HTTP-boundary acceptance authority through the async wake.
    ...(opts.acceptanceAuthority ? { acceptanceAuthority: opts.acceptanceAuthority } : {}),
    invocationAuthority: opts.invocationAuthority,
    ...(clientActionBindingHandle ? { clientActionBindingRegistry } : {}),
    ...(foregroundTurnCoalescingContext ? { foregroundTurnCoalescingContext } : {}),
    ...(typeof opts.clientActionSessionId === "string"
      ? { clientActionSessionId: opts.clientActionSessionId }
      : {}),
  };
  if (representationMode === "full_encryption") {
    void runSerializedGroupRoomConductorAfterPersist(conductorArgs).catch((err) => {
      log(`[conductor] async protected route/wake failed for room=${detail.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  } else {
    scheduleGroupRoomConductorAfterPersist(conductorArgs);
  }

  const canonical = {
    messageId: out.messageId,
    jobId: null as string | null,
    accepted: true as const,
    attachments: out.attachments,
    coalesced: out.coalesced,
    ...(out.sharedAgentOperationId && out.sharedAgentProtectedMessage
      ? {
          liveShadow: {
            responseVersion: 1 as const,
            status: "human_verified" as const,
            operationId: out.sharedAgentOperationId,
            protectedMessage: out.sharedAgentProtectedMessage,
          },
        }
      : {}),
    ...(!out.sharedAgentOperationId && out.sharedAgentFallback
      ? {
          liveShadow: {
            responseVersion: 1 as const,
            status: "ordinary_fallback" as const,
            operationId: out.sharedAgentFallback.operationId,
            reason: out.sharedAgentFallback.reason,
          },
        }
      : {}),
  };
  if (alias) {
    return reply
      .code(202)
      .send(legacyAliasSuccessBody(detail.id, canonical.attachments, canonical.coalesced, canonical.jobId));
  }
  return reply.code(202).send(canonical);
}

function scheduleGroupRoomConductorAfterPersist(args: GroupRoomConductorAfterPersistArgs): void {
  if (args.content === undefined || args.persistedHuman.routingView === undefined) {
    throw new TypeError("Ordinary Conductor coalescing requires ordinary routing content");
  }
  const item: ConductorRoutingItem = {
    roomId: args.detail.id,
    userActorId: args.sessionActorId,
    ...(args.ordinaryOrigin ? { ordinaryOrigin: args.ordinaryOrigin } : {}),
    content: args.content,
    voiceMode: args.voiceMode,
    autoApprove: args.autoApprove,
    currentFolder: args.currentFolder,
    currentFolderRelayId: args.currentFolderRelayId,
    workspacePath: args.workspacePath,
    activeMiniApp: args.activeMiniApp,
    ...(args.liveMiniAppSession ? { liveMiniAppSession: args.liveMiniAppSession } : {}),
    attachmentRefs: args.attachmentRefs,
    artifactRefs: args.artifactRefs,
    focusedResources: args.focusedResources,
    mentionEveryone: args.mentionEveryone,
    ...(args.replyToMessageId !== undefined ? { replyToMessageId: args.replyToMessageId } : {}),
    uiSelectedBotActorId: args.uiSelectedBotActorId,
    searchHistoryFlag: args.searchHistoryFlag,
    ...(args.model ? { model: args.model } : {}),
    ...(args.foregroundTurnCoalescingContext
      ? { coalescingContext: args.foregroundTurnCoalescingContext }
      : {}),
    persistedHuman: {
      ...args.persistedHuman,
      routingView: args.persistedHuman.routingView,
    },
  };

  const result = conductorCoalescer.enqueue(item);
  if (result === "buffered") {
    conductorRoutingContexts.set(args.persistedHuman.humanTurnId, args);
    return;
  }

  args.clientActionBindingRegistry?.resolveGroupTurns([args.persistedHuman.humanTurnId]);

  void runSerializedGroupRoomConductorAfterPersist(args).catch((err) => {
    log(
      `[conductor] async route/wake failed for room=${args.detail.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

async function flushCoalescedGroupRoomConductorAfterPersist(
  merged: CoalescedConductorRoutingItem,
): Promise<void> {
  const latestTurnId = merged.coveredHumanTurnIds[merged.coveredHumanTurnIds.length - 1];
  const baseArgs = latestTurnId ? conductorRoutingContexts.get(latestTurnId) : undefined;
  for (const turnId of merged.coveredHumanTurnIds) {
    const context = conductorRoutingContexts.get(turnId);
    if (context?.clientActionBindingRegistry) {
      if (merged.coveredHumanTurnIds.length === 1) {
        context.clientActionBindingRegistry.resolveGroupTurns(merged.coveredHumanTurnIds);
      } else {
        context.clientActionBindingRegistry.cancelGroupTurns(merged.coveredHumanTurnIds);
      }
    }
  }
  for (const turnId of merged.coveredHumanTurnIds) {
    conductorRoutingContexts.delete(turnId);
  }
  if (!baseArgs) {
    log(`[conductor] missing coalesced routing context for room=${merged.roomId}`);
    return;
  }

  const attachmentDescriptors = merged.persistedHuman.attachments.map((a) => ({
    id: a.id,
    filename: a.filename,
    decision: a.decision,
    ...(a.kind ? { kind: a.kind } : {}),
    ...(a.reason ? { reason: a.reason } : {}),
  }));
  const replyToMessageId =
    typeof merged.replyToMessageId === "number" ? merged.replyToMessageId : undefined;
  const persistedHuman: PersistedHumanForRouting = {
    ...merged.persistedHuman,
    routingView: buildRoutingView(merged.content, {
      attachments: attachmentDescriptors,
    }),
  };

  const { foregroundTurnCoalescingContext: _discardedBurstSurface, ...baseArgsWithoutSurface } = baseArgs;
  await runSerializedGroupRoomConductorAfterPersist({
    ...baseArgsWithoutSurface,
    ...(merged.coalescingContext
      ? { foregroundTurnCoalescingContext: merged.coalescingContext }
      : {}),
    ...(merged.ordinaryOrigin ? { ordinaryOrigin: merged.ordinaryOrigin } : {}),
    content: merged.content,
    voiceMode: merged.voiceMode,
    autoApprove: merged.autoApprove === true,
    currentFolder: merged.currentFolder,
    currentFolderRelayId: merged.currentFolderRelayId,
    workspacePath: merged.workspacePath,
    activeMiniApp: merged.activeMiniApp,
    liveMiniAppSession: merged.liveMiniAppSession ?? null,
    attachmentRefs: merged.attachmentRefs,
    artifactRefs: merged.artifactRefs,
    focusedResources: merged.focusedResources ?? [],
    mentionEveryone: merged.mentionEveryone === true,
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    uiSelectedBotActorId: merged.uiSelectedBotActorId ?? null,
    searchHistoryFlag: merged.searchHistoryFlag,
    ...(merged.model ? { model: merged.model } : {}),
    burstHint: {
      count: merged.burstCount,
      coveredMessageIds: merged.coveredMessageIds,
      coveredSharedAgentOperationIds:
        merged.coveredSharedAgentOperationIds,
    },
    persistedHuman,
  });
}

async function runSerializedGroupRoomConductorAfterPersist(
  args: GroupRoomConductorAfterPersistArgs,
): Promise<void> {
  const release = await conductorRoomLock.acquire(`room:${args.detail.id}:conductor`);
  try {
    await runGroupRoomConductorAfterPersist(args);
  } finally {
    await release();
  }
}

async function authorizeRuntimeInvocationForForeground(input: Readonly<{
  composition: NonNullable<ReturnType<
    typeof getProductionLiveShadowMessageComposition
  >>;
  invocation: import("@nautilo/lattice-bridge/server")
    .SharedAgentRuntimeInvocationReservation;
  operationIds: readonly string[];
  userId: string;
  humanActorId: string;
}>): Promise<import("@nautilo/lattice-bridge/server")
  .ForegroundLiveShadowSessionExecutionCapability | null> {
  const planned = await input.composition
    .planRuntimeInvocationAuthorization?.({
      authority: {
        userId: input.userId,
        humanActorId: input.humanActorId,
      },
      invocationId: input.invocation.invocationId,
      operationIds: input.operationIds,
      roomId: input.invocation.roomId,
      clientActionSessionId: input.invocation.clientActionSessionId,
      clientDeviceId: input.invocation.invokingDeviceId,
      now: Date.now(),
    });
  if (planned?.status === "authorized") {
    return Object.freeze({
      kind: "foreground_session" as const,
      sessionReference: planned.sessionReference,
      authorizationDigest: planned.authorizationDigest,
      scope: planned.scope,
    });
  }
  if (planned?.status !== "authorization_required") {
    const reason = planned === undefined
      ? "planner_unavailable"
      : planned.status === "disabled"
        ? planned.mode
        : planned.reason;
    log(
      `[m299] Runtime invocation authorization unavailable room=${input.invocation.roomId} invocation=${input.invocation.invocationId} reason=${reason}`,
    );
    return null;
  }
  const pending = input.composition.awaitRuntimeInvocationAuthorization?.({
    invocationId: input.invocation.invocationId,
    deadlineAt: input.invocation.deadlineAt,
  });
  try {
    eventBus.emit({
      wireVersion: 1,
      type: "message.runtime_invocation_authorization_required",
      laneKey: `room:${input.invocation.roomId}`,
      userId: input.userId,
      roomId: input.invocation.roomId,
      invocationId: input.invocation.invocationId,
      clientActionSessionId: input.invocation.clientActionSessionId,
      authorizationScheme: "runtime_foreground_v1",
      authorizationPlanBytesBase64url:
        Buffer.from(planned.authorizationPlanBytes).toString("base64url"),
      sourceHumanPlanBytesBase64url:
        Buffer.from(planned.sourceHumanPlanBytes).toString("base64url"),
      recipientPublicKeyBase64url:
        Buffer.from(planned.recipientPublicKey).toString("base64url"),
      deadlineAt: input.invocation.deadlineAt,
    });
  } finally {
    planned.authorizationPlanBytes.fill(0);
    planned.sourceHumanPlanBytes.fill(0);
    planned.recipientPublicKey.fill(0);
    planned.scope.domainAuthoritySetDigest.fill(0);
  }
  return (await pending)?.capability ?? null;
}

async function runGroupRoomConductorAfterPersist(
  args: GroupRoomConductorAfterPersistArgs,
): Promise<void> {
  const {
    detail,
    chatDeps,
    sessionUserId,
    sessionActorId,
    content,
    voiceMode,
    currentFolder,
    currentFolderRelayId,
    workspacePath,
    activeMiniApp,
    liveMiniAppSession,
    attachmentRefs,
    artifactRefs,
    focusedResources,
    searchHistoryFlag,
    uiSelectedBotActorId,
    buildEnvelopeForRoom,
    persistedHuman,
  } = args;
  const full = args.representationMode === "full_encryption";
  let transientRoutingContent = content;
  const replyToMessageId = args.replyToMessageId;
  const model = args.model ?? null;
  const coveredSharedAgentOperationIds = args.burstHint
    ?.coveredSharedAgentOperationIds
    ?? (persistedHuman.sharedAgentOperationId
      ? [persistedHuman.sharedAgentOperationId]
      : []);
  const coveredInputCount = args.burstHint?.count ?? 1;
  const completeProtectedInputSet =
    coveredSharedAgentOperationIds.length === coveredInputCount;
  const resolveSharedAgentConductor = async (
    state: "awaiting_user" | "not_selected" | "unavailable",
    reason: string,
  ): Promise<void> => {
    if (coveredSharedAgentOperationIds.length === 0) return;
    const result = await getProductionLiveShadowMessageComposition(
      args.request.server,
    )?.recordSharedAgentConductorResolution?.({
      operationIds: coveredSharedAgentOperationIds,
      roomId: detail.id,
      subjectHumanId: sessionActorId,
      state,
      reason,
      now: Date.now(),
    });
    if (result === "conflict") {
      log(
        `[m296] Shared-Agent Conductor receipt conflicted room=${detail.id} state=${state}`,
      );
    }
  };

  const db = getSharedDirectDb();
  // Build Conductor member views with each agent's STORED response mode.
    const modeRows = await findRoomAgentResponseModes(db, detail.id);
    const modeByActor = new Map(modeRows.map((r) => [r.actorId, r.mode]));
    const members: RoomMemberView[] = detail.members.map((m) => ({
      kind: m.kind,
      actorId: m.actorId,
      ...(m.agentId ? { agentId: m.agentId } : {}),
      handle: m.handle ?? "",
      displayName: m.displayName,
      ...(m.kind === "agent"
        ? {
            agentOwnerDisplayName: m.agentOwnerDisplayName ?? null,
            agentOwnerHandle: m.agentOwnerHandle ?? null,
          }
        : {}),
      agentResponseMode:
        m.kind === "agent" ? (modeByActor.get(m.actorId) ?? null) : null,
    }));

    const now = new Date();
    let decision: ConductorDecision;
    const routingTrace: Array<{ step: string; detail: Record<string, unknown> }> = [];
    const debugLevel = conductorDebugLevel();
    const debugEnabled = debugLevel !== "off" && conductorDebugRoomMatches(detail);
    const onDebug = debugEnabled
      ? (event: { phase: string; detail: Record<string, unknown> }) =>
          conductorDebugLog(detail, event.phase, event.detail)
      : undefined;
    eventBus.emit({
      type: "conductor.routing",
      laneKey: `room:${detail.id}`,
      roomId: detail.id,
      userActorId: sessionActorId,
      state: "deciding",
    });
    if (args.burstHint && args.burstHint.count > 1) {
      routingTrace.push({
        step: "coalesced-burst",
        detail: {
          count: args.burstHint.count,
          coveredMessageIds: args.burstHint.coveredMessageIds ?? [],
        },
      });
    }
    // D281 — server-wide admin-configured Conductor model (DB-backed, live
    // via cache) overrides the env/runtime-config value when set. Empty ⇒
    // inherit the runtime config (which itself falls back to the default).
    kickServerModelConfigRefresh();
    const serverConductor = getCachedServerModelConfigRow()?.conductorModel;
    const conductorModelId = resolveRoomSideModelId({
      serverConfiguredModelId: serverConductor,
      runtimeConfiguredModelId: fromRuntimeConfig().nautilo_conductor_model,
    });
    const conductorLaneKey = `room:${detail.id}:conductor`;
    let protectedRoutePath: import("@nautilo/lattice-bridge/server")
      .RuntimeInvocationConductorRoutePath = "deterministic";
    let protectedHistoryStatus: import("@nautilo/lattice-bridge/server")
      .RuntimeInvocationConductorHistoryStatus = "not_requested";
    const routeWithContent = (
      routingContent: string,
      protectedAttempt: boolean,
      openProtectedHistory?: (
        candidates: readonly RoomHistoryHit[],
      ) => Promise<readonly RoomHistoryHit[] | null>,
    ) => routeRoomMessage(
        {
          mode: detail.conductorMode === "standard" ? "standard" : "advanced",
          loadActiveFoci: (roomId, userActorId, asOf) =>
            loadActiveFoci(db, roomId, userActorId, asOf),
          loadActiveSilenceForRoom: (roomId, asOf) =>
            loadActiveSilenceForRoom(db, roomId, asOf),
          resolveReplyTargetActorId: (mid) =>
            findReplyTargetAgentActorId(db, detail.id, mid),
          searchRoomHistory: protectedAttempt
            ? async (roomId, query, limit) => {
                if (openProtectedHistory === undefined) {
                  throw new Error("protected_history_unavailable");
                }
                const candidates = await searchRoomHistoryRelaxed(db, {
                  roomId,
                  query,
                  limit,
                });
                const opened = await openProtectedHistory(candidates);
                if (opened === null) {
                  throw new Error("protected_history_unavailable");
                }
                protectedHistoryStatus = "verified";
                return [...opened];
              }
            : (roomId, query, limit) =>
                searchRoomHistoryRelaxed(db, { roomId, query, limit }),
          getPrecedingMessageId: (roomId) => latestRoomMessageId(db, roomId),
          loadRoutingPacket: (roomId, userActorId, asOf, roomMembers) =>
            loadRoutingPacket(db, {
              roomId,
              userActorId,
              now: asOf,
              members: roomMembers,
            }),
          // D426 — normal requester-private Room focus is resolved in the
          // runtime before this one-shot root fallback. Live dispatch neither
          // reads nor establishes a durable Subthread Responder.
          resolveSubthreadRootAffinity: (subthreadRoomId, _asOf, currentMessageId) =>
            resolveSubthreadRootAffinity(db, subthreadRoomId, currentMessageId),
          floorManager: (fmCtx, extra) => {
            if (protectedAttempt) protectedRoutePath = "floor_manager";
            return runFloorManager(fmCtx, extra, {
              invokeModel: createConductorModelInvoker({
                modelId: conductorModelId,
                userId: sessionUserId,
                agentId: null,
                laneKey: conductorLaneKey,
              }),
              ...(!protectedAttempt && onDebug
                ? { onDebug, debugPrompt: debugLevel === "prompt" }
                : {}),
            });
          },
          ...(!protectedAttempt
            ? {
                onTrace: (step: string, detail: Record<string, unknown>) =>
                  routingTrace.push({ step, detail }),
              }
            : {}),
          ...(!protectedAttempt && onDebug ? { onDebug } : {}),
        },
        {
          roomId: detail.id,
          roomKind: detail.kind,
          userActorId: sessionActorId,
          message: {
            content: routingContent,
            ...(args.mentionEveryone ? { mentionEveryone: true } : {}),
            sourceMessageId: persistedHuman.messageId,
            ...(args.burstHint ? { burstHint: args.burstHint } : {}),
            replyToMessageId: replyToMessageId ?? null,
            uiSelectedBotActorId,
            searchHistoryFlag,
            routingView: buildRoutingView(routingContent, {
              ...(persistedHuman.routingView?.attachments === undefined
                ? {}
                : { attachments: persistedHuman.routingView.attachments }),
            }),
          },
          members,
          now,
        },
      );
    const rejectProtectedConductor = async (
      reason: "authority_unavailable" | "protected_failed" | "unsupported" | "key_waiting",
    ): Promise<never> => {
      // Preserve the canonical boundary observation lifecycle. Its disposition
      // is evidence only here; the shared operational owner decides whether an
      // ordinary representation may actually be consumed.
      await strictShadowBoundaryEnforcer(chatDeps)({
        boundaryId: "conversation.search.conductor",
        ...(reason === "authority_unavailable" || reason === "key_waiting"
          ? { state: "waiting_for_authority" as const, reason: "domain_authority_converging" as const, retryable: true }
          : reason === "unsupported"
          ? { state: "unsupported" as const, reason: "unsupported_operation" as const, retryable: false }
          : { state: "failed" as const, reason: "integrity_failure" as const, retryable: false }),
      });
      throw new ClassifiedDataOperationError(
        reason === "key_waiting" ? "key_waiting"
          : reason === "authority_unavailable" ? "authority"
          : reason === "unsupported" ? "unsupported" : "integrity",
        `Protected Conductor routing is ${reason}`,
      );
    };
    const composition = getProductionLiveShadowMessageComposition(
      args.request.server,
    );
    const conductorInvocation: {
      current: import("@nautilo/lattice-bridge/server").SharedAgentRuntimeInvocationReservation | null;
    } = { current: null };
    let protectedConductorSucceeded = false;
    let protectedConductorAttempted = false;
    let protectedConductorFellBack = false;
    let protectedAgentInvocationReady = false;
    let runtimeInvocationCarriesConductorDecision = false;
    const resumingProtectedAskUser = args.resumeTurnId !== undefined
      && uiSelectedBotActorId !== null
      && completeProtectedInputSet
      && coveredSharedAgentOperationIds.length > 0
      && args.clientActionSessionId !== undefined
      && composition !== null;
    try {
      const routed = await routeConductorWithDataOwner<ConductorDecision | null>({
        readPolicy: strictShadowPolicyReader(chatDeps),
        ordinary: () => {
          if (content === undefined) throw new ClassifiedDataOperationError(
            "integrity", "Conductor has no ordinary source for fallback",
          );
          protectedConductorFellBack = protectedConductorAttempted;
          return routeWithContent(content, false);
        },
        protected: async () => {
          let protectedDecision: ConductorDecision;
      if (resumingProtectedAskUser) {
        protectedConductorAttempted = true;
        const priorConductorInvocation = await composition
          .reserveSharedAgentRuntimeInvocation?.({
            operationIds: coveredSharedAgentOperationIds,
            roomId: detail.id,
            subjectHumanId: sessionActorId,
            clientActionSessionId: args.clientActionSessionId!,
            purpose: "conductor",
            now: Date.now(),
          }) ?? null;
        if (priorConductorInvocation?.conductorAwaitingUser === true) {
          if (priorConductorInvocation.deadlineAt > Date.now()) {
            conductorInvocation.current = priorConductorInvocation;
            runtimeInvocationCarriesConductorDecision = true;
          } else {
            conductorInvocation.current = await composition
              .reserveSharedAgentRuntimeInvocation?.({
                operationIds: coveredSharedAgentOperationIds,
                roomId: detail.id,
                subjectHumanId: sessionActorId,
                clientActionSessionId: args.clientActionSessionId!,
                purpose: "agent",
                now: Date.now(),
              }) ?? null;
          }
        }
        if (conductorInvocation.current !== null) {
          const capability = await authorizeRuntimeInvocationForForeground({
            composition,
            invocation: conductorInvocation.current,
            operationIds: coveredSharedAgentOperationIds,
            userId: sessionUserId,
            humanActorId: sessionActorId,
          });
          if (capability !== null) {
            capability.authorizationDigest.fill(0);
            capability.scope.domainAuthoritySetDigest.fill(0);
            protectedDecision = Object.freeze({
              kind: "wake" as const,
              botActorIds: [uiSelectedBotActorId],
              source: "ui" as const,
              writeFocus: true,
              reason: "ui",
            });
            protectedAgentInvocationReady = true;
          } else {
            protectedConductorFellBack = true;
            protectedDecision = await rejectProtectedConductor("authority_unavailable");
          }
        } else {
          protectedConductorFellBack = true;
          protectedDecision = await rejectProtectedConductor("authority_unavailable");
        }
      } else if (
        completeProtectedInputSet
        && coveredSharedAgentOperationIds.length > 0
        && args.clientActionSessionId !== undefined
        && composition !== null
      ) {
        protectedConductorAttempted = true;
        conductorInvocation.current = await composition
          .reserveSharedAgentRuntimeInvocation?.({
            operationIds: coveredSharedAgentOperationIds,
            roomId: detail.id,
            subjectHumanId: sessionActorId,
            clientActionSessionId: args.clientActionSessionId,
            purpose: "conductor",
            now: Date.now(),
          }) ?? null;
        if (conductorInvocation.current !== null) {
          runtimeInvocationCarriesConductorDecision = true;
          if (conductorInvocation.current.conductorAlreadyStarted === true) {
            await resolveSharedAgentConductor(
              "unavailable",
              "protected_conductor_retry_suppressed",
            ).catch(() => undefined);
            eventBus.emit({
              type: "conductor.routing",
              laneKey: `room:${detail.id}`,
              roomId: detail.id,
              userActorId: sessionActorId,
              state: "settled",
            });
            return null;
          }
          const capability = await authorizeRuntimeInvocationForForeground({
            composition,
            invocation: conductorInvocation.current,
            operationIds: coveredSharedAgentOperationIds,
            userId: sessionUserId,
            humanActorId: sessionActorId,
          });
          if (capability !== null) {
            let protectedRouting: import("@nautilo/lattice-bridge/server")
              .LiveShadowAgentTurnExecutionResult<ConductorDecision>
              | undefined;
            try {
              protectedRouting = await composition
                .runRuntimeInvocationConductor?.({
                  invocationId: conductorInvocation.current.invocationId,
                  operationIds: coveredSharedAgentOperationIds,
                  roomId: detail.id,
                  userId: sessionUserId,
                  actorId: sessionActorId,
                  clientActionSessionId:
                    conductorInvocation.current.clientActionSessionId,
                  capability,
                  ...(full ? { representationMode: "full_encryption" as const }
                    : { expectedMergedHumanContent: content! }),
                  work: (openedContent, openHistory) => {
                    transientRoutingContent = openedContent;
                    return routeWithContent(openedContent, true,
                      searchHistoryFlag && full ? undefined : openHistory);
                  },
                });
            } finally {
              capability.authorizationDigest.fill(0);
              capability.scope.domainAuthoritySetDigest.fill(0);
            }
            if (protectedRouting?.status === "executed") {
              protectedDecision = protectedRouting.value;
              protectedConductorSucceeded = true;
              protectedAgentInvocationReady = true;
              await strictShadowBoundaryEnforcer(chatDeps)({
                boundaryId: "conversation.search.conductor",
                state: "verified",
                reason: "none",
                retryable: false,
              });
            } else if (protectedRouting?.reason === "retry_suppressed") {
              await resolveSharedAgentConductor(
                "unavailable",
                "protected_conductor_retry_suppressed",
              ).catch(() => undefined);
              eventBus.emit({
                type: "conductor.routing",
                laneKey: `room:${detail.id}`,
                roomId: detail.id,
                userActorId: sessionActorId,
                state: "settled",
              });
              return null;
            } else {
              protectedConductorFellBack = true;
              protectedDecision = await rejectProtectedConductor("protected_failed");
            }
          } else {
            protectedConductorFellBack = true;
            await composition.recordRuntimeInvocationConductorFallback?.({
              invocationId: conductorInvocation.current.invocationId,
              roomId: detail.id,
              subjectHumanId: sessionActorId,
              stage: "authorization",
              reason: "unavailable",
              now: Date.now(),
            }).catch(() => undefined);
            protectedDecision = await rejectProtectedConductor("authority_unavailable");
          }
        } else {
          protectedConductorFellBack = true;
          protectedDecision = await rejectProtectedConductor("authority_unavailable");
        }
      } else {
        protectedDecision = await rejectProtectedConductor(composition === null ? "unsupported" : "key_waiting");
      }
          return protectedDecision;
        },
      });
      if (routed === null) return;
      decision = routed;
    } catch (err) {
      log(
        `[conductor] routing failed for room=${detail.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      eventBus.emit({
        type: "conductor.routing",
        laneKey: `room:${detail.id}`,
        roomId: detail.id,
        userActorId: sessionActorId,
        state: "settled",
      });
      // Stack-162 — routing error receipt (requester-private).
      emitConductorDecisionReceipt({
        detail,
        sessionUserId,
        sessionActorId,
        persistedHuman,
        outcome: classifyRoutingError(),
      });
      await resolveSharedAgentConductor("unavailable", "routing_failed")
        .catch((error) => {
          log(
            `[m296] Shared-Agent routing-failure receipt failed room=${detail.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return;
    }

    eventBus.emit({
      type: "conductor.routing",
      laneKey: `room:${detail.id}`,
      roomId: detail.id,
      userActorId: sessionActorId,
      state: "settled",
    });

    const wokenBots =
      decision.kind === "wake"
        ? decision.botActorIds
            .map((actorId) => {
              const m = members.find((mm) => mm.actorId === actorId);
              return m?.agentId ? { actorId, agentId: m.agentId } : null;
            })
            .filter((x): x is { actorId: string; agentId: string } => x !== null)
        : [];

    if (
      protectedConductorSucceeded
      && conductorInvocation.current !== null
      && composition !== null
    ) {
      const recorded = await composition
        .recordRuntimeInvocationConductorOutcome?.({
          invocationId: conductorInvocation.current.invocationId,
          roomId: detail.id,
          subjectHumanId: sessionActorId,
          routePath: protectedRoutePath,
          historyStatus: protectedHistoryStatus,
          outcome: decision.kind === "ask_user"
            ? "ask_user"
            : decision.kind === "wake" && wokenBots.length > 0
              ? "wake"
              : "silent",
          now: Date.now(),
        });
      if (recorded !== "recorded" && recorded !== "replayed") {
        await resolveSharedAgentConductor(
          "unavailable",
          "protected_conductor_outcome_conflict",
        ).catch(() => undefined);
        return;
      }
    }

    if (decision.kind !== "wake" || wokenBots.length === 0) {
      if (decision.kind === "ask_user") {
        eventBus.emit({
          type: "conductor.ask_user",
          laneKey: `room:${detail.id}`,
          roomId: detail.id,
          userId: sessionUserId,
          userActorId: sessionActorId,
          messageId: persistedHuman.messageId != null ? String(persistedHuman.messageId) : null,
          humanTurnId: persistedHuman.humanTurnId,
          options: decision.options,
          reason: decision.reason,
        });
        // Stack-162 — requester-private decision counterpart. Mirrors the
        // picker options without broadening the chooser's delivery audience.
        emitConductorDecisionReceipt({
          detail,
          sessionUserId,
          sessionActorId,
          persistedHuman,
          outcome: classifyConductorDecision(decision),
          options: decision.options,
        });
      } else if (decision.kind === "wake") {
        // Stack-162 — wake decision resolved to zero in-room bots: no one will
        // reply, so the honest user-facing outcome is `silent` (router could
        // not resolve a respondent). The raw wake intent is still logged via
        // `logConductorDecision` below.
        emitConductorDecisionReceipt({
          detail,
          sessionUserId,
          sessionActorId,
          persistedHuman,
          outcome: {
            outcome: "silent",
            reasonCode: "silent_router_unresolved",
            displayReason: "No reply — the router couldn't resolve a respondent.",
          },
        });
      } else {
        // Stack-162 — silent receipt (requester-private).
        emitConductorDecisionReceipt({
          detail,
          sessionUserId,
          sessionActorId,
          persistedHuman,
          outcome: classifyConductorDecision(decision),
        });
      }
      await resolveSharedAgentConductor(
        protectedConductorAttempted && protectedConductorFellBack
          ? "unavailable"
          : decision.kind === "ask_user"
            ? "awaiting_user"
            : "not_selected",
        protectedConductorAttempted && protectedConductorFellBack
          ? "protected_conductor_fallback"
          : decision.kind === "ask_user"
            ? "awaiting_user"
            : decision.kind === "wake"
              ? "selected_agent_unresolved"
              : "agent_not_selected",
      ).catch((error) => {
        log(
          `[m296] Shared-Agent no-wake receipt failed room=${detail.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      logConductorDecision(detail.id, sessionActorId, decision, undefined, routingTrace);
      return;
    }

    if (protectedConductorAttempted && protectedConductorFellBack) {
      await resolveSharedAgentConductor(
        "unavailable",
        "protected_conductor_fallback",
      ).catch(() => undefined);
    }

    if (
      coveredSharedAgentOperationIds.length > 0
      && !completeProtectedInputSet
    ) {
      await resolveSharedAgentConductor(
        "unavailable",
        "protected_input_set_incomplete",
      ).catch((error) => {
        log(
          `[m296] Shared-Agent incomplete-input receipt failed room=${detail.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }

    if (
      completeProtectedInputSet
      && coveredSharedAgentOperationIds.length > 0
      && args.clientActionSessionId === undefined
    ) {
      await resolveSharedAgentConductor(
        "unavailable",
        "client_action_session_unavailable",
      ).catch(() => undefined);
    }

    const roster = await chatDeps.loadRoomRoster(detail.id);

    const sharedAgentAuthorizations = new Map<string, Readonly<{
      executionId: string;
      capability: import("@nautilo/lattice-bridge/server")
        .ForegroundLiveShadowSessionExecutionCapability;
    }>>();
    let attachment: import("@nautilo/lattice-bridge/server")
      .SharedAgentRuntimeInvocationExecutionAttachment | null = null;
    if (
      protectedAgentInvocationReady
      && conductorInvocation.current !== null
      && composition !== null
    ) {
      attachment = await composition
        .attachSharedAgentRuntimeInvocationExecutions?.({
          invocationId: conductorInvocation.current.invocationId,
          operationIds: coveredSharedAgentOperationIds,
          roomId: detail.id,
          subjectUserId: sessionUserId,
          subjectHumanId: sessionActorId,
          agents: wokenBots.map((selected) => Object.freeze({
            agentId: selected.agentId,
            agentThreadId: botThreadId(detail.id, selected.agentId),
            expectedResponseMode: members.find((member) =>
              member.agentId === selected.agentId
            )?.agentResponseMode ?? null,
          })),
          now: Date.now(),
        }) ?? null;
      if (attachment !== null) {
        for (const execution of attachment.executions) {
          const planned = await composition
            .planSharedAgentExecutionAuthorization?.({
              authority: {
                userId: sessionUserId,
                humanActorId: sessionActorId,
              },
              executionId: execution.executionId,
              roomId: conductorInvocation.current.roomId,
              agentId: execution.agentId,
              clientActionSessionId: conductorInvocation.current.clientActionSessionId,
              clientDeviceId: conductorInvocation.current.invokingDeviceId,
              now: Date.now(),
            });
          if (planned?.status === "authorized") {
            planned.planBytes.fill(0);
            sharedAgentAuthorizations.set(execution.agentId, Object.freeze({
              executionId: execution.executionId,
              capability: Object.freeze({
                kind: "foreground_session" as const,
                sessionReference: planned.sessionReference,
                authorizationDigest: planned.authorizationDigest,
                scope: planned.scope,
              }),
            }));
            continue;
          }
          const unavailableReason = planned !== undefined && "reason" in planned
            ? planned.reason
            : planned?.status === "authorization_required"
              ? "unexpected_second_authorization"
              : "agent_authorization_unavailable";
          log(
            `[m298] Runtime authorization unavailable room=${detail.id} agent=${execution.agentId} reason=${unavailableReason}`,
          );
          break;
        }
      }
      if (
        attachment === null
        || sharedAgentAuthorizations.size !== wokenBots.length
      ) {
        if (runtimeInvocationCarriesConductorDecision) {
          await composition.recordRuntimeInvocationConductorFallback?.({
            invocationId: conductorInvocation.current.invocationId,
            roomId: detail.id,
            subjectHumanId: sessionActorId,
            stage: "agent_attachment",
            reason: attachment === null
              ? "execution_reservation_unavailable"
              : "agent_authorization_unavailable",
            now: Date.now(),
          }).catch(() => undefined);
        }
        for (const authorization of sharedAgentAuthorizations.values()) {
          authorization.capability.authorizationDigest.fill(0);
          authorization.capability.scope.domainAuthoritySetDigest.fill(0);
        }
        sharedAgentAuthorizations.clear();
        if (attachment !== null) {
          await Promise.all(attachment.executions.map(async (execution) => {
            await composition.recordSharedAgentExecutionUnavailable?.({
              executionId: execution.executionId,
              reason: "agent_authorization_unavailable",
              now: Date.now(),
            }).catch(() => undefined);
          }));
        } else if (protectedConductorSucceeded) {
          await resolveSharedAgentConductor(
            "unavailable",
            "execution_reservation_unavailable",
          ).catch(() => undefined);
        }
      }
    }

    if (
      wokenBots.length > 0
      && sharedAgentAuthorizations.size !== wokenBots.length
    ) {
      const agentGate = await strictShadowBoundaryEnforcer(chatDeps)({
        boundaryId: "conversation.write.foreground",
        state: "waiting_for_authority",
        reason: "domain_authority_converging",
        retryable: true,
      });
      if (
        agentGate.result.disposition === "withhold"
        || agentGate.result.disposition === "reject"
      ) {
        eventBus.emit({
          type: "conductor.routing",
          laneKey: `room:${detail.id}`,
          roomId: detail.id,
          userActorId: sessionActorId,
          state: "settled",
        });
        return;
      }
    }

    const wokeHandles = wokenBots
      .map((b) => members.find((m) => m.actorId === b.actorId)?.handle ?? b.actorId)
      .map((h) => `@${h}`)
      .join(",");
    logConductorDecision(detail.id, sessionActorId, decision, wokeHandles, routingTrace);

    // Stack-162 — wake receipt (requester-private). Only the selected agents'
    // display handles are exposed (already available via the room roster +
    // `conductor.ask_user` options); never the raw reason or trace.
    const selectedHandles = wokenBots
      .map((b) => members.find((m) => m.actorId === b.actorId)?.handle ?? null)
      .filter((h): h is string => typeof h === "string" && h.length > 0)
      .map((h) => `@${h}`);
    emitConductorDecisionReceipt({
      detail,
      sessionUserId,
      sessionActorId,
      persistedHuman,
      outcome: classifyConductorDecision(decision),
      selectedHandles,
    });

    // D421 Phase 4.3 — server-authored authority: ONLY an inferred
    // single-wake group turn can redirect. Explicit mention/reply/UI,
    // multi-wake, DM, and turns lacking the original D420 acceptance
    // authority fail closed and never register pending context.
    const redirectAllowed = isRedirectAllowedForConductorWake(
      decision,
      wokenBots.length,
      args.acceptanceAuthority,
    );

    for (const bot of wokenBots) {
      const botLaneKey = `room:${detail.id}:user:${sessionActorId}:bot:${bot.agentId}`;
      const sharedAgentAuthorization =
        sharedAgentAuthorizations.get(bot.agentId);

      let envelope;
      try {
        envelope = await buildEnvelopeForRoom(
          sessionActorId,
          botLaneKey,
          bot.agentId,
          detail.id,
        );
      } catch (err) {
        log(
          `[conductor] room=${detail.id} failed to build room envelope for bot=${bot.agentId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      const pendingKey = turnContextKey(persistedHuman.humanTurnId, bot.agentId);
      let resolveSourceWakeReady: ((accepted: boolean) => void) | undefined;
      const sourceWakeReady = new Promise<boolean>((resolve) => {
        resolveSourceWakeReady = resolve;
      });
      if (redirectAllowed && args.acceptanceAuthority) {
        const sourceMember = members.find((m) => m.actorId === bot.actorId);
        const pendingContext: PendingAgentRedirectContext = {
          roomId: detail.id,
          senderActorId: sessionActorId,
          senderUserId: sessionUserId,
          sourceAgentId: bot.agentId,
          sourceAgentActorId: bot.actorId,
          sourceHandle: sourceMember?.handle ?? "",
          persistedMessageId: persistedHuman.messageId ?? null,
          humanTurnId: persistedHuman.humanTurnId,
          acceptanceAuthority: args.acceptanceAuthority,
          invocationAuthority: args.invocationAuthority,
          redirectAllowed: true,
          sourceRedirectDepth: 0,
          sourceWakeReady,
          original: {
            content: transientRoutingContent!,
            voiceMode,
            currentFolder,
            currentFolderRelayId,
            workspacePath,
            activeMiniApp,
            liveMiniAppSession,
            attachmentRefs,
            artifactRefs,
            focusedResources,
            model,
            ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
            ...(detail.kind === "subthread" && detail.parentRoomId
              ? { subthreadParentRoomId: detail.parentRoomId }
              : {}),
            ...(detail.kind === "subthread" &&
            detail.threadRootMessageId != null
              ? { subthreadAnchorMessageId: detail.threadRootMessageId }
              : {}),
            transcriptOwnerId: sessionUserId,
            canonicalMemoryAccessEnvelope: envelope,
          },
          loadLiveMembers: async () => {
            const liveRoster = await chatDeps.loadRoomRoster(detail.id);
            return liveRoster.map((member) => ({
              kind: member.kind,
              actorId: member.actorId,
              ...(member.agentId ? { agentId: member.agentId } : {}),
              handle: member.handle ?? "",
              displayName: member.displayName,
              ...(member.agentResponseMode
                ? { agentResponseMode: member.agentResponseMode }
                : {}),
            }));
          },
          loadActiveSilence: () =>
            loadActiveSilenceForRoom(getSharedDirectDb(), detail.id, new Date()),
          enqueueTarget: async (target, original, continuation) => {
            const targetLane =
              `room:${detail.id}:user:${sessionActorId}:bot:${target.agentId}`;
            const [targetRoster, targetEnvelope] = await Promise.all([
              chatDeps.loadRoomRoster(detail.id),
              buildEnvelopeForRoom(
                sessionActorId,
                targetLane,
                target.agentId,
                detail.id,
              ),
            ]);
            const {
              foregroundTurnCoalescingContext: _discardedRedirectSurface,
              ...redirectArgsWithoutSurface
            } = args;
            const redirectSource: GroupRoomConductorAfterPersistArgs = {
              ...redirectArgsWithoutSurface,
              content: original.content,
              voiceMode: original.voiceMode,
              // Redirects reuse the authenticated foreground turn, so retain
              // its already-validated posture instead of silently resetting
              // the target wake to the legacy default.
              autoApprove: args.autoApprove,
              currentFolder: original.currentFolder,
              currentFolderRelayId: original.currentFolderRelayId,
              workspacePath: original.workspacePath,
              activeMiniApp: original.activeMiniApp,
              liveMiniAppSession: original.liveMiniAppSession,
              attachmentRefs: original.attachmentRefs,
              artifactRefs: original.artifactRefs,
              focusedResources: original.focusedResources,
              model: original.model,
              ...(original.replyToMessageId !== undefined
                ? { replyToMessageId: original.replyToMessageId }
                : {}),
              persistedHuman: {
                ...args.persistedHuman,
                humanTurnId: continuation.humanTurnId,
                messageId: continuation.persistedMessageId,
              },
              acceptanceAuthority: continuation.acceptanceAuthority,
              invocationAuthority: continuation.invocationAuthority,
            };
            await enqueueConductorBotWake({
              source: redirectSource,
              content: original.content,
              bot: target,
              roster: targetRoster,
              envelope: targetEnvelope,
              explicitlySelected: false,
              redirectAllowed: false,
              redirectDepth: 1,
            });
          },
        };
        registerPendingAgentRedirect(pendingKey, pendingContext);
      }

      try {
        await enqueueConductorBotWake({
          source: args,
          content: transientRoutingContent!,
          bot,
          roster,
          envelope,
          explicitlySelected: isExplicitConductorSource(decision.source),
          redirectAllowed,
          ...(sharedAgentAuthorization
            ? { sharedAgentAuthorization }
            : {}),
        });
      } catch (err) {
        if (sharedAgentAuthorization !== undefined) {
          sharedAgentAuthorization.capability.authorizationDigest.fill(0);
          sharedAgentAuthorization.capability.scope.domainAuthoritySetDigest
            .fill(0);
          await getProductionLiveShadowMessageComposition(
            args.request.server,
          )?.recordSharedAgentExecutionUnavailable?.({
            executionId: sharedAgentAuthorization.executionId,
            reason: "agent_enqueue_failed",
            now: Date.now(),
          }).catch(() => undefined);
        }
        clearPendingAgentRedirect(pendingKey);
        resolveSourceWakeReady?.(false);
        log(
          `[conductor] room=${detail.id} async wake failed for bot=${bot.agentId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      try {
        if (decision.kind === "wake" && decision.writeFocus) {
          const focusResult = await openOrExtendFocus(db, {
            roomId: detail.id,
            userActorId: sessionActorId,
            botActorId: bot.actorId,
            source: decision.source,
            reason: decision.reason,
            now: new Date(),
          });
          eventBus.emit({
            type: "conductor.focus_changed",
            laneKey: `room:${detail.id}`,
            roomId: detail.id,
            userActorId: sessionActorId,
            change: focusResult.created ? "opened" : "extended",
            botActorId: bot.actorId,
            source: decision.source,
            reason: decision.reason,
          });
        }
      } finally {
        // Release a completion that raced the source's normal focus write.
        resolveSourceWakeReady?.(true);
      }
    }
}
