/**
 * D174 Phase 11.2 — agent-mediated room send (foreground job) extracted from the
 * legacy `/api/chat` handler. Invoked by `dispatchRoomMessageSend` for rooms with
 * at least one agent member; keeps job input, resolver stamps, and `runWithTurn`
 * wrapping identical to the pre-11.2 `chat.ts` path.
 */
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type {
  ChatAttachmentStatus,
  ActiveMiniAppRequestContext,
  ChatArtifactRef,
  ChatFocusedResourceRef,
  ResolvedFocusedResource,
  TrustedLiveMiniAppSessionContext,
} from "@nautilo/types";
import {
  findLatestUserMessageAt,
  getRelayRegistry,
} from "@nautilo/agent";
import {
  assertCanInvokeAgent,
  envelopeReadableNamespaces,
  envelopeWritableNamespaces,
  loadUserTimezone,
  persistUserTimezoneIfChanged,
  type MemoryAccessEnvelope,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import { log, runWithTurn } from "@nautilo/logger";
import {
  createLiveShadowForegroundTurnCandidate,
  liveShadowConversationExecutionRoute,
  ordinaryConversationExecutionRoute,
  type ForegroundTurnCandidate,
  type LiveShadowTurnContext,
  type MaintenanceAcceptanceAuthority,
} from "@nautilo/runtime";
import type {
  LiveShadowExecutionCapability,
  LiveShadowAgentTurnExecutionResult,
  LiveShadowAgentTurnSession,
} from "@nautilo/lattice-bridge/server";
import type {
  DataOperationPolicyBinding,
  StrictShadowEnforcementPolicy,
} from "@nautilo/lattice-bridge";
import { normalizeChatAttachments, retainedAttachmentIdsFromStatuses } from "./attachments";
import { resolveChatArtifactRefs } from "./artifact-refs";
import { resolveFocusedResources, type FocusedResourceRelayRegistry } from "./focused-resources";
import { validateIanaTimezone } from "../lib/timezone";
import { getClientActionBindingRegistry } from "../realtime/client-action-binding-registry";
import type { ChatRoutesDeps } from "../routes/chat";
import type { VerifiedOrdinaryOrigin } from "@nautilo/types";

/**
 * M125 Phase 2.2 — typed error so the chat / dispatch HTTP callers can
 * surface a structured 4xx instead of bubbling a 500 when the envelope
 * lacks an agent id (which used to silently borrow the bootstrap
 * default and attribute every non-operator turn to the operator's
 * agent).
 */
export class AgentMediatedSendError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(args: { code: string; httpStatus: number; message: string }) {
    super(args.message);
    this.name = "AgentMediatedSendError";
    this.code = args.code;
    this.httpStatus = args.httpStatus;
  }
}

export type AgentMediatedSendResult = {
  /** User transcript row id when synchronously knowable; otherwise `null` (row is created by the async executor). */
  messageId: number | null;
  jobId: string | null;
  accepted: true;
  attachments: ChatAttachmentStatus[];
  coalesced: boolean;
  laneKey: string;
};

/**
 * Runs the M042 agent-mediated send pipeline: roster load, `createForegroundJob`,
 * legacy-shaped job input (including `turnId` / resolver stamps), and attachment
 * normalization inside `runWithTurn`.
 */
