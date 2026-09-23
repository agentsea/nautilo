/**
 * @deprecated **POST `/api/chat`** — D174 legacy message-creation alias (ISSUE-D174
 * `ISSUE-D174-entity-correct-message-creation-route.md`, Phase 2 / MR3). Prefer
 * **`POST /api/rooms/:roomId/messages`** (canonical entity-correct route). This
 * alias is preserved for **≥ one release** post-merge so older clients and
 * out-of-tree HTTP clients keep working; callsite migration is tracked under
 * D174 Phase 3 (client moves off `roomId`-in-body).
 *
 * **Contract:** translates `{ message, roomId?, … }` → dispatcher `{ content, … }`
 * with `roomId` lifted to the canonical URL param shape via
 * `dispatchRoomMessageSend`. Success responses remain **`SendMessageResponse`**
 * (HTTP **202**, `laneKey` = `room:<uuid>` on the dispatcher path per Phase 11.2).
 *
 * @see `packages/server/src/messaging/dispatch.ts`
 */
import type { FastifyInstance } from "fastify";
import type { SendMessageRequest, SendMessageResponse } from "@nautilo/types";
import {
  jobManager,
  getMaintenanceGate,
  createMaintenanceAcceptanceAuthority,
  type CreateForegroundJobResult,
  type ForegroundExecutionRoute,
  type MaintenanceAcceptanceAuthority,
} from "@nautilo/runtime";
import {
  getPolicyResolver,
  humanPairIsBlocked,
  loadRoomRoster,
  createAcceptedInvocationAuthority,
  AgentInvocationDeniedError,
  assertCanUseServerProviderCredentials,
  ServerProviderCredentialsDeniedError,
  toActionCapabilityHttpDenial,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";
import { and, db, eq, getSharedDirectDb, sessionMessages, sessions } from "@nautilo/db";
import { parseChatAttachmentRefs, validateClientPathSafe } from "../messaging/attachments";
import { parseChatArtifactRefs } from "../messaging/artifact-refs";
import { parseChatFocusedResourceRefs } from "../messaging/focused-resources";
import { sanitizeActiveMiniAppContextSafe } from "../messaging/active-mini-app-context";
import { resolveTrustedLiveMiniAppSession } from "../messaging/live-mini-app-session-context";
import type { ChatArtifactRef, ChatFocusedResourceRef } from "@nautilo/types";
import {
  isMaintenanceDrainError,
  replyMaintenanceRejection,
} from "../lib/maintenance-rejection";
import {
  requireAgentInvocation,
  type AssertCanInvokeAgent,
} from "../lib/agent-invocation-admission";
import {
  currentStrictShadowPolicy,
  enforceRegisteredStrictShadowBoundary,
} from "../lib/strict-shadow-policy";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export async function defaultReplyToMessageInRoom(messageId: number, roomId: string): Promise<boolean> {
  if (!UUID_RE.test(roomId)) return false;
  const rows = await db
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .where(and(eq(sessionMessages.id, messageId), eq(sessions.roomId, roomId)))
    .limit(1);
  return rows.length > 0;
}

// M042D: the ChatRouteDeps interface used to carry `ownerActorId` as a
// policy pass-through into job input. The resolver now derives
// approver actors from the agent's ownership group, so the route no
// longer needs any server-scoped state — the function is deps-less.
export interface ChatRoutesDeps {
  createForegroundJob: (
    ownerId: string,
    requestorId: string,
    laneKey: string,
    input: Record<string, unknown>,
    /**
     * D420 — optional executor override (unused by the chat dispatch path;
     * kept in the signature so the bound runtime `jobManager.createForegroundJob`
     * stays positional-compatible with the authority argument below).
     */
    executorOverride?: import("@nautilo/runtime").JobExecutor,
    /**
     * D420 (Wave 2 task 2.2.1) — carried by conductor-wake continuation paths
     * so the drain gate cannot reject a turn accepted before drain. Omitted by
     * NEW-work sends (the gate rejects before acceptance).
     */
    authority?: MaintenanceAcceptanceAuthority,
    /**
     * D453 — route selected for this accepted turn. It is deliberately last
     * and travels with the virtual turn; it is never stored by graph thread.
     */
    executionRoute?: ForegroundExecutionRoute,
    /** M254 — accepted Human invocation authority; always last. */
    invocationAuthority?: import("@nautilo/trust").AcceptedInvocationAuthority,
    /** D513 — opaque server-private exact-client eligibility callback. */
    foregroundTurnCandidate?: import("@nautilo/runtime").ForegroundTurnCandidate,
    /** M282 — trusted pre-bound virtual Job id; never client-authored. */
    preferredVirtualJobId?: string,
  ) => Promise<CreateForegroundJobResult>;
  loadRoomRoster: typeof loadRoomRoster;
  assertInvocation?: AssertCanInvokeAgent;
  assertServerFunding?: (humanUserId: string, origin?: string) => Promise<void>;
  buildEnvelopeForRoom?: (
    actorId: string,
    laneKey: string,
    agentId: string,
    roomId: string,
  ) => Promise<MemoryAccessEnvelope>;
  /**
   * D124 — validate quote-reply target. Injected in unit tests; default
   * queries `session_messages` joined to `sessions` by `room_id`.
   */
  replyToMessageInRoom?: (messageId: number, roomId: string) => Promise<boolean>;
  /** M297 — injectable exact Human-pair admission seam. */
  humanPairIsBlocked?: (firstUserId: string, secondUserId: string) => Promise<boolean>;
  /** M302 — durable policy read at the exact plaintext-consumer boundary. */
  currentStrictShadowPolicy?: typeof currentStrictShadowPolicy;
  /** M302 — canonical Strict Shadow decision plus bounded health recording. */
  enforceStrictShadowBoundary?: typeof enforceRegisteredStrictShadowBoundary;
}

async function defaultBuildEnvelopeForRoom(
  actorId: string,
  laneKey: string,
  agentId: string,
  roomId: string,
): Promise<MemoryAccessEnvelope> {
  const resolver = getPolicyResolver();
  if (!resolver) {
    throw new Error("Policy resolver unavailable for canonical room envelope");
  }
  return resolver.buildEnvelope(actorId, laneKey, agentId, roomId);
}

export const defaultChatRoutesDeps: ChatRoutesDeps = {
  createForegroundJob: jobManager.createForegroundJob.bind(jobManager),
  loadRoomRoster,
  buildEnvelopeForRoom: defaultBuildEnvelopeForRoom,
  replyToMessageInRoom: defaultReplyToMessageInRoom,
  humanPairIsBlocked: (firstUserId, secondUserId) =>
    humanPairIsBlocked(getSharedDirectDb(), firstUserId, secondUserId),
  currentStrictShadowPolicy,
  enforceStrictShadowBoundary: enforceRegisteredStrictShadowBoundary,
};

export function chatRoutes(
  app: FastifyInstance,
  deps: ChatRoutesDeps = defaultChatRoutesDeps,
) {
  (app as FastifyInstance & { nautiloChatDeps?: ChatRoutesDeps }).nautiloChatDeps = deps;
  app.post<{ Body: SendMessageRequest }>("/api/chat", async (request, reply) => {
    const { message } = request.body;
    const voiceMode = request.body.voiceMode === true;
    // This posture is meaningful only for a bearer-authenticated, verified
    // Human turn. Missing policy context is a legacy/test edge and must remain
    // fail-closed rather than turning a client boolean into approval authority.
    const autoApprove =
      request.body.autoApprove === true &&
      typeof request.sessionUserId === "string" &&
      request.sessionUserId.length > 0 &&
      request.policyContext?.speakerTrust === "verified";
    const memoryOwnerId =
      request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    if (!memoryOwnerId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const requestedRoomId =
      typeof request.body.roomId === "string" ? request.body.roomId.trim() : "";
    if (request.body.roomId !== undefined && !UUID_RE.test(requestedRoomId)) {
      return reply.code(400).send({ error: "roomId must be a valid room id" });
    }

    let currentFolder: string | null = null;
    let currentFolderRelayId: string | null = null;
    let workspacePath: string | null = null;
    let activeMiniApp = null as ReturnType<typeof sanitizeActiveMiniAppContextSafe>;
    const liveMiniAppSession = await resolveTrustedLiveMiniAppSession({
      raw: request.body.liveMiniAppSession,
      userId: memoryOwnerId,
    });
    let attachmentRefs: string[] = [];
    let artifactRefs: ChatArtifactRef[] = [];
    let focusedResources: ChatFocusedResourceRef[] = [];
    // D304 — folder context is advisory; never block a message on it.
    currentFolder = validateClientPathSafe(request.body.currentFolder, "currentFolder");
    currentFolderRelayId = typeof request.body.currentFolderRelayId === "string" &&
      request.body.currentFolderRelayId.length > 0 &&
      request.body.currentFolderRelayId.length <= 256 &&
      !hasControlChars(request.body.currentFolderRelayId)
      ? request.body.currentFolderRelayId
      : null;
    workspacePath = validateClientPathSafe(request.body.workspacePath, "workspacePath");
    activeMiniApp = sanitizeActiveMiniAppContextSafe(request.body.activeMiniApp);
    try {
      attachmentRefs = parseChatAttachmentRefs(request.body.attachments);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
    try {
      artifactRefs = parseChatArtifactRefs(request.body.artifactRefs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
    try {
      focusedResources = parseChatFocusedResourceRefs(request.body.focusedResources);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }

    const roomId = request.memoryEnvelope?.roomId ?? "";
    if (requestedRoomId && roomId !== requestedRoomId) {
      return reply.code(404).send({ error: "Room not found or unavailable" });
    }

    const replyRaw = request.body.replyToMessageId;
    let replyToMessageId: number | undefined;
    if (replyRaw !== undefined && replyRaw !== null) {
      if (typeof replyRaw !== "number" || !Number.isInteger(replyRaw) || replyRaw < 1) {
        return reply.code(400).send({ error: "replyToMessageId must be a positive integer" });
      }
      if (!roomId) {
        return reply.code(400).send({ error: "replyToMessageId requires a room-scoped chat" });
      }
      const inRoom = await (deps.replyToMessageInRoom ?? defaultReplyToMessageInRoom)(
        replyRaw,
        roomId,
      );
      if (!inRoom) {
        return reply.code(400).send({ error: "invalid replyToMessageId" });
      }
      replyToMessageId = replyRaw;
    }

    const envTrim = typeof roomId === "string" ? roomId.trim() : "";
    const dispatchRoomId = requestedRoomId || envTrim;
    if (UUID_RE.test(dispatchRoomId) && request.sessionActorId) {
      const [{ dispatchRoomMessageSend }, { getRoomDetailForMember }] = await Promise.all([
        import("../messaging/dispatch"),
        import("@nautilo/trust"),
      ]);
      return dispatchRoomMessageSend(app, request, reply, {
        roomId: dispatchRoomId,
        body: {
          content: typeof message === "string" ? message : "",
          clientActionSessionId: request.body.clientActionSessionId,
          mentionedHumanUserIds: request.body.mentionedHumanUserIds,
          ...(request.body.mentionEveryone === undefined
            ? {} : { mentionEveryone: request.body.mentionEveryone }),
          ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
          attachments: request.body.attachments,
          artifactRefs: request.body.artifactRefs,
          focusedResources: request.body.focusedResources,
          voiceMode,
          autoApprove,
          currentFolder,
          currentFolderRelayId,
          workspacePath,
          ...(activeMiniApp ? { activeMiniApp } : {}),
          ...(liveMiniAppSession ? { liveMiniAppSession } : {}),
          ...(request.body.laneKey !== undefined ? { laneKey: request.body.laneKey } : {}),
        },
        getRoomDetailForMember,
        chatDeps: deps,
        ...(deps.assertInvocation ? { assertCanInvokeAgent: deps.assertInvocation } : {}),
        ...(deps.assertServerFunding ? { assertCanUseServerProviderCredentials: deps.assertServerFunding } : {}),
        aliasHttpContract: true,
        ...(deps.humanPairIsBlocked
          ? { humanPairIsBlocked: deps.humanPairIsBlocked }
          : {}),
      });
    }

    const content = typeof message === "string" ? message : "";
    const humanUserId = request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    if (
      !(await requireAgentInvocation(
        { humanUserId, origin: "room_message", ...(envTrim ? { roomId: envTrim } : {}) },
        reply,
        deps.assertInvocation,
      ))
    ) {
      return;
    }
    try {
      await (deps.assertServerFunding ?? assertCanUseServerProviderCredentials)(humanUserId, "room_message");
    } catch (error) {
      if (!(error instanceof ServerProviderCredentialsDeniedError)) throw error;
      return reply.code(403).send(toActionCapabilityHttpDenial(error));
    }
    let maintenanceAuthority: MaintenanceAcceptanceAuthority;
    try {
      await getMaintenanceGate().assertAcceptingNewWork();
      maintenanceAuthority = createMaintenanceAcceptanceAuthority();
    } catch (err) {
      if (isMaintenanceDrainError(err)) return replyMaintenanceRejection(reply, err);
      throw err;
    }
    const invocationAuthority = createAcceptedInvocationAuthority(humanUserId);
    const { executeAgentMediatedRoomMessage, AgentMediatedSendError } = await import(
      "../messaging/agent-mediated"
    );
    let canon;
    try {
      canon = await executeAgentMediatedRoomMessage({
        request,
        deps,
        content,
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
        ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
        ...(request.body.laneKey !== undefined ? { clientLaneKey: request.body.laneKey } : {}),
        acceptanceAuthority: maintenanceAuthority,
        invocationAuthority,
        clientActionSessionId: request.body.clientActionSessionId,
      });
    } catch (err) {
      if (err instanceof AgentInvocationDeniedError) {
        return reply.code(403).send(toActionCapabilityHttpDenial(err));
      }
      if (err instanceof AgentMediatedSendError) {
        return reply
          .code(err.httpStatus)
          .send({ error: err.code, code: err.code, message: err.message });
      }
      // D420 — render the typed retryable maintenance rejection (the drain gate
      // inside `createForegroundJob` threw before acceptance/202).
      if (isMaintenanceDrainError(err)) {
        return replyMaintenanceRejection(reply, err);
      }
      throw err;
    }
    const legacy: SendMessageResponse = {
      jobId: canon.jobId,
      laneKey: canon.laneKey,
      accepted: true,
      attachments: canon.attachments,
      coalesced: canon.coalesced,
    };
    return reply.status(202).send(legacy);
  });
}