export async function executeAgentMediatedRoomMessage(args: {
  request: FastifyRequest;
  deps: ChatRoutesDeps;
  content: string;
  voiceMode: boolean;
  autoApprove?: boolean;
  currentFolder: string | null;
  currentFolderRelayId?: string | null;
  workspacePath: string | null;
  activeMiniApp: ActiveMiniAppRequestContext | null;
  liveMiniAppSession?: TrustedLiveMiniAppSessionContext | null;
  attachmentRefs: string[];
  /** D356 — metadata-only artifact references; resolved against the caller's
   *  readable namespaces inside this function and threaded into the job. */
  artifactRefs: ChatArtifactRef[];
  /**
   * D423 Phase 4 — generic focus refs (workspace artifact / local file).
   * Resolved into a unified `ResolvedFocusedResource[]` manifest inside this
   * function alongside the legacy artifact + attachment lanes, then threaded
   * into the job as `focusedResources`. Local-file refs fail closed this phase.
   */
  focusedResources?: ChatFocusedResourceRef[];
  /** M233 — validated picker-authored Human recipients for the Human row only. */
  mentionedHumanUserIds?: readonly string[];
  /** Structured Room-wide Human mention intent. */
  mentionEveryone?: boolean;
  /** Server-verified provenance for an ordinary request sent by a paired phone. */
  ordinaryOrigin?: VerifiedOrdinaryOrigin;
  replyToMessageId?: number;
  /**
   * D371 R2 — optional per-turn model override. Non-empty string forwarded
   * into the graph job input; the executor (`langgraph-executor.ts`) resolves
   * it via `getModelById(...)` and applies it for THIS turn only. Null/absent
   * = no override (agent profile / system default runs).
   */
  model?: string | null;
  /** Client-supplied lane key when present (same optional spread as legacy `SendMessageRequest`). */
  clientLaneKey?: string;
  canonicalRoomId?: string;
  canonicalAgentId?: string;
  canonicalGraphThreadId?: string;
  canonicalRoomRoster?: Awaited<ReturnType<ChatRoutesDeps["loadRoomRoster"]>>;
  canonicalLaneKey?: string;
  canonicalMemoryAccessEnvelope?: MemoryAccessEnvelope;
  /**
   * D300 follow-up — transcript rows stay attributed to the human sender even
   * when a foreign-owned agent runs the turn with its own owner/memory profile.
   */
  transcriptOwnerId?: string;
  /**
   * M134 — when the Room Conductor wakes multiple bots for ONE inbound user
   * message, every woken bot's job must share this `turnId` so the persisted
   * human-message fingerprint (`humanTurnId`) is identical across the per-bot
   * sessions. `getRoomMessagesAcrossMemberSessions` then collapses the
   * duplicate human rows at read time. Omitted ⇒ a fresh per-call id.
   */
  sharedTurnId?: string;
  /**
   * M305 — exact protected operation consumed by the foreground capability.
   * This is deliberately separate from `sharedTurnId`: shared Agent dispatch
   * has one Human turn id for transcript causality and a distinct per-Agent
   * execution id for protected authorization.
   */
  liveShadowOperationId?: string;
  /** Group conductor carries this process-local context for one accepted Human turn only. */
  foregroundTurnCoalescingContext?: NonNullable<ForegroundTurnCandidate["coalescingContext"]>;
  /**
   * M135 P6 — DM (1 human + 1 agent) server-time prefix (ISO-8601 UTC). Set
   * only on the DM dispatch path; threaded to the human-turn builder.
   */
  serverTimePrefixIso?: string;
  /**
   * D302 P4 — "wake against an already-persisted human message". When true, the
   * human transcript row already exists (optimistic delivery / ask_user
   * pre-persist); the executor injects the message into the graph for the model
   * to answer but skips re-persisting the human row (no duplicate, no
   * dependence on read-time fingerprint collapse).
   */
  humanAlreadyPersisted?: boolean;
  /** M282 opaque, process-local authority for this exact protected turn. */
  liveShadowCapability?: LiveShadowExecutionCapability;
  liveShadowEnforcementPolicy?: StrictShadowEnforcementPolicy;
  liveShadowDataOperationPolicy?: DataOperationPolicyBinding;
  liveShadowObserveBoundary?: LiveShadowTurnContext["observeBoundary"];
  liveShadowRunAgentTurn?<Value>(input: Readonly<{
    operationId: string;
    capability: LiveShadowExecutionCapability;
    entrypointId?: "foreground.main" | "foreground.fork";
    work(
      session: LiveShadowAgentTurnSession,
      openedHumanContent?: string,
      authorizationSignal?: AbortSignal,
    ): Promise<Value>;
  }>): Promise<LiveShadowAgentTurnExecutionResult<Value>>;
  /** M282 — trusted virtual Job identity bound before runtime acceptance. */
  preferredVirtualJobId?: string;
  /**
   * D316 — user explicitly selected this agent from an `ask_user` picker.
   * Threaded into graph state so the turn withholds `skip` and injects
   * steering prompt text.
   */
  explicitlySelected?: boolean;
  /**
   * M168 — subthread anchoring threaded to the executor so it rebuilds history
   * from the parent up-to-anchor window ++ the subthread window. Set only on
   * subthread dispatch paths (`detail.kind === "subthread"`), sourced from
   * `detail.parentRoomId` / `detail.threadRootMessageId`.
   */
  subthreadParentRoomId?: string;
  subthreadAnchorMessageId?: number;
  /** D426 — child Room id forwarded to runtime transcript persistence. */
  subthreadRoomId?: string;
  /**
   * M168 R5 — the just-persisted human row id to EXCLUDE from the rebuilt
   * transcript (group/subthread wakes where `humanAlreadyPersisted`); the
   * message is still re-injected as the live turn message. Omit on the DM main
   * path (it persists its human row after the history is built).
   */
  currentMessageId?: number;
  /** Canonical Humans covered by a coalesced already-persisted wake. */
  memoryReviewSourceMessageIds?: number[];
  /**
   * D420 (Wave 2 task 2.2.1) — acceptance authority carried by conductor-wake
   * continuation paths so the drain gate inside `createForegroundJob` cannot
   * reject a turn whose human row was accepted before drain began. Omitted on
   * the synchronous DM path (the gate re-checks there as a TOCTOU backstop).
   */
  acceptanceAuthority?: MaintenanceAcceptanceAuthority;
  /** M254 — opaque proof of current Human invocation admission. */
  invocationAuthority: AcceptedInvocationAuthority;
  /** D513 — opaque client session from an ordinary direct foreground send. */
  clientActionSessionId?: unknown;
  /**
   * D421 Phase 4.2/4.3 — server-authored redirect eligibility authority.
   * True ONLY for a conductor-inferred single-wake group turn (never for
   * explicit mention/reply/UI picks, never for an explicit multi-wake, never
   * for the DM path). Target-bearing `skip` may record a local request, but
   * server-side completion fails closed unless the server authored this flag.
   * Omitted ⇒ `false` in the executor.
   */
  redirectAllowed?: boolean;
  /**
   * D421 Phase 4.3 — one-hop depth for a redirect target. Forwarded in the
   * job input; the executor seeds the target's distinct per-agent context at
   * execution ingress, before graph/model/tool work.
   */
  redirectDepth?: 1;
  /** Server-validated metadata for the synthetic Human input row only. */
  metadata?: Record<string, unknown>;
}): Promise<AgentMediatedSendResult> {
  const { request, deps, content, voiceMode, activeMiniApp, liveMiniAppSession, attachmentRefs, artifactRefs, focusedResources, model } = args;

  const requestOwnerId = request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
  const memoryOwnerId = args.canonicalMemoryAccessEnvelope?.ownerId ?? requestOwnerId;
  const sessionUserId = request.sessionUserId ?? requestOwnerId;
  const transcriptOwnerId = args.transcriptOwnerId ?? sessionUserId;
  // Local path context is useful only when ordinary admission proved this
  // exact Electron launch. Never turn a same-owner renderer field into host
  // authority; browser and paired-mobile work resolve hosts elsewhere.
  const localElectronOrigin = args.ordinaryOrigin?.kind === "local_electron"
    ? args.ordinaryOrigin
    : null;
  const currentFolderRelayId = localElectronOrigin?.relayId ?? "";
  const currentFolder = localElectronOrigin ? args.currentFolder : null;
  const workspacePath = localElectronOrigin ? args.workspacePath : null;

  // M125 Phase 2.2 — agentId MUST come from the canonical room
  // resolution (`canonicalAgentId`) or the request envelope. Pre-M125
  // a missing envelope agentId fell back to the bootstrap default,
  // which silently dispatched every non-operator turn to the operator's
  // agent. Fail closed and surface as a structured 4xx.
  const agentId =
    args.canonicalAgentId ?? request.memoryEnvelope?.agentId ?? "";
  if (!agentId) {
    throw new AgentMediatedSendError({
      code: "no_agent_in_context",
      httpStatus: 400,
      message: "chat dispatch requires an authenticated agent context",
    });
  }

  const ctxLaneKey = request.policyContext?.laneKey;
  const laneKey = args.canonicalLaneKey ?? ctxLaneKey ?? args.clientLaneKey ?? "app:default";

  const roomId = args.canonicalRoomId ?? request.memoryEnvelope?.roomId ?? "";
  await (args.deps.assertInvocation ?? assertCanInvokeAgent)({
    humanUserId: sessionUserId,
    origin: "room_message",
    agentId,
    ...(roomId ? { roomId } : {}),
  });

  const graphThreadId =
    args.canonicalGraphThreadId ?? request.policyContext?.graphThreadId ?? laneKey;

  const roomRoster =
    args.canonicalRoomRoster ?? (roomId ? await deps.loadRoomRoster(roomId) : []);

  // M087 — resolve the user's IANA timezone for this turn. The validated
  // request value is persisted on drift (fire-and-forget; never blocks the
  // turn), then the resolved value is `request ?? stored ?? "UTC"`.
  const requestedTz = validateIanaTimezone(
    (request.body as { userTimezone?: unknown } | undefined)?.userTimezone,
  );
  if (requestedTz && memoryOwnerId) {
    void persistUserTimezoneIfChanged(memoryOwnerId, requestedTz).catch((err) => {
      log(`[chat] timezone persist failed (turn proceeds): ${err}`);
    });
  }
  const resolvedTz =
    requestedTz ??
    (memoryOwnerId ? await loadUserTimezone(memoryOwnerId).catch(() => null) : null) ??
    "UTC";

  // M087 — timestamp of the previous user message in THIS room, resolved
  // before the new turn's message is persisted (the executor persists it
  // later). On any lookup failure we pass `null` (the prompt renders the
  // "first message" fallback); never block the turn.
  const previousUserMessageAt =
    roomId && memoryOwnerId
      ? await findLatestUserMessageAt({ ownerId: memoryOwnerId, roomId }).catch(() => null)
      : null;

  const turnId = args.sharedTurnId ?? randomUUID();

  const body = await runWithTurn(turnId, async () => {
    const attachmentEnv = args.canonicalMemoryAccessEnvelope ?? request.memoryEnvelope;
    const normalizedAttachments =
      attachmentRefs.length > 0
        ? await normalizeChatAttachments({
            attachmentIds: attachmentRefs,
            uploaderActorId: request.sessionActorId ?? "",
            writableNamespaceId: attachmentEnv ? (envelopeWritableNamespaces(attachmentEnv)[0] ?? null) : null,
            readableNamespaceIds: attachmentEnv ? envelopeReadableNamespaces(attachmentEnv) : [],
          })
        : { textBlocks: [], mediaParts: [], statuses: [] as ChatAttachmentStatus[] };

    // D356 — resolve in-focus artifact refs against the caller's readable
    // namespaces (advisory: unresolved refs are dropped, never block the turn).
    const resolvedArtifactRefs =
      artifactRefs.length > 0
        ? await resolveChatArtifactRefs({
            refs: artifactRefs,
            readableNamespaceIds: attachmentEnv ? envelopeReadableNamespaces(attachmentEnv) : [],
          })
        : [];

    // D423 — normalize legacy artifact refs, new generic focus refs, and
    // authorized D271 attachments into ONE authoritative manifest. The manifest
    // carries private locators (never prompt-prose); pre-model renders a single
    // `## Focused resources` block from it. Local-file refs are validated
    // against the connected-relay registry (sender ownership + protocol v4 +
    // `profile:"desktop-agent"` + `localFileExecution:true`); on any failure
    // the ref is dropped — no read, no upload, no fallback device switch
    // (matches currentFolder D304 advisory posture: a resolver failure never
    // blocks the turn).
    const focusedResourceRefs = (focusedResources ?? []).filter(
      (ref) =>
        ref.kind !== "local-file" ||
        (localElectronOrigin !== null && ref.relayId === localElectronOrigin.relayId),
    );
    const readableNamespaceIds = attachmentEnv ? envelopeReadableNamespaces(attachmentEnv) : [];
    // D423 4.1.3 — the connected-relay registry set at server startup. The
    // runtime instance is an `InMemoryRelayRegistry` whose
    // `snapshotForFocusedResource` structurally satisfies our narrow port.
    const relayRegistry = getRelayRegistry() as unknown as
      | FocusedResourceRelayRegistry
      | null;
    const resolvedFocusedResources: ResolvedFocusedResource[] =
      focusedResourceRefs.length > 0 ||
      resolvedArtifactRefs.length > 0 ||
      normalizedAttachments.statuses.length > 0
        ? await resolveFocusedResources({
            focusedResourceRefs,
            resolvedArtifactRefs,
            attachmentStatuses: normalizedAttachments.statuses,
            readableNamespaceIds,
            senderActorId: sessionUserId,
            currentFolder,
            relayRegistry,
          }).catch((err) => {
            log(
              `[chat] focused-resource resolution failed (turn proceeds without manifest): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            return [] as ResolvedFocusedResource[];
          })
        : [];

    const cfTrace = currentFolder
      ? ` currentFolder=${currentFolder.length > 80 ? currentFolder.slice(0, 77) + "..." : currentFolder}`
      : "";
    const wpTrace = workspacePath
      ? ` workspacePath=${workspacePath.length > 80 ? workspacePath.slice(0, 77) + "..." : workspacePath}`
      : "";
    const attTrace =
      normalizedAttachments.statuses.length > 0
        ? ` attachments=${normalizedAttachments.statuses.map((s) => `${s.id}:${s.decision}`).join(",")}`
        : "";
    log(
      `[chat] received message from user ${sessionUserId} (laneKey=${laneKey})${cfTrace}${wpTrace}${attTrace}`,
    );

    // D391 — retained image/audio attachment ids for this turn; the executor
    // stamps `turn_id` on them once the human row is persisted so they render
    // from room history (this is the agent-mediated path the 3 synchronous
    // dispatch-side stamp sites don't cover).
    const retainedAttachmentIds = retainedAttachmentIdsFromStatuses(
      normalizedAttachments.statuses,
    );

    // D513 Phase 3.2 — reserve only after direct request validation and all
    // expensive admission preparation above. The opaque candidate is held by
    // JobManager before enqueue and never enters its input/DB/transcript.
    const bindingRegistry = args.sharedTurnId || args.foregroundTurnCoalescingContext
      ? null
      : getClientActionBindingRegistry();
    const bindingHandle = bindingRegistry?.reserve({
      clientActionSessionId: args.clientActionSessionId,
      actorId: request.sessionActorId ?? "",
    }) ?? null;
    const ordinaryForegroundTurnCandidate = args.foregroundTurnCoalescingContext
      ? {
        onMainTurn: () => {},
        onIneligible: () => {},
        coalescingContext: args.foregroundTurnCoalescingContext,
      }
      : bindingHandle
        ? bindingRegistry!.createForegroundTurnCandidate(bindingHandle)
        : undefined;
    if (
      args.liveShadowCapability !== undefined
      && args.liveShadowDataOperationPolicy === undefined
    ) {
      throw new Error("Protected foreground Runtime requires a live policy binding");
    }
    const foregroundTurnCandidate = args.liveShadowCapability
      ? createLiveShadowForegroundTurnCandidate({
          operationId: args.liveShadowOperationId ?? turnId,
          turnId,
          capability: args.liveShadowCapability,
          dataOperationPolicy: args.liveShadowDataOperationPolicy!,
          enforcementPolicy: args.liveShadowEnforcementPolicy ?? {
            mode: "shadow_encryption",
            shadowBehavior: "fallback",
            revision: 0,
          },
          ...(args.liveShadowObserveBoundary === undefined
            ? {}
            : { observeBoundary: args.liveShadowObserveBoundary }),
          ...(args.liveShadowRunAgentTurn === undefined
            ? {}
            : {
              runAgentTurn: (input) => args.liveShadowRunAgentTurn!(input),
            }),
        })
      : ordinaryForegroundTurnCandidate;

    let job;
    try {
      job = await deps.createForegroundJob(memoryOwnerId, sessionUserId, laneKey, {
      message: content.trim(),
      attachmentTextBlocks: normalizedAttachments.textBlocks,
      multimodalImages: normalizedAttachments.mediaParts,
      ...(retainedAttachmentIds.length > 0 ? { retainedAttachmentIds } : {}),
      ownerId: memoryOwnerId,
      requestorId: sessionUserId,
      causalHumanUserId: sessionUserId,
      transcriptOwnerId,
      agentId,
      roomId,
      roomRoster,
      explicitlySelected: args.explicitlySelected ?? false,
      ...(args.ordinaryOrigin ? { verifiedOrdinaryOrigin: args.ordinaryOrigin } : {}),
      // M168 — subthread anchoring + R5 current-message exclusion for the
      // transcript rebuild in `langgraph-executor.ts`.
      ...(args.subthreadParentRoomId ? { subthreadParentRoomId: args.subthreadParentRoomId } : {}),
      ...(args.subthreadAnchorMessageId != null
        ? { subthreadAnchorMessageId: args.subthreadAnchorMessageId }
        : {}),
      ...(args.subthreadRoomId ? { subthreadRoomId: args.subthreadRoomId } : {}),
      ...(args.currentMessageId != null ? { currentMessageId: args.currentMessageId } : {}),
      ...(args.memoryReviewSourceMessageIds ? { memoryReviewSourceMessageIds: args.memoryReviewSourceMessageIds } : {}),
      ...(args.serverTimePrefixIso ? { serverTimePrefixIso: args.serverTimePrefixIso } : {}),
      graphThreadId,
      threadId: graphThreadId,
      voiceMode,
      autoApprove: args.autoApprove === true,
      // D371 R2 — per-turn model override (non-empty string only). The
      // executor resolves via `getModelById` and applies it for THIS turn.
      ...(model ? { model } : {}),
      memoryAccessEnvelope:
        args.canonicalMemoryAccessEnvelope ?? request.memoryEnvelope ?? undefined,
      actorRole: request.policyContext?.actorRole ?? "guest",
      turnId,
      mentionedHumanUserIds: [...(args.mentionedHumanUserIds ?? [])],
      ...(args.mentionEveryone === true ? { mentionEveryone: true } : {}),
      currentFolder,
      currentFolderRelayId,
      workspacePath,
      // These are ephemeral graph channels. They must be present even when
      // empty: omitting a channel leaves its prior checkpoint value intact,
      // which can make a new mobile focused-resource turn inherit an old
      // Writer document and selection.
      activeMiniApp,
      liveMiniAppSession: liveMiniAppSession ?? null,
      artifactRefs: resolvedArtifactRefs,
      focusedResources: resolvedFocusedResources,
      userTimezone: resolvedTz,
      previousUserMessageAt,
      securityAuditIp: request.ip,
      securityAuditUserAgent:
        typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "",
      ...(args.replyToMessageId !== undefined ? { replyToMessageId: args.replyToMessageId } : {}),
      ...(args.humanAlreadyPersisted ? { humanAlreadyPersisted: true } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
      // D421 Phase 4.2/4.3 — server-authored redirect eligibility. The
      // executor reads `input["redirectAllowed"] === true` and threads it
      // onto graph state; server-side redirect completion fails closed unless
      // this is true. Omitted ⇒ false.
      ...(args.redirectAllowed === true ? { redirectAllowed: true } : {}),
      ...(args.redirectDepth === 1 ? { redirectDepth: 1 as const } : {}),
      },
      // D420 — `executorOverride` (unused here) then `authority`. Conductor-wake
      // continuation passes `acceptanceAuthority` so the drain gate bypasses a
      // turn accepted before drain; the synchronous DM path omits it.
      undefined,
      args.acceptanceAuthority,
      args.liveShadowCapability
        ? liveShadowConversationExecutionRoute()
        : ordinaryConversationExecutionRoute(),
      args.invocationAuthority,
      foregroundTurnCandidate,
      args.preferredVirtualJobId,
      );
    } catch (error) {
      if (bindingHandle) bindingRegistry?.cancel(bindingHandle);
      if (args.liveShadowCapability) {
        try {
          foregroundTurnCandidate?.onIneligible();
        } catch {
          // Capability cleanup is subordinate to the original admission error.
        }
      }
      throw error;
    }

    return {
      messageId: null as number | null,
      jobId: job.virtualJobId,
      accepted: true as const,
      attachments: normalizedAttachments.statuses,
      coalesced: args.liveShadowCapability === undefined,
      laneKey,
    };
  });

  return body;
}
